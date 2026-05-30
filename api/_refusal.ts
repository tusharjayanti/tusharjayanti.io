// Heuristic refusal detection for the production trace tagger.
// Wraps the shared canonical detection logic in ./_refusalPhrases.ts
// so the same phrase list and word-count guard back both production
// (api/chat.ts writes the model-refused tag on Langfuse traces) and
// the eval assertion (evals/lib/assertions/refusal.ts). See
// _refusalPhrases.ts for the canonical list and the design rationale.

export {
  REFUSAL_PHRASES,
  MAX_REFUSAL_WORDS,
  detectRefusal,
} from './_refusalPhrases.js';
