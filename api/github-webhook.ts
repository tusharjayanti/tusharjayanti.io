// POST /api/github-webhook — receives push events from the README
// allowlist and re-ingests any repo whose root README was touched.
// Closes the M2.5 loop: pushing to a README on a tracked repo updates
// the chat's knowledge of that project within seconds.
//
// Runs in the Node runtime so node:crypto's createHmac + timingSafeEqual
// are available; Edge would force a WebCrypto rewrite for no benefit.
//
// Security: GitHub signs every webhook with the shared secret using
// HMAC-SHA256. The `x-hub-signature-256` header carries
// `sha256=<hex>`. We verify with timing-safe comparison and reject
// anything that doesn't match before doing any other work.
//
// Async dispatch: ingest runs via `@vercel/functions` `waitUntil`,
// scheduled AFTER the Response is constructed but BEFORE it's
// returned. Vercel keeps the function alive until the registered
// promise resolves; the client sees an immediate 202 with no
// ingest latency in the response.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

import { ingestReadme } from '../rag/ingest/readme.js';
import { README_REPO_ALLOWLIST } from '../rag/ingest/readme-config.js';

export const config = { runtime: 'nodejs' };

const README_BASENAME = /^readme(\.md|\.markdown)?$/i;

// Vercel's Node-runtime adapter doesn't expose `.text()` on the
// request object — it's IncomingMessage-shaped, not Web Request.
// Calling `req.text()` throws TypeError in production (caught in
// post-deploy logs after sub-spec 3 shipped). Read as a stream
// instead: collect raw chunks into Buffers and decode UTF-8 so we
// recover the exact bytes GitHub signed. The .text() short-circuit
// keeps the Web Request mocks in the unit-test suite working
// without changing the mocked req shape.
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

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  // Read raw body once — we need the exact bytes for HMAC verification.
  const rawBody = await readRawBody(req);
  const signature = req.headers.get('x-hub-signature-256');
  if (!verifySignature(rawBody, signature)) {
    console.warn('[github-webhook] signature verification failed');
    return new Response('invalid signature', { status: 401 });
  }

  // GitHub sends many event types over the same webhook endpoint; we
  // only care about `push`. Everything else is an explicit 200 no-op
  // so GitHub doesn't retry.
  const event = req.headers.get('x-github-event');
  if (event !== 'push') {
    console.log(`[github-webhook] ignoring event=${event}`);
    return new Response('event ignored', { status: 200 });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(rawBody) as PushPayload;
  } catch {
    console.warn('[github-webhook] payload JSON parse failed');
    return new Response('invalid json', { status: 400 });
  }

  const repoSlug = payload.repository?.full_name;
  if (!repoSlug || !README_REPO_ALLOWLIST.includes(repoSlug)) {
    console.log(
      `[github-webhook] skipping, not in allowlist: ${repoSlug ?? '(none)'}`,
    );
    return new Response('not in allowlist', { status: 200 });
  }

  const defaultBranch = payload.repository?.default_branch;
  const expectedRef =
    typeof defaultBranch === 'string' ? `refs/heads/${defaultBranch}` : null;
  if (!expectedRef || payload.ref !== expectedRef) {
    console.log(
      `[github-webhook] skipping, not default branch: ref=${payload.ref} expected=${expectedRef ?? '(unknown)'}`,
    );
    return new Response('not default branch', { status: 200 });
  }

  if (!readmeTouched(payload)) {
    console.log(`[github-webhook] skipping, README not modified: ${repoSlug}`);
    return new Response('README not touched', { status: 200 });
  }

  // Dispatch ingest in the background. `waitUntil` registers the
  // promise with Vercel's runtime so the function stays alive until
  // it resolves — but `return new Response(...)` below ships the 202
  // to GitHub immediately, no blocking.
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

  return new Response('accepted', { status: 202 });
}
