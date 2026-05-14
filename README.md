## ⚠️ SPA Routing — Why vercel.json Has No Rewrite (Read This Before Touching Routing)

**TL;DR:** The SPA rewrite rule that makes `/terminal` and `/cv` work on
hard-refresh is **NOT in `vercel.json`**. It is injected at build time by
`scripts/inject-rewrite.mjs`. This is deliberate. Do not "fix" it by adding
the rewrite to `vercel.json` directly — that breaks local `vercel dev`.

### The problem

This is a React SPA. Routes like `/terminal` and `/cv` are client-side —
they have no real files on disk. On hard-refresh or direct navigation,
Vercel returns 404 unless told to serve `index.html` for non-API routes.

The standard fix is a `rewrites` rule in `vercel.json`. But `vercel.json`
is read by BOTH production Vercel AND `vercel dev` (our `dev:edge` script).
In `vercel dev`, the rewrite catches Vite's on-demand dev module paths
(`/src/main.tsx`, `/@vite/client`, etc.), feeds `index.html` to Vite's JS
parser, and crashes the dev server with "invalid JS syntax at index.html".

### The solution (Option B1 — build-time injection)

- `vercel.json` in the repo stays **rewrite-free** — just the cron config.
- `scripts/inject-rewrite.mjs` adds the rewrite rule to `vercel.json`.
- `package.json` has a `vercel-build` script that runs the injector before
  the build. Vercel automatically uses `vercel-build` instead of `build`.
- Production gets the rewrite. Local `vercel dev` never sees it. No conflict.

### The rewrite rule itself

    { "source": "/((?!api/|.*\\.).+)", "destination": "/index.html" }

Dot-exclusion regex. Excludes `/api/*` paths (API routes keep working) and
any path with a dot (assets, favicon, Vite dev modules). Matches dot-free
non-api paths (`/terminal`, `/cv`, `/privacy`) → serves `index.html`.

**Known limitation:** a SPA route with a dot in it (e.g. `/v1.2/changelog`)
would NOT be rewritten. Keep route paths dot-free.

### ⚠️ Gotcha: never run `vercel-build` locally

`scripts/inject-rewrite.mjs` mutates `vercel.json` in place. On Vercel's
build machine that's ephemeral and fine. If you run `npm run vercel-build`
locally, it WILL dirty your working copy of `vercel.json`.

If that happens:

    git checkout vercel.json

For local work, use `npm run build` (rewrite-free, safe) — never
`vercel-build`.

### Local dev workflow

- **Frontend work** → `npm run dev` (Vite, port 5173). Vite handles SPA
  routing natively. Ignores `vercel.json` entirely.
- **API / chat / cron testing** → `npm run dev:edge` (port 3000). Curl
  `/api/*` routes. Works because `vercel.json` has no rewrite locally.

### If you're debugging a routing 404

1. Is the rewrite in production? Check a Vercel deployment's build logs for
   `[inject-rewrite] Added SPA rewrite`.
2. `curl -s -o /dev/null -w "%{http_code}" https://tusharjayanti.io/terminal`
   → should be `200`. If `404`, the injection didn't run or failed.
3. Do NOT add the rewrite to `vercel.json` as a "quick fix." Read this
   section again.
