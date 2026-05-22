# Privacy — implementation notes

The terminal page shows an `ops/` widget with a unique-visitor counter
covering the trailing 7 UTC days. The counter is implemented as a
Vercel Edge Middleware (`middleware.ts`) that runs on `/` and
`/terminal` page loads and HSETs the visitor's hashed IP into a
day-keyed Redis hash (`ops:visitors:YYYY-MM-DD`).

Raw IPs are never stored. The middleware reads
`x-forwarded-for` / `x-real-ip` / `x-vercel-forwarded-for`, takes the
SHA-256, and truncates the digest to the first 16 hex chars before
the value reaches Redis. Hashing happens in-process and the raw IP
is never written to any log, trace, or third-party system. The
day-keyed hash itself carries an 8-day TTL (7-day visibility window
plus a 1-day buffer), so the truncated hash is gone within a week of
the last visit. The Vercel platform logs do retain the source IP per
their own retention (out of our control), but those logs are not
surfaced through this site's UI, chat, or `/api/*` responses.

Bot user-agents (`googlebot`, `slackbot`, `discordbot`, generic
`bot|crawler|spider|crawling|preview`) are skipped before any
hashing or Redis call, so they don't reach storage at all. See
`api/_visitorCounter.ts` for the exact regex.

The user-facing `/privacy` page (`src/pages/Privacy.tsx`) summarizes
this in plain language for visitors.
