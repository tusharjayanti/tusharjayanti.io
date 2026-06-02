# ADR 0003: Eval-gated CI with rolling baseline

**Status:** Accepted (2026-05, shipped at M3 Phase 4b — v0.4.0)

**Supersedes:** None
**Superseded by:** None
**Related:** ADR 0001 (observability foundation), ADR 0002 (agentic RAG)

---

## Context

By the end of M2, the chat agent had three failure modes that no existing process caught before deploy:

1. **Retrieval regression.** A change to the prompt, the reranker, or the chunk corpus could silently degrade `retrieval@1` or MRR — visible only to the user typing a query that no longer found the right document.
2. **Defense regression.** A change to the system prompt, the injection regex, or the canary mechanism could silently weaken refusal behavior — the model still answered politely, just no longer refused the things it should.
3. **Cost regression.** A change to tool definitions or to retrieval frequency could silently increase per-turn cost — invisible until the next Langfuse aggregate or the next monthly bill.

The eval suite from M2.7 covered the first two failure modes locally, but ran only on-demand via `npm run eval`. In practice that meant it ran approximately never — engineering velocity rewards merging fast, not running optional checks.

The requirement: **the eval must run automatically on every PR, block merge on regression, and refresh its own reference point on every merge so the bar never drifts stale.** That last clause matters — a static baseline accumulates "approved drift" over time and becomes meaningless. A rolling baseline that refreshes per merge means the comparison point is always the most recent main, and any regression must justify itself against the most recent shipped state.

## Decision

Three interlocking pieces, all running as GitHub Actions:

### 1. The eval set

90 hand-curated queries, content-hashed and versioned in `evals/categories/`:

- **44 labeled retrieval queries** with known-correct chunk references for `retrieval@k` and MRR scoring
- **33 assertion queries** across 4 categories (refusal × 10, injection × 10, canary-leak × 8, off-topic × 5), each with multiple AND-ed assertions
- **13 OOC queries** (8 hard-OOC + 5 absent-facts) for measuring the no-match guardrail's behavior

Content-hashing each query ensures any drift in the eval set itself is detectable in PR review — the eval set is treated as a code artifact, not a config one.

### 2. The CI gate (`.github/workflows/ci.yml`)

Every PR triggers:

- 5 push jobs (format / typecheck / build / test / audit) in parallel, ~20-30s each
- 1 eval job (parallel with push jobs), ~20s under `p-limit=8` concurrency:
  - `wait-for-vercel-preview` action acquires the preview deployment URL
  - 44 retrieval + 13 OOC queries run against Voyage + Supabase directly (no chat endpoint round-trip needed — these test retrieval components in isolation)
  - 33 assertion queries hit production `/api/chat` via the `X-Eval-Bypass` mechanism (see ADR 0004 for the bypass design)
  - `scripts/eval/gate.ts` compares the run to the current baseline and exits non-zero on regression

Regression criteria are precise, not heuristic:

- **BLOCK on:** any errored query (network or assertion engine failure); assertion `pass_count` strictly less than baseline; per-query regression (a query that passed in baseline now fails); per-category `pass_rate` drop (e.g., refusal category drops from 100% to 90%)
- **WARN-only on:** retrieval drift (the `retrievalTolerancePct` is currently `null` and waiting on accumulated drift data to calibrate — see follow-ups)

The `BLOCK` criteria are the load-bearing invariants. They're conservative on purpose: an assertion that flips from pass to fail is the eval doing exactly what it exists to do, and we'd rather block a merge that genuinely deserves a hand-look than let a regression through.

### 3. The baseline refresh (`.github/workflows/baseline.yml`)

On every PR merge to `main`, this workflow:

- Runs the same eval set against production (`EVAL_MAIN_ENDPOINT_URL`, with `CI_GATE: 'off'` so it doesn't gate itself)
- Writes the full per-query results to `evals/results/by-commit/<sha>.json`
- Updates `evals/results/baseline.json` to point at the new SHA via `scripts/eval/update-baseline.ts`
- Pushes the two changes back to `main` via `BASELINE_PUSH_TOKEN`

The next PR's CI gate then compares against this fresh baseline. The mechanism is closed-loop: the same `/api/chat` code path that just merged becomes the reference point for the next PR.

A subtle property of this design: `baseline.json` is a tiny pointer file (`baseline_commit_sha` + `baseline_file` + `updated_at`), and the actual results live in immutable per-SHA files. This keeps the rolling update atomic — one tiny file change per merge — while preserving every historical run as a permanent record. Any regression debug starts with `git log -- evals/results/baseline.json` and diffing two per-SHA result files.

## Consequences

**Wins:**

- Every merge to main is gated against an evidence-based quality bar that updates itself
- The baseline doesn't drift stale — by construction, it's always the most recent merge
- Defense regressions get caught before they ship; we have receipts (33/33 assertion pass rate held across every PR through Phase 4b and 5)
- The mechanism is self-documenting: `evals/results/baseline.json` + `evals/results/by-commit/` tells anyone the full quality history

**Costs and trade-offs:**

- **PR latency increases by ~30-60s** for the eval job. Acceptable for a portfolio-scale repo; would be re-evaluated if PR volume scaled 10x.
- **Eval flakiness ⟹ false BLOCKs.** A transient Supabase or Anthropic API hiccup during the eval can fail the run. Mitigated by: idempotent re-runs, no retries within the gate (failure should be visible, not papered over), and `p-limit=8` concurrency that limits provider rate-limit exposure.
- **Cost.** The eval against the Vercel preview during CI plus the eval against production on merge means ~180 chat-turn invocations per merge cycle, with corresponding Sonnet + Haiku + Voyage spend. Real but small at portfolio scale; see README's Cost optimization → Per-turn cost for the math.
- **Production hits during CI.** The 33 assertion queries hit production `/api/chat`, not a staging copy. This is deliberate (same code path as user-facing traffic; staging would inevitably drift) but means the gate consumes a small slice of real production capacity. The `X-Eval-Bypass` mechanism skips rate-limiting for these requests but still runs the full injection prefilter, so defense behavior is unchanged. See ADR 0004 for the bypass scope rationale.

## Implementation notes — what went wrong on the way to shipping

This section captures the four debugging discoveries that the working code does not reveal. Without them written down, anyone debugging a similar issue (or extending this workflow) would have to re-derive each finding from scratch.

### 1. GH006 rejection on bot push — `persist-credentials: true` default

The first three runs of `baseline.yml` failed at the `git push` step with GitHub's GH006 "protected branch" rejection, despite the workflow having a valid `BASELINE_PUSH_TOKEN` PAT with permissions to push to `main`.

The root cause: `actions/checkout@v4` defaults to `persist-credentials: true`, which writes an `http.https://github.com/.extraheader` entry into `.git/config` containing the workflow's default `GITHUB_TOKEN`. This extraheader takes precedence over any subsequent `git push` invocation that supplies a different token via URL or env. The push appears to authenticate with `BASELINE_PUSH_TOKEN` but actually authenticates with `GITHUB_TOKEN`, which doesn't have the bypass permissions.

**Fix:** `persist-credentials: false` on the `actions/checkout` step. With this set, the extraheader is not written, and the subsequent `git push` honors the PAT.

This is in the `actions/checkout` documentation, but the failure mode is opaque — the error is the eventual GH006, not "your extraheader is overriding your PAT." Worth knowing for any future workflow that needs to push back to a protected branch with a token other than `GITHUB_TOKEN`.

### 2. Classic branch protection vs ruleset — admin bypass is only available on rulesets

GitHub offers two ways to protect a branch: legacy "branch protection rules" and the newer "rulesets". They look interchangeable in the UI. They are not.

Classic branch protection's "Require status checks to pass before merging" cannot be bypassed by admins, even with "Allow administrators to bypass" enabled — that toggle only affects the *merge button*, not direct pushes from automated workflows. A direct push from `baseline.yml` to `main` while classic protection was active would fail with GH006 even with admin credentials and a valid PAT.

Rulesets, by contrast, support a "Bypass list" with a per-actor permission level (`Always` / `Pull request only`). Setting `Repository admin` with `Always` bypass on the `main_protection` ruleset is what allows `baseline.yml`'s bot push to succeed.

**Fix:** migrate from classic branch protection (`main_protection` legacy rule) to a ruleset (`main_protection` ruleset) with `Repository admin → Always` bypass. The 6 required status checks (5 push jobs + eval) are preserved across the migration. Classic protection rule deleted after ruleset verified working.

Worth flagging: the GitHub docs are unclear on this distinction. The migration takes 5 minutes; the diagnosis took 2 hours.

### 3. Fine-grained PAT vs classic PAT — fine-grained cannot push to protected branches

GitHub's "fine-grained personal access tokens" are the recommended PAT type as of 2024. They support per-repository permissions, expiration dates, and granular scopes. They're strictly more secure than classic PATs.

They also **cannot push to a branch protected by a ruleset, even when the ruleset has the PAT's owner in its bypass list**. Despite GitHub's documentation suggesting otherwise. Reproduced twice with two different fine-grained PATs with `Contents: Read and write` permission on this repo.

**Fix:** generate a classic PAT with `repo` scope, store as `BASELINE_PUSH_TOKEN`. The classic PAT, with the ruleset's admin-bypass mechanism, successfully pushes.

This is undocumented behavior and I'd consider it a GitHub bug. The fine-grained PAT is the strictly-more-secure option; it should support every workflow the classic PAT does. Track GitHub's release notes for when this gets fixed and migrate back.

### 4. `[skip ci]` in bot commit message — blocks Vercel as well as GitHub Actions

The first version of `baseline.yml`'s commit message included `[skip ci]` at the end, intended to prevent the bot's commit from re-triggering `ci.yml` (which would be pointless — the bot only updates `baseline.json`, no code change to validate). This worked: GitHub Actions correctly skipped the CI run.

It also broke Vercel deployments. Vercel respects the same `[skip ci]` convention and refused to deploy the bot commit, which meant production deploys lagged one commit behind main until the next code-bearing PR triggered Vercel again.

**Fix:** remove `[skip ci]` from the bot commit message. The CI cycle on a bot commit is now:

- `baseline.yml` bot commit triggers `ci.yml` (5 push jobs only — the eval job has its own guard that skips on bot commits, see `if:` condition in `ci.yml`)
- 5 push jobs run in ~20-30s, all idempotent (format / typecheck / build / test / audit)
- Vercel deploys the bot commit (cosmetic: it's `baseline.json` only)
- Production is exactly in sync with main

The duplicate CI run on bot commits is a small cost (5 parallel ~20s jobs) but bought us deterministic Vercel deploys.

## Follow-ups

Tracked but not blocking M3:

- **`retrievalTolerancePct: null`** — the WARN-only retrieval drift threshold needs calibration against accumulated drift data. Re-examine after ~3 months of merge history. Until then, retrieval drift is reported in CI logs but doesn't block.
- **Artifact upload SHA mismatch** — `actions/upload-artifact@v4` occasionally surfaces a cosmetic SHA mismatch in CI logs for the per-commit eval result file. Three fix options enumerated in PR #32 review comments. Cosmetic only.
- **Node.js 20 deprecation** — `actions/checkout@v4` and `actions/setup-node@v4` will be forced to Node 24 starting June 16, 2026. Either bump action versions when convenient or set `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` repo-wide.
- **Absent-facts query category** — the 5 absent-facts queries currently miscategorized under OOC keep the OOC firing rate at 61.5% (8/13) rather than the 100% (8/8) it would be with hard-OOC alone. Worth splitting into a separate category. Logged in `docs/eval/ooc-threshold-tuning.md`.

## References

PR trail through Phase 4 → Phase 6:

- **PR #26** — `feat(eval): wire chat endpoint into runner (M3 Phase 4a)` — first version of the assertion-query runner hitting `/api/chat`
- **PR #28** — `feat(eval): M3 Phase 4b — CI gate + baseline mechanics` — the gate and the baseline workflow shipped together; this is the architectural commit
- **PR #30** — `ci(baseline): authenticate baseline push with PAT` — first attempt at the PAT-authenticated push; CI failed (red X in the PR list); the fix landed in #31
- **PR #31** — `ci(baseline): disable persist-credentials so BASELINE_PUSH_TOKEN is honored` — the `actions/checkout` extraheader override fix (see Implementation note 1)
- **PR #32** — `ci(baseline): drop the workflow-skip tag from bot's commit message` — the `[skip ci]` / Vercel deploy fix (see Implementation note 4)
- **PR #33** — `eval(ooc): tune cosine floor to 0.28 with hard-OOC query replacement` — Phase 5 Sub-task B
- **PR #34** — `eval(refusal): broaden coverage to vocabulary-flexible probes + tighten assertions` — Phase 5 Sub-task C
- **PR #35** — `README revamp` — M3 docs (this ADR series lands in a follow-up PR)

Two earlier debugging PRs worth noting:

- **PR #24** — `fix(eval): introduce skipped outcome for dormant assertion queries` — the runner needed a `skipped` outcome distinct from `failed` before assertions could be authored confidently (pre-Phase 4 cleanup)
- **PR #27** — `fix(eval): broaden ref-006 assertion for vocabulary-flexible queries` — an early one-off that anticipated the systematic vocabulary-flexible split landed in #34

Code surface:

- `.github/workflows/ci.yml` — PR gate
- `.github/workflows/baseline.yml` — post-merge baseline refresh
- `scripts/eval/gate.ts` — compare-to-baseline logic with BLOCK/WARN rules
- `scripts/eval/update-baseline.ts` — atomic baseline pointer update
- `evals/categories/` — versioned query sets
- `evals/lib/assertions/` — assertion engine (5 types: `contains_any`, `not_contains`, `rag_used`, `source_excludes`, `refusal_detected`)
- `evals/results/baseline.json` — current pointer
- `evals/results/by-commit/<sha>.json` — immutable per-merge results
- `api/_kv.ts` `checkRateLimit` — the rate-limiter the `X-Eval-Bypass` mechanism skips for eval traffic

Code surface:

- `.github/workflows/ci.yml` — PR gate
- `.github/workflows/baseline.yml` — post-merge baseline refresh
- `scripts/eval/gate.ts` — compare-to-baseline logic with BLOCK/WARN rules
- `scripts/eval/update-baseline.ts` — atomic baseline pointer update
- `evals/categories/` — versioned query sets
- `evals/lib/assertions/` — assertion engine (5 types: `contains_any`, `not_contains`, `rag_used`, `source_excludes`, `refusal_detected`)
- `evals/results/baseline.json` — current pointer
- `evals/results/by-commit/<sha>.json` — immutable per-merge results
- `api/_kv.ts` `checkRateLimit` — the rate-limiter the `X-Eval-Bypass` mechanism skips for eval traffic
