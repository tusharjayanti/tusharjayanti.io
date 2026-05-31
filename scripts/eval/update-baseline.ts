// scripts/eval/update-baseline.ts
//
// CLI wrapper around result-writer's updateBaseline(). Called by the
// post-merge baseline workflow with the merge commit's SHA so
// evals/results/baseline.json points at by-commit/<sha>.json. Never
// called during a PR run.
//
// Usage: npx tsx scripts/eval/update-baseline.ts <commit-sha>

import { updateBaseline } from './result-writer.js';

const sha = process.argv[2];
if (!sha) {
  console.error('Usage: update-baseline.ts <commit-sha>');
  process.exit(1);
}
await updateBaseline(sha);
console.log(`baseline.json repointed to by-commit/${sha}.json`);
