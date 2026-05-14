## ⚠️ SPA Routing — Why vercel.json Has a Rewrite (Read This Before Touching Routing)

**TL;DR:** The SPA rewrite rule that makes `/terminal` and `/cv` work on
hard-refresh lives directly in `vercel.json`. This is deliberate and load-
bearing for production. The tradeoff is that `vercel dev` (our `dev:edge`
script) does NOT work for serving the frontend — it's still fine for
`/api/*` curl testing. Do not "fix" this by removing the rewrite.

### The problem

This is a React SPA. Routes like `/terminal` and `/cv` are client-side —
they have no real files on disk. On hard-refresh or direct navigation,
Vercel returns 404 unless told to serve `index.html` for non-API routes.

The standard fix is a `rewrites` rule in `vercel.json`. The complication
is that `vercel.json` is read by BOTH production Vercel AND `vercel dev`.
In `vercel dev`, an SPA rewrite catches Vite's on-demand dev module paths
(`/src/main.tsx`, `/@vite/client`, etc.), feeds `index.html` to Vite's JS
parser, and crashes the dev server with "invalid JS syntax at index.html".

### The solution (Option C — rewrite in committed vercel.json)

We tried a build-time injector (Option B1) that mutated `vercel.json`
inside `vercel-build`. That doesn't work: Vercel reads `vercel.json`
**before** it runs the build script, so injecting at build time is too
late and `/terminal` still 404'd in production.

So we live with the tradeoff and put the rewrite straight in the committed
`vercel.json`:

    {
      "crons": [
        { "path": "/api/cron/digest", "schedule": "0 0 * * *" }
      ],
      "rewrites": [
        { "source": "/((?!api/|.*\\.).+)", "destination": "/index.html" }
      ]
    }

Production reads this file at deploy time, the rewrite is present, and
`/terminal` / `/cv` / `/privacy` resolve to `index.html` on hard-refresh.

### The rewrite rule itself

    { "source": "/((?!api/|.*\\.).+)", "destination": "/index.html" }

Dot-exclusion regex. Excludes `/api/*` paths (API routes keep working) and
any path containing a dot (assets, favicon, Vite dev modules). Matches
dot-free non-api paths (`/terminal`, `/cv`, `/privacy`) → serves
`index.html`.

**Known limitation:** a SPA route with a dot in it (e.g. `/v1.2/changelog`)
would NOT be rewritten. Keep route paths dot-free.

### ⚠️ Tradeoff: `vercel dev` is broken for the frontend

`vercel dev` reads this `vercel.json` locally and applies the rewrite,
which catches Vite's dev module paths and crashes the dev server. This is
accepted. We split local development:

- **Frontend work** → `npm run dev` (Vite, port 5173). Vite handles SPA
  routing natively and ignores `vercel.json` entirely. This is the
  default local dev workflow.
- **API / chat / cron testing** → `npm run dev:edge` (Vercel dev, port
  3000). Use only for hitting `/api/*` routes with curl. Do NOT try to
  load the frontend through this server — the SPA rewrite will trip Vite's
  module loader and 500 the page.

If you need both at once, run them side-by-side on different ports.

### If you're debugging a routing 404

1. Is the rewrite still in `vercel.json`? `cat vercel.json` should show
   the `rewrites` block. If someone deleted it, that's the bug.
2. `curl -s -o /dev/null -w "%{http_code}" https://tusharjayanti.io/terminal`
   → should be `200`. If `404`, the rewrite is missing or malformed.
3. Did you add a route with a dot in the path? The regex skips dotted
   paths on purpose. Rename the route.
4. Do NOT try to "fix" this by reintroducing a build-time injector. That
   was Option B1; it doesn't work because Vercel reads `vercel.json`
   before the build runs.
