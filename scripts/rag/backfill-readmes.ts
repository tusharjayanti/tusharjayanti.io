// One-time README backfill. Walks the 6-repo allowlist, runs each
// through ingestReadme, prints a per-repo line + a final cost summary.
// Idempotent — re-running against unchanged READMEs costs zero Haiku
// tokens, zero Voyage tokens.
//
// Voyage's free tier caps embedding requests at 3 RPM, so we sleep
// 20s between repos. Idempotent re-runs still pay the wait; a full
// backfill is run rarely (after allowlist edits or model rotations).

import { ingestReadme } from '../../rag/ingest/readme.js';
import { README_REPO_ALLOWLIST } from '../../rag/ingest/readme-config.js';

// Anthropic Claude Haiku 4.5 pricing (per MTok). If this diverges
// from the actual rate sheet, update here so the printed total stays
// honest. Voyage cost is approximated downstream — they don't expose
// per-call token usage via the SDK.
const HAIKU_INPUT_PER_MTOK_USD = 1.0;
const HAIKU_OUTPUT_PER_MTOK_USD = 5.0;
const VOYAGE_VOYAGE3_PER_MTOK_USD = 0.06;

const SLEEP_BETWEEN_REPOS_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  let totalChunks = 0;
  let totalCacheHits = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalUnchanged = 0;
  let totalHaikuIn = 0;
  let totalHaikuOut = 0;
  let totalVoyage = 0;
  let totalCostUsd = 0;

  for (let i = 0; i < README_REPO_ALLOWLIST.length; i++) {
    const repoSlug = README_REPO_ALLOWLIST[i];
    try {
      const r = await ingestReadme(repoSlug);
      const cost =
        (r.haiku_input_tokens / 1_000_000) * HAIKU_INPUT_PER_MTOK_USD +
        (r.haiku_output_tokens / 1_000_000) * HAIKU_OUTPUT_PER_MTOK_USD +
        (r.voyage_tokens / 1_000_000) * VOYAGE_VOYAGE3_PER_MTOK_USD;
      totalChunks += r.total_chunks;
      totalCacheHits += r.summary_cache_hits;
      totalCreated += r.created;
      totalUpdated += r.updated;
      totalUnchanged += r.unchanged;
      totalHaikuIn += r.haiku_input_tokens;
      totalHaikuOut += r.haiku_output_tokens;
      totalVoyage += r.voyage_tokens;
      totalCostUsd += cost;
      console.log(
        `ingest:readme [${repoSlug}] ok: ${r.total_chunks} chunks, ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.summary_cache_hits} summary-cache hits, haiku=${r.haiku_input_tokens}/${r.haiku_output_tokens} (in/out tokens), voyage~${r.voyage_tokens} tokens, ~$${cost.toFixed(4)}`,
      );
    } catch (err) {
      console.error(`ingest:readme [${repoSlug}] failed:`, err);
      throw err;
    }

    if (i < README_REPO_ALLOWLIST.length - 1) {
      console.log(
        `ingest:readme sleeping ${SLEEP_BETWEEN_REPOS_MS / 1000}s before next repo (Voyage free-tier 3 RPM cap)`,
      );
      await sleep(SLEEP_BETWEEN_REPOS_MS);
    }
  }

  console.log(
    `\nbackfill:readmes complete: ${totalChunks} chunks across ${README_REPO_ALLOWLIST.length} repos.`,
  );
  console.log(
    `  created=${totalCreated} updated=${totalUpdated} unchanged=${totalUnchanged} summary-cache-hits=${totalCacheHits}`,
  );
  console.log(
    `  haiku tokens: ${totalHaikuIn} input / ${totalHaikuOut} output`,
  );
  console.log(`  voyage tokens (approx): ${totalVoyage}`);
  console.log(`  total estimated cost: $${totalCostUsd.toFixed(4)}`);
}

main().catch((err) => {
  console.error('backfill:readmes failed:', err);
  process.exit(1);
});
