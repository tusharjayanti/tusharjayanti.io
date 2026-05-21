// POST /api/github-webhook — receives push events from the README
// allowlist and re-ingests any repo whose root README was touched.
// Closes the M2.5 loop: pushing to a README on a tracked repo updates
// the chat's knowledge of that project within seconds.
//
// Runs in the Node serverless runtime so node:crypto's createHmac +
// timingSafeEqual are available natively. The handler uses the
// canonical Vercel Node shape — `(req: VercelRequest, res:
// VercelResponse) => Promise<void>` — instead of the Edge-style
// `(req: Request) => Promise<Response>` it briefly used in sub-spec
// 3. Two production runtime errors (`req.text is not a function`,
// then `req.headers.get is not a function`) revealed the abstraction
// mismatch; the rewrite aligns the handler's API patterns with its
// runtime instead of polyfilling Web APIs piecemeal.
//
// Security: GitHub signs every webhook with the shared secret using
// HMAC-SHA256. The `x-hub-signature-256` header carries
// `sha256=<hex>`. We verify with timing-safe comparison and reject
// anything that doesn't match before doing any other work.
//
// Async dispatch: ingest runs via `@vercel/functions` `waitUntil`.
// Registered AFTER the response is written but BEFORE the handler
// returns; Vercel keeps the function alive until the promise resolves.
// The client sees an immediate 202 with no ingest latency in the
// response.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';

import { ingestReadme } from '../rag/ingest/readme.js';
import { README_REPO_ALLOWLIST } from '../rag/ingest/readme-config.js';

export const config = { runtime: 'nodejs' };

const README_BASENAME = /^readme(\.md|\.markdown)?$/i;

// Stream-collect the raw request body so we have the exact bytes
// GitHub signed. VercelRequest pre-buffers small bodies onto
// `req.body` (parsed JSON), but the HMAC needs the wire bytes — never
// re-serialize a parsed object, the whitespace won't match. The
// `.text()` short-circuit is retained so test mocks can supply the
// body as a string without having to implement async iteration.
async function readRawBody(req: unknown): Promise<string> {
  const maybeText = (req as { text?: () => Promise<string> }).text;
  if (typeof maybeText === 'function') {
    return maybeText.call(req);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Plain-object header lookup. Node lowercases header keys; multi-
// valued headers (Set-Cookie etc.) arrive as arrays. GitHub never
// multi-values signature or event headers but handle both defensively.
function getHeader(req: VercelRequest, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type PushPayload = {
  ref?: string;
  repository?: {
    full_name?: string;
    default_branch?: string;
  };
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
};

function verifySignature(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      '[github-webhook] GITHUB_WEBHOOK_SECRET not set; rejecting all requests',
    );
    return false;
  }
  const expected =
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  // timingSafeEqual throws on length mismatch — wrap so a malformed
  // signature returns false uniformly instead of crashing.
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

// True if any commit in the push added or modified a top-level README
// (case-insensitive). Path is matched literally — a README in a
// subdirectory ("docs/README.md") doesn't count.
function readmeTouched(payload: PushPayload): boolean {
  for (const commit of payload.commits ?? []) {
    const files = [
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
    ];
    for (const file of files) {
      if (README_BASENAME.test(file)) return true;
    }
  }
  return false;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).send('method not allowed');
    return;
  }

  // Read raw body once — we need the exact bytes for HMAC verification.
  const rawBody = await readRawBody(req);
  const signature = getHeader(req, 'x-hub-signature-256');
  if (!verifySignature(rawBody, signature)) {
    console.warn('[github-webhook] signature verification failed');
    res.status(401).send('invalid signature');
    return;
  }

  // GitHub sends many event types over the same webhook endpoint; we
  // only care about `push`. Everything else is an explicit 200 no-op
  // so GitHub doesn't retry.
  const event = getHeader(req, 'x-github-event');
  if (event !== 'push') {
    console.log(`[github-webhook] ignoring event=${event}`);
    res.status(200).send('event ignored');
    return;
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(rawBody) as PushPayload;
  } catch {
    console.warn('[github-webhook] payload JSON parse failed');
    res.status(400).send('invalid json');
    return;
  }

  const repoSlug = payload.repository?.full_name;
  if (!repoSlug || !README_REPO_ALLOWLIST.includes(repoSlug)) {
    console.log(
      `[github-webhook] skipping, not in allowlist: ${repoSlug ?? '(none)'}`,
    );
    res.status(200).send('not in allowlist');
    return;
  }

  const defaultBranch = payload.repository?.default_branch;
  const expectedRef =
    typeof defaultBranch === 'string' ? `refs/heads/${defaultBranch}` : null;
  if (!expectedRef || payload.ref !== expectedRef) {
    console.log(
      `[github-webhook] skipping, not default branch: ref=${payload.ref} expected=${expectedRef ?? '(unknown)'}`,
    );
    res.status(200).send('not default branch');
    return;
  }

  if (!readmeTouched(payload)) {
    console.log(`[github-webhook] skipping, README not modified: ${repoSlug}`);
    res.status(200).send('README not touched');
    return;
  }

  // Dispatch ingest in the background. `waitUntil` registers the
  // promise with Vercel's runtime so the function stays alive until
  // it resolves — but the `res.status(202).send(...)` below ships
  // the response to GitHub immediately, no blocking.
  console.log(`[github-webhook] dispatching ingest for ${repoSlug}`);
  waitUntil(
    ingestReadme(repoSlug)
      .then((result) => {
        console.log(
          `[github-webhook] ingest complete: ${repoSlug} — ${result.total_chunks} chunks, ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged`,
        );
      })
      .catch((err) => {
        console.error(
          `[github-webhook] ingest failed for ${repoSlug}:`,
          err,
        );
      }),
  );

  res.status(202).send('accepted');
}
