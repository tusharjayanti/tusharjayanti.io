import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeRedis = vi.hoisted(() => ({
  lpush: vi.fn(),
  expire: vi.fn(),
  incr: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: { fromEnv: () => fakeRedis },
}));

const { logChatTurn } = await import('./_kv.js');

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
