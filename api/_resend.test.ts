import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendLeakAlert } from './_resend.js';

const originalEnv = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  LEAK_ALERT_FROM: process.env.LEAK_ALERT_FROM,
  LEAK_ALERT_TO: process.env.LEAK_ALERT_TO,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('sendLeakAlert', () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.LEAK_ALERT_FROM = 'alerts@send.tusharjayanti.io';
    process.env.LEAK_ALERT_TO = 'tj@tusharjayanti.io';
  });

  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
  });

  it('POSTs the alert payload with the expected shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await sendLeakAlert({
      ts: 1700000000000,
      leakedCanary: 'cnry_leaked',
      currentCanary: 'cnry_current',
      ipHash: 'abcdef0123456789ff',
      userAgent: 'curl/8.4',
      geoCountry: 'IN',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body);
    expect(body.from).toBe('alerts@send.tusharjayanti.io');
    expect(body.to).toEqual(['tj@tusharjayanti.io']);
    expect(body.subject).toBe(
      '[tusharjayanti.io] Canary leak detected — still active',
    );
    expect(body.text).toContain('cnry_leaked');
    expect(body.text).toContain('cnry_current');
    expect(body.text).toContain('Country: IN');
  });

  it('renders Country: unknown when geoCountry is null', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await sendLeakAlert({
      ts: 1700000000000,
      leakedCanary: 'cnry_x',
      currentCanary: 'cnry_x',
      ipHash: 'h',
      userAgent: 'ua',
      geoCountry: null,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain('Country: unknown');
  });

  it('skips fetch and logs a warning when LEAK_ALERT_FROM is unset', async () => {
    delete process.env.LEAK_ALERT_FROM;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendLeakAlert({
      ts: 1,
      leakedCanary: 'a',
      currentCanary: 'a',
      ipHash: 'h',
      userAgent: 'ua',
      geoCountry: null,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('LEAK_ALERT_FROM'),
    );
    warn.mockRestore();
  });

  it('throws when Resend returns non-ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });
    vi.stubGlobal('fetch', fetchMock);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      sendLeakAlert({
        ts: 1,
        leakedCanary: 'a',
        currentCanary: 'a',
        ipHash: 'h',
        userAgent: 'ua',
        geoCountry: null,
      }),
    ).rejects.toThrow(/500/);
    err.mockRestore();
  });
});
