// api/_vercelBypass.ts
//
// Returns the headers needed to bypass Vercel Deployment Protection on
// previews when the bypass secret is configured, or {} when it isn't.
// The eval runner forwards these on every dispatch fetch; production
// code paths never read this.
//
// Today preview protection is disabled, so VERCEL_AUTOMATION_BYPASS_SECRET
// won't be present in the runner's env and no header is sent — behavior
// identical to today. When/if preview protection is re-enabled, exporting
// the secret in eval.yml makes the gate work automatically; no code
// change needed at that point.

export function vercelBypassHeaders(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) return {};
  return { 'x-vercel-protection-bypass': secret };
}
