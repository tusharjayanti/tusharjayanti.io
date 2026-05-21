// Sub-spec 3: lightweight test that `executeTool('search_readme', ...)`
// dispatches to `match_chunks` with `source_filter='readme'`.
// `search_experience` and `search_resume` are exercised via
// chat.test.ts and the integration suite; this file just nails down
// the new tool's dispatch contract.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('./_voyage.js', () => ({
  embed: mocks.embed,
}));

vi.mock('./_supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: mocks.rpc,
  }),
}));

const { executeTool, isToolName, SEARCH_README, TOOLS } = await import(
  './_tools.js'
);

describe('search_readme tool', () => {
  beforeEach(() => {
    mocks.embed.mockReset();
    mocks.rpc.mockReset();
    mocks.embed.mockResolvedValue([new Array(1024).fill(0.1)]);
    mocks.rpc.mockResolvedValue({
      data: [
        {
          chunk_index: 0,
          content: 'fake readme chunk body',
          metadata: { h2_heading: null, h3_heading: null, token_count: 50 },
          score: 0.0328,
        },
      ],
      error: null,
    });
  });

  it('appears in the exported TOOLS array with the expected name', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain(SEARCH_README);
    expect(SEARCH_README).toBe('search_readme');
  });

  it('isToolName recognizes search_readme', () => {
    expect(isToolName('search_readme')).toBe(true);
    expect(isToolName('not_a_tool')).toBe(false);
  });

  it('calls match_chunks with source_filter="readme"', async () => {
    await executeTool('search_readme', 'how does vox-agent work');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mocks.rpc.mock.calls[0]!;
    expect(fnName).toBe('match_chunks');
    expect(args).toMatchObject({
      query_text: 'how does vox-agent work',
      match_count: 3,
      source_filter: 'readme',
    });
    expect(args.query_embedding).toHaveLength(1024);
  });

  it('formats tool_result with source=readme prefix in each chunk', async () => {
    const result = await executeTool('search_readme', 'x');
    expect(result.metadata.source).toBe('readme');
    expect(result.formatted).toContain('[Source: readme,');
  });
});
