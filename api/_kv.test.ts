import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeRedis = vi.hoisted(() => ({
  lpush: vi.fn(),
  expire: vi.fn(),
  incr: vi.fn(),
  set: vi.fn(),
  lrange: vi.fn(),
  lrem: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: { fromEnv: () => fakeRedis },
}));

const {
  logChatTurn,
  recordLeakEvent,
  getActiveLeaks,
  updateLeakLastAlertedAt,
} = await import('./_kv.js');

describe('logChatTurn — canary_leak field', () => {
  beforeEach(() => {
    fakeRedis.lpush.mockReset();
    fakeRedis.expire.mockReset();
    fakeRedis.lpush.mockResolvedValue(2); // not the first push: skip expire
  });

  it('includes canary_leak: true when the turn is flagged', async () => {
    await logChatTurn({
      ipHash: 'iphash',
      q: 'q',
      aPreview: 'a',
      canary_leak: true,
    });
    const payload = JSON.parse(fakeRedis.lpush.mock.calls[0][1] as string);
    expect(payload.canary_leak).toBe(true);
  });

  it('omits the canary_leak key entirely on clean turns', async () => {
    await logChatTurn({
      ipHash: 'iphash',
      q: 'q',
      aPreview: 'a',
    });
    const payload = JSON.parse(fakeRedis.lpush.mock.calls[0][1] as string);
    expect(payload).not.toHaveProperty('canary_leak');
  });
});

describe('recordLeakEvent', () => {
  beforeEach(() => {
    fakeRedis.lpush.mockReset();
    fakeRedis.lpush.mockResolvedValue(1);
  });

  it('LPUSHes a correctly-shaped JSON entry to leak:events', async () => {
    await recordLeakEvent({
      canary: 'cnry_abc',
      ipHash: 'iphash',
      userAgent: 'curl/8',
      geoCountry: 'IN',
    });
    expect(fakeRedis.lpush).toHaveBeenCalledTimes(1);
    const [key, raw] = fakeRedis.lpush.mock.calls[0];
    expect(key).toBe('leak:events');
    const payload = JSON.parse(raw as string);
    expect(payload.canary).toBe('cnry_abc');
    expect(payload.ipHash).toBe('iphash');
    expect(payload.userAgent).toBe('curl/8');
    expect(payload.geoCountry).toBe('IN');
  });

  it('sets ts and lastAlertedAt to the same value at write time', async () => {
    const before = Date.now();
    const entry = await recordLeakEvent({
      canary: 'cnry_abc',
      ipHash: 'iphash',
      userAgent: 'ua',
      geoCountry: null,
    });
    const after = Date.now();
    expect(entry.ts).toBe(entry.lastAlertedAt);
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(entry.ts).toBeLessThanOrEqual(after);
  });
});

describe('getActiveLeaks', () => {
  beforeEach(() => {
    fakeRedis.lrange.mockReset();
  });

  it('returns only entries whose canary matches current', async () => {
    const active = {
      ts: 1,
      lastAlertedAt: 1,
      canary: 'cnry_active',
      ipHash: 'a',
      userAgent: 'ua',
      geoCountry: null,
    };
    const stale = {
      ts: 2,
      lastAlertedAt: 2,
      canary: 'cnry_stale',
      ipHash: 'b',
      userAgent: 'ua',
      geoCountry: null,
    };
    fakeRedis.lrange.mockResolvedValue([
      JSON.stringify(active),
      JSON.stringify(stale),
    ]);
    const result = await getActiveLeaks('cnry_active');
    expect(result).toEqual([active]);
  });

  it('returns empty array when the list is empty', async () => {
    fakeRedis.lrange.mockResolvedValue([]);
    expect(await getActiveLeaks('cnry_x')).toEqual([]);
  });
});

describe('updateLeakLastAlertedAt', () => {
  beforeEach(() => {
    fakeRedis.lrem.mockReset();
    fakeRedis.lpush.mockReset();
    fakeRedis.lpush.mockResolvedValue(1);
  });

  it('LREMs the old entry then LPUSHes a copy with the new lastAlertedAt', async () => {
    const entry = {
      ts: 1000,
      lastAlertedAt: 1000,
      canary: 'cnry_x',
      ipHash: 'a',
      userAgent: 'ua',
      geoCountry: null,
    };
    await updateLeakLastAlertedAt(entry, 0);
    expect(fakeRedis.lrem).toHaveBeenCalledWith(
      'leak:events',
      1,
      JSON.stringify(entry),
    );
    expect(fakeRedis.lpush).toHaveBeenCalledWith(
      'leak:events',
      JSON.stringify({ ...entry, lastAlertedAt: 0 }),
    );
  });
});
