// Script entrypoint for `npm run eval:retrieval`. All runner
// orchestration lives in ./runEvalRetrieval.js; the per-query
// dispatcher + threshold math live in ./dispatch.js. Both are pure
// modules — importing them does not trigger this entrypoint.

import { runEvalRetrieval } from './runEvalRetrieval.js';

runEvalRetrieval().catch((err) => {
  console.error('eval:retrieval failed:', err);
  process.exit(1);
});
