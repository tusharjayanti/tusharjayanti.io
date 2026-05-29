// Eval result file format + writer.
//
// Defines the committed eval result shape and the three persistence
// functions:
//   - writeResult   — write a per-commit result file to evals/results/by-commit/<sha>.json
//   - loadBaseline  — read the current baseline result, or null on bootstrap
//   - updateBaseline— repoint evals/results/baseline.json (post-merge only)
//
// Plus gatherEnvMetadata(), a helper the runner uses to assemble the
// metadata block from git / CI env / the eval-set manifest. This module
// is intentionally I/O- and assembly-only — it imports no production
// runtime code and makes no network calls.
//
// Paths resolve relative to the repo root (derived from import.meta.url),
// so behavior is independent of the current working directory. Tests
// override the target directory via the opts argument.

import { execSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const DEFAULT_RESULTS_DIR = resolvePath(REPO_ROOT, 'evals', 'results');
const DEFAULT_BY_COMMIT_DIR = resolvePath(DEFAULT_RESULTS_DIR, 'by-commit');
const MANIFEST_PATH = resolvePath(REPO_ROOT, 'evals', 'manifest.json');

// ---- Result file shape ----

export interface ResultMetadata {
  commit_sha: string;
  branch: string;
  pr_number: number | null;
  timestamp: string;
  runtime_seconds: number;
  eval_set_version: string;
  eval_set_content_sha: string;
  baseline_commit_sha: string | null;
  model_versions: {
    embedding: string;
    rerank: string;
    response: string;
  };
  config_snapshot: {
    top_k_default: number;
    rerank_temperature: number;
    eval_concurrency: number;
    [key: string]: unknown;
  };
}

export interface RetrievalAggregate {
  query_count: number;
  retrieval_at_1: number;
  retrieval_at_5: number;
  mrr: number;
  ooc_correct_rate: number;
}

export interface CategoryRollup {
  query_count: number;
  pass_count: number;
  pass_rate: number;
}

export interface AssertionAggregate {
  query_count: number;
  pass_count: number;
  fail_count: number;
  pass_rate: number;
  by_category: Record<string, CategoryRollup>;
}

export interface ExecutionAggregate {
  total_queries: number;
  successful_queries: number;
  failed_queries: number;
  runtime_seconds: number;
}

export interface RetrievalResultBlock {
  rank_of_expected: number | null;
  top_k_returned: string[];
}

export interface AssertionResultBlock {
  assertions: Array<{ type: string; passed: boolean; detail: string }>;
}

export interface PerQueryResultEntry {
  id: string;
  category: string;
  result_type: 'retrieval' | 'assertion';
  passed: boolean;
  // Per-query latency/cost capture lands later; null until then.
  error: string | null;
  latency_seconds: number | null;
  cost_usd: number | null;
  retrieval_result?: RetrievalResultBlock;
  assertion_result?: AssertionResultBlock;
  response_text: string | null;
  trace_id: string | null;
}

export interface EvalResult {
  schema_version: string;
  metadata: ResultMetadata;
  aggregate: {
    retrieval: RetrievalAggregate;
    assertions: AssertionAggregate;
    execution: ExecutionAggregate;
  };
  per_query: PerQueryResultEntry[];
}

// ---- Baseline pointer ----

export interface BaselinePointer {
  baseline_commit_sha: string;
  baseline_file: string;
  updated_at: string;
}

// ---- Writer ----

/**
 * Write a per-commit result file to `${dir}/${commit_sha}.json`.
 * Creates the directory if missing. Returns the absolute path written.
 */
export async function writeResult(
  result: EvalResult,
  opts: { dir?: string } = {},
): Promise<{ path: string }> {
  const dir = opts.dir ?? DEFAULT_BY_COMMIT_DIR;
  await mkdir(dir, { recursive: true });
  const path = resolvePath(dir, `${result.metadata.commit_sha}.json`);
  await writeFile(path, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  return { path };
}

/**
 * Read the current baseline result. Returns null on bootstrap — when
 * baseline.json is absent, or its referenced by-commit file is missing.
 * The threshold checker treats null as "no baseline, skip checks, this
 * run becomes the baseline on merge".
 */
export async function loadBaseline(
  opts: { resultsDir?: string } = {},
): Promise<EvalResult | null> {
  const resultsDir = opts.resultsDir ?? DEFAULT_RESULTS_DIR;
  const pointerRaw = await readFile(
    resolvePath(resultsDir, 'baseline.json'),
    'utf-8',
  ).catch(() => null);
  if (pointerRaw === null) return null;

  let pointer: BaselinePointer;
  try {
    pointer = JSON.parse(pointerRaw) as BaselinePointer;
  } catch {
    return null;
  }
  if (!pointer.baseline_file) return null;

  const resultRaw = await readFile(
    resolvePath(resultsDir, pointer.baseline_file),
    'utf-8',
  ).catch(() => null);
  if (resultRaw === null) return null;

  try {
    return JSON.parse(resultRaw) as EvalResult;
  } catch {
    return null;
  }
}

/**
 * Repoint baseline.json at the given commit's result file. Post-merge
 * only — never called during a PR run.
 */
export async function updateBaseline(
  commit_sha: string,
  opts: { resultsDir?: string } = {},
): Promise<void> {
  const resultsDir = opts.resultsDir ?? DEFAULT_RESULTS_DIR;
  const pointer: BaselinePointer = {
    baseline_commit_sha: commit_sha,
    baseline_file: `by-commit/${commit_sha}.json`,
    updated_at: new Date().toISOString(),
  };
  await mkdir(resultsDir, { recursive: true });
  await writeFile(
    resolvePath(resultsDir, 'baseline.json'),
    `${JSON.stringify(pointer, null, 2)}\n`,
    'utf-8',
  );
}

// ---- Metadata assembly helper ----

function gitOutput(cmd: string): string | null {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Parse the PR number from GitHub Actions env, else null. */
function prNumberFromEnv(): number | null {
  // pull_request events expose refs/pull/<n>/merge in GITHUB_REF.
  const ref = process.env.GITHUB_REF ?? '';
  const m = ref.match(/^refs\/pull\/(\d+)\//);
  if (m) return Number(m[1]);
  if (process.env.PR_NUMBER && /^\d+$/.test(process.env.PR_NUMBER)) {
    return Number(process.env.PR_NUMBER);
  }
  return null;
}

export interface EnvMetadata {
  commit_sha: string;
  branch: string;
  pr_number: number | null;
  eval_set_version: string;
  eval_set_content_sha: string;
}

/**
 * Assemble the git/CI/manifest-derived portion of the result metadata.
 * Prefers GitHub Actions env vars, falling back to local git. Reads the
 * eval-set version + content hash from evals/manifest.json.
 */
export async function gatherEnvMetadata(
  opts: { manifestPath?: string } = {},
): Promise<EnvMetadata> {
  const commit_sha =
    process.env.GITHUB_SHA ?? gitOutput('git rev-parse HEAD') ?? 'unknown';
  const branch =
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    gitOutput('git rev-parse --abbrev-ref HEAD') ||
    'unknown';

  let eval_set_version = 'unknown';
  let eval_set_content_sha = 'unknown';
  const manifestRaw = await readFile(
    opts.manifestPath ?? MANIFEST_PATH,
    'utf-8',
  ).catch(() => null);
  if (manifestRaw !== null) {
    try {
      const manifest = JSON.parse(manifestRaw) as {
        version?: string;
        content_sha?: string;
      };
      eval_set_version = manifest.version ?? 'unknown';
      eval_set_content_sha = manifest.content_sha ?? 'unknown';
    } catch {
      // leave defaults
    }
  }

  return {
    commit_sha,
    branch,
    pr_number: prNumberFromEnv(),
    eval_set_version,
    eval_set_content_sha,
  };
}
