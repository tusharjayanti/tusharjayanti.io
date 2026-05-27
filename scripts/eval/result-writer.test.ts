// Unit tests for the M3 result writer (scripts/eval/result-writer.ts).
// Node-env, no network: each test writes into a fresh temp directory and
// reads back, using a fixture EvalResult. Exercises the §7.3 contract and
// the §9.2 bootstrap (null-baseline) behavior.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';

import {
  writeResult,
  loadBaseline,
  updateBaseline,
  type BaselinePointer,
  type EvalResult,
} from './result-writer.js';

function fixture(commit_sha = 'a'.repeat(40)): EvalResult {
  return {
    schema_version: '1.0.0',
    metadata: {
      commit_sha,
      branch: 'test-branch',
      pr_number: null,
      timestamp: '2026-05-27T00:00:00.000Z',
      runtime_seconds: 1.5,
      eval_set_version: '1.0.0',
      eval_set_content_sha: 'deadbeef',
      baseline_commit_sha: null,
      model_versions: {
        embedding: 'voyage-3',
        rerank: 'claude-haiku-4-5-20251001',
        response: 'claude-sonnet-4-6',
      },
      config_snapshot: {
        top_k_default: 10,
        rerank_temperature: 0,
        eval_concurrency: 1,
      },
    },
    aggregate: {
      retrieval: {
        query_count: 26,
        retrieval_at_1: 0.692,
        retrieval_at_5: 0.846,
        mrr: 0.768,
        ooc_correct_rate: 0,
      },
      assertions: {
        query_count: 0,
        pass_count: 0,
        fail_count: 0,
        pass_rate: 0,
        by_category: {},
      },
      execution: {
        total_queries: 31,
        successful_queries: 31,
        failed_queries: 0,
        runtime_seconds: 1.5,
      },
    },
    per_query: [],
  };
}

describe('result-writer', () => {
  let resultsDir: string;
  let byCommitDir: string;

  beforeEach(async () => {
    resultsDir = await mkdtemp(join(tmpdir(), 'm3-eval-'));
    byCommitDir = resolvePath(resultsDir, 'by-commit');
  });

  afterEach(async () => {
    await rm(resultsDir, { recursive: true, force: true });
  });

  it('writeResult writes <sha>.json into the target dir and returns its path', async () => {
    const result = fixture();
    const { path } = await writeResult(result, { dir: byCommitDir });
    expect(path).toBe(resolvePath(byCommitDir, `${'a'.repeat(40)}.json`));
    const back = JSON.parse(await readFile(path, 'utf-8')) as EvalResult;
    expect(back).toEqual(result);
  });

  it('writeResult creates the directory if missing and trailing-newline terminates the file', async () => {
    const { path } = await writeResult(fixture(), { dir: byCommitDir });
    const raw = await readFile(path, 'utf-8');
    expect(raw.endsWith('}\n')).toBe(true);
  });

  it('loadBaseline returns null when baseline.json is absent (bootstrap)', async () => {
    expect(await loadBaseline({ resultsDir })).toBeNull();
  });

  it('loadBaseline returns null when the pointer references a missing file', async () => {
    const pointer: BaselinePointer = {
      baseline_commit_sha: 'x'.repeat(40),
      baseline_file: 'by-commit/does-not-exist.json',
      updated_at: '2026-05-27T00:00:00.000Z',
    };
    await writeFile(
      resolvePath(resultsDir, 'baseline.json'),
      JSON.stringify(pointer),
      'utf-8',
    );
    expect(await loadBaseline({ resultsDir })).toBeNull();
  });

  it('loadBaseline returns null on malformed baseline.json', async () => {
    await writeFile(
      resolvePath(resultsDir, 'baseline.json'),
      'not valid json',
      'utf-8',
    );
    expect(await loadBaseline({ resultsDir })).toBeNull();
  });

  it('writeResult + updateBaseline + loadBaseline round-trips the result', async () => {
    const sha = 'b'.repeat(40);
    const result = fixture(sha);
    await writeResult(result, { dir: byCommitDir });
    await updateBaseline(sha, { resultsDir });

    const pointer = JSON.parse(
      await readFile(resolvePath(resultsDir, 'baseline.json'), 'utf-8'),
    ) as BaselinePointer;
    expect(pointer.baseline_commit_sha).toBe(sha);
    expect(pointer.baseline_file).toBe(`by-commit/${sha}.json`);

    const loaded = await loadBaseline({ resultsDir });
    expect(loaded).toEqual(result);
  });
});
