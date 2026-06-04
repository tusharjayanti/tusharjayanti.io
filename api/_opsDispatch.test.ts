// Path parsing for the consolidated /api/ops dispatcher. The list route
// (['traces']) MUST stay distinct from the detail route (['trace', id]).

import { describe, it, expect } from 'vitest';

const { parseOpsPath } = await import('./ops/[...path].js');

describe('parseOpsPath', () => {
  it('extracts single-segment routes (query string ignored)', () => {
    expect(parseOpsPath('/api/ops/stats')).toEqual(['stats']);
    expect(parseOpsPath('/api/ops/traces?windowDays=7&page=2')).toEqual([
      'traces',
    ]);
    expect(parseOpsPath('http://host/api/ops/system')).toEqual(['system']);
    expect(parseOpsPath('/api/ops/login')).toEqual(['login']);
  });

  it('distinguishes traces (list) from trace/:id (detail)', () => {
    expect(parseOpsPath('/api/ops/traces')).toEqual(['traces']);
    expect(parseOpsPath('/api/ops/trace/abc-123')).toEqual(['trace', 'abc-123']);
  });

  it('decodes segments and drops trailing slashes', () => {
    expect(parseOpsPath('/api/ops/trace/a%2Fb')).toEqual(['trace', 'a/b']);
    expect(parseOpsPath('/api/ops/me/')).toEqual(['me']);
  });

  it('returns [] for a non-ops path', () => {
    expect(parseOpsPath('/api/chat')).toEqual([]);
    expect(parseOpsPath(undefined)).toEqual([]);
  });
});
