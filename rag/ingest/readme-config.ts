// Source of truth for the README RAG corpus. Adding or removing
// entries here is the only intended way to change the set; the
// backfill script applies the diff (ingests new repos, deletes chunks
// for removed repos). Sub-spec 3's webhook handler will reject pushes
// to repos not in this list.
//
// `source_id` in the chunks table is exactly `<owner>/<repo>` — the
// slug used here serves as both display name and storage key.

export const README_REPO_ALLOWLIST: readonly string[] = [
  'tusharjayanti/tusharjayanti.io',
  'tusharjayanti/shortlist',
  'tusharjayanti/TensorflowChatbot',
  'tusharjayanti/vox-agent',
  'tusharjayanti/OpticalCharacterRecognition',
  'tusharjayanti/calculator-agent',
];

export function isAllowed(repoSlug: string): boolean {
  return README_REPO_ALLOWLIST.includes(repoSlug);
}
