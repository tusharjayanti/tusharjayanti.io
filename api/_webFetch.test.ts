// Unit tests for the fetch_url backing implementation. All network
// access is mocked via vi.stubGlobal('fetch', ...) — no live URLs.
// node-html-markdown runs for real (pure JS, no I/O) so we get
// genuine HTML→markdown conversion in the assertions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchUrl,
  FETCH_TIMEOUT_MS,
  RAW_BYTE_CAP,
  MARKDOWN_CHAR_CAP,
} from './_webFetch.js';

function htmlResponse(
  body: string,
  opts: {
    status?: number;
    contentType?: string;
    url?: string;
  } = {},
): Response {
  const headers = new Headers({
    'content-type': opts.contentType ?? 'text/html; charset=utf-8',
  });
  const status = opts.status ?? 200;
  const init: ResponseInit = { status, headers };
  // Construct a Response. The url property is read-only on real
  // Response objects but Object.defineProperty lets us simulate the
  // final-URL field that fetch() populates after redirects.
  const res = new Response(body, init);
  if (opts.url !== undefined) {
    Object.defineProperty(res, 'url', { value: opts.url });
  }
  return res;
}

describe('fetchUrl', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('happy path', () => {
    it('fetches a small HTML page and returns markdown content', async () => {
      const html = '<html><body><h1>Hello</h1><p>World</p></body></html>';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          htmlResponse(html, { url: 'https://example.com/' }),
        ),
      );

      const result = await fetchUrl('https://example.com/');
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.truncated).toBe('none');
      expect(result.sourceUrl).toBe('https://example.com/');
      expect(result.content).toContain('Hello');
      expect(result.content).toContain('World');
    });

    it('sends the configured User-Agent and Accept headers', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        htmlResponse('<html><body>ok</body></html>', {
          url: 'https://example.com/',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await fetchUrl('https://example.com/');
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['User-Agent']).toMatch(/tusharjayanti\.io-chat/);
      expect(headers.Accept).toContain('text/html');
    });
  });

  describe('SSRF blocklist', () => {
    it('rejects localhost', async () => {
      const result = await fetchUrl('http://localhost/');
      expect(result).toEqual({
        error: 'URL not allowed for security reasons',
      });
    });

    it('rejects 127.0.0.1', async () => {
      const result = await fetchUrl('http://127.0.0.1/');
      expect(result).toEqual({
        error: 'URL not allowed for security reasons',
      });
    });

    it('rejects 10.x.x.x', async () => {
      const result = await fetchUrl('http://10.0.0.5/');
      expect(result).toEqual({
        error: 'URL not allowed for security reasons',
      });
    });

    it('rejects 192.168.x.x', async () => {
      const result = await fetchUrl('http://192.168.1.1/');
      expect(result).toEqual({
        error: 'URL not allowed for security reasons',
      });
    });

    it('rejects 169.254.x.x (link-local)', async () => {
      const result = await fetchUrl('http://169.254.169.254/');
      expect(result).toEqual({
        error: 'URL not allowed for security reasons',
      });
    });

    it('rejects 172.16-31.x.x', async () => {
      const result = await fetchUrl('http://172.20.5.5/');
      expect(result).toEqual({
        error: 'URL not allowed for security reasons',
      });
    });

    it('allows public 172.x.x.x outside the RFC1918 sub-range', async () => {
      // 172.40.x.x is NOT in 172.16.0.0/12. Should pass the SSRF
      // gate (we'll hit the fetch mock).
      const fetchMock = vi.fn().mockResolvedValue(
        htmlResponse('<html><body>public</body></html>', {
          url: 'http://172.40.1.1/',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const result = await fetchUrl('http://172.40.1.1/');
      expect('error' in result).toBe(false);
    });

    it('rejects after a redirect lands on a private IP', async () => {
      // Simulate a public URL that redirects to a private IP. fetch()
      // returns the final response object whose `url` is the
      // post-redirect URL.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          htmlResponse('<html><body>redirected</body></html>', {
            url: 'http://10.0.0.5/secret',
          }),
        ),
      );
      const result = await fetchUrl('https://attacker.example/');
      expect(result).toEqual({
        error: 'URL not allowed for security reasons',
      });
    });
  });

  describe('scheme + URL validation', () => {
    it('rejects non-http(s) schemes', async () => {
      const ftp = await fetchUrl('ftp://example.com/file');
      expect(ftp).toEqual({
        error: 'URL not allowed for security reasons',
      });
      const js = await fetchUrl('javascript:alert(1)');
      expect(js).toEqual({
        error: 'URL not allowed for security reasons',
      });
    });

    it('rejects malformed URLs with a descriptive message', async () => {
      const result = await fetchUrl('not a url');
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toMatch(/^Invalid URL:/);
      }
    });
  });

  describe('HTTP status + content-type', () => {
    it('returns an error string for 4xx responses', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          htmlResponse('not found', { status: 404, url: 'https://example.com/' }),
        ),
      );
      const result = await fetchUrl('https://example.com/');
      expect(result).toEqual({ error: 'URL not accessible (HTTP 404)' });
    });

    it('returns an error string for 5xx responses', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          htmlResponse('boom', { status: 503, url: 'https://example.com/' }),
        ),
      );
      const result = await fetchUrl('https://example.com/');
      expect(result).toEqual({ error: 'URL not accessible (HTTP 503)' });
    });

    it('rejects non-HTML content types', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          htmlResponse('{}', {
            contentType: 'application/json',
            url: 'https://example.com/api',
          }),
        ),
      );
      const result = await fetchUrl('https://example.com/api');
      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toMatch(/Content type not supported/);
      }
    });

    it('accepts application/xhtml+xml', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          htmlResponse('<html><body>xml</body></html>', {
            contentType: 'application/xhtml+xml',
            url: 'https://example.com/',
          }),
        ),
      );
      const result = await fetchUrl('https://example.com/');
      expect('error' in result).toBe(false);
    });
  });

  describe('timeout', () => {
    it('returns the 8s-timeout error when fetch is aborted', async () => {
      // fetch() throws an AbortError when the controller aborts.
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(abortError),
      );
      const result = await fetchUrl('https://example.com/');
      expect(result).toEqual({
        error: 'URL took too long to load (8s exceeded)',
      });
    });

    it('passes an AbortSignal to fetch', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        htmlResponse('<html><body>ok</body></html>', {
          url: 'https://example.com/',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await fetchUrl('https://example.com/');
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('size caps', () => {
    it('truncates and tags markdown when raw bytes exceed RAW_BYTE_CAP', async () => {
      // Body whose ReadableStream yields more bytes than the cap.
      // We synthesize a stream that emits a 6MB-ish blob in one chunk
      // so the cap-handling slices it.
      const oversized = '<html><body>' + 'x'.repeat(RAW_BYTE_CAP + 1024) + '</body></html>';
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      });
      const res = new Response(stream, {
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
      });
      Object.defineProperty(res, 'url', { value: 'https://example.com/big' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

      const result = await fetchUrl('https://example.com/big');
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      // The raw cap triggers ONLY IF the markdown is still under
      // MARKDOWN_CHAR_CAP after conversion. A 5MB body of `x` chars
      // converts to ~5MB of markdown, which then trips the markdown
      // cap. So we accept either truncation tag — both indicate the
      // cap path fired.
      expect(['raw', 'markdown']).toContain(result.truncated);
      expect(result.content).toMatch(/first .* shown\.\]$/);
    });

    it('truncates and tags markdown when conversion exceeds MARKDOWN_CHAR_CAP', async () => {
      // Build an HTML page that converts to >600KB of markdown but
      // <5MB raw. A long string of paragraphs does this — each <p>
      // becomes one paragraph of markdown 1:1.
      const para = '<p>' + 'word '.repeat(150) + '</p>';
      const repeats = Math.ceil(MARKDOWN_CHAR_CAP / (para.length - 7)) + 50;
      const html = '<html><body>' + para.repeat(repeats) + '</body></html>';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          htmlResponse(html, { url: 'https://example.com/' }),
        ),
      );

      const result = await fetchUrl('https://example.com/');
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.truncated).toBe('markdown');
      expect(result.content.length).toBeLessThanOrEqual(MARKDOWN_CHAR_CAP + 200);
      expect(result.content).toMatch(/Page content was very long/);
    });
  });

  it('exports the configured constants for callers', () => {
    expect(FETCH_TIMEOUT_MS).toBe(8000);
    expect(RAW_BYTE_CAP).toBe(5 * 1024 * 1024);
    expect(MARKDOWN_CHAR_CAP).toBe(600 * 1024);
  });
});
