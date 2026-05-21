// Web fetcher for the `fetch_url` chat tool. Given a URL, returns the
// page content as markdown (via node-html-markdown) so Sonnet can
// reason about external pages a user pastes into the chat.
//
// Safety rails:
// - Only http(s); other schemes return an error string.
// - SSRF blocklist on localhost + private IPv4 ranges. Final URL after
//   redirects is re-checked (mitigates redirect-based SSRF).
// - Content-type filter — only text/html and application/xhtml+xml.
// - Raw-bytes cap at 5MB; markdown cap at 600KB (~150K tokens) so
//   we leave room for system prompt + retrieved chunks within
//   Sonnet's 200K context.
// - 8s timeout via AbortController.
//
// Failure modes return `{ error: string }` rather than throwing —
// Sonnet sees the error as tool_result content and can surface it
// to the user. Edge-runtime compatible (no Buffer / node:*).

import { NodeHtmlMarkdown } from 'node-html-markdown';

export const FETCH_TIMEOUT_MS = 8000;
export const RAW_BYTE_CAP = 5 * 1024 * 1024;
export const MARKDOWN_CHAR_CAP = 600 * 1024;
export const USER_AGENT = 'tusharjayanti.io-chat/1.0';
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];

export type FetchResult =
  | {
      content: string;
      truncated: 'none' | 'raw' | 'markdown';
      sourceUrl: string;
    }
  | { error: string };

// IPv4 SSRF blocklist: localhost, RFC1918, link-local, loopback. Plus
// the all-zeroes block and IPv6 loopback. Not a complete IPv6 picture,
// but the threat model on Vercel Edge doesn't need it — we'd need a
// public attacker URL that redirects to a private IP reachable from
// the function's runtime, and IPv6 private addressing in that context
// is exotic enough to defer.
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '[::1]') return true;
  // Match raw IPv4
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = m.slice(1, 3).map((n) => Number.parseInt(n, 10));
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

export async function fetchUrl(rawUrl: string): Promise<FetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return {
      error: `Invalid URL: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'URL not allowed for security reasons' };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { error: 'URL not allowed for security reasons' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html, application/xhtml+xml',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      return { error: 'URL took too long to load (8s exceeded)' };
    }
    return {
      error: `URL not accessible (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  clearTimeout(timer);

  // Re-check the final URL after redirects (mitigates redirect-based
  // SSRF). `response.url` is the post-redirect URL.
  try {
    const finalHost = new URL(response.url).hostname;
    if (isBlockedHost(finalHost)) {
      return { error: 'URL not allowed for security reasons' };
    }
  } catch {
    // If response.url isn't parseable, fall through and let the
    // status / content-type checks below decide.
  }

  if (!response.ok) {
    return { error: `URL not accessible (HTTP ${response.status})` };
  }

  const contentType = response.headers.get('content-type') ?? '';
  const ctype = contentType.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.includes(ctype)) {
    return {
      error: `Content type not supported (${ctype || 'unknown'}) — only HTML pages are fetched.`,
    };
  }

  // Stream the body so we can early-exit at the raw cap instead of
  // buffering the whole response. ReadableStream is available on both
  // Edge runtime and Node 22+.
  if (!response.body) {
    return { error: 'URL not accessible (no response body)' };
  }
  const reader = response.body.getReader();
  const pieces: Uint8Array[] = [];
  let totalBytes = 0;
  let rawTruncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (totalBytes + value.length > RAW_BYTE_CAP) {
      const room = Math.max(0, RAW_BYTE_CAP - totalBytes);
      if (room > 0) pieces.push(value.slice(0, room));
      totalBytes += room;
      rawTruncated = true;
      await reader.cancel();
      break;
    }
    pieces.push(value);
    totalBytes += value.length;
  }

  // Concatenate Uint8Arrays then decode UTF-8 — Edge-safe, no Buffer.
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const p of pieces) {
    merged.set(p, offset);
    offset += p.length;
  }
  const rawHtml = new TextDecoder('utf-8', { fatal: false }).decode(merged);

  let markdown: string;
  try {
    markdown = NodeHtmlMarkdown.translate(rawHtml);
  } catch (err) {
    return {
      error: `Failed to parse HTML (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  let truncated: 'none' | 'raw' | 'markdown' = 'none';
  if (markdown.length > MARKDOWN_CHAR_CAP) {
    markdown =
      markdown.slice(0, MARKDOWN_CHAR_CAP) +
      '\n\n[Page content was very long; first ~150K tokens shown.]';
    truncated = 'markdown';
  } else if (rawTruncated) {
    markdown += '\n\n[Page exceeded 5MB; first 5MB shown.]';
    truncated = 'raw';
  }

  return {
    content: markdown,
    truncated,
    sourceUrl: response.url || parsed.toString(),
  };
}
