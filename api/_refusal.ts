// Heuristic refusal detection. Matches the system prompt's refusal phrase
// templates against the accumulated response. Cheap substring checks +
// a word-count guard so a long substantive response that happens to
// contain a refusal phrase mid-sentence is NOT flagged. A future LLM
// judge replaces this once the eval harness needs it.

const REFUSAL_PHRASES = [
  'Not how this works',
  "Not the kind of question I'm here to answer",
  "Not the role I'm here for",
  'Wrong assistant for that',
  'Different operator. Same family',
  "Comedy's not the brief",
  'Outside my scope',
  "That's an email conversation, not a chat one",
  'Better over email than chat',
  '¯\\_(ツ)_/¯',
];

const MAX_REFUSAL_WORDS = 50;

export function detectRefusal(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount > MAX_REFUSAL_WORDS) return false;
  return REFUSAL_PHRASES.some((phrase) => text.includes(phrase));
}
