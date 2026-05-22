// On-demand integration test for the /api/ops-snippet cache lock.
//
// What it proves: of N concurrent GETs that all arrive after the
// cache has been invalidated, exactly one rebuilds (acquires the
// SETNX lock + aggregates) and the rest read its result. We can't
// directly observe lock acquisition from the client, but we CAN
// observe the rebuilder's `last_aggregated_at` timestamp and assert
// every concurrent response shares it. If the lock primitive were
// broken (e.g., race on SET NX, or the lock TTL is too short),
// concurrent requests would each rebuild independently and produce
// distinct timestamps differing by milliseconds.
//
// NOT part of `npm test`. Requires a live deployment + CRON_SECRET
// in the local env (.env.local). Run with:
//
//   npm run test:lock-contention -- <base-url>
//
// e.g. `npm run test:lock-contention -- https://tusharjayanti.io`
// or against a preview URL emitted by `vercel`. Exits 0 on PASS,
// 1 on FAIL, 2 on usage / config error.

import process from 'node:process';

const CONCURRENT = 5;
const WAIT_AFTER_INVALIDATE_MS = 200;

function usage(): never {
  console.error(
    'usage: npm run test:lock-contention -- <base-url>\n' +
      '  example: npm run test:lock-contention -- https://tusharjayanti.io',
  );
  process.exit(2);
}

const rawUrl = process.argv[2];
if (!rawUrl) usage();
const base = rawUrl.replace(/\/+$/, '');
const snippetUrl = `${base}/api/ops-snippet`;

const cronSecret = process.env.CRON_SECRET;
if (!cronSecret) {
  console.error(
    'CRON_SECRET not set in env — load .env.local via `dotenv -e .env.local --`',
  );
  process.exit(2);
}

interface SnippetBody {
  visitors: number | null;
  queries: number | null;
  tokens: number | null;
  tools_per_turn: number | null;
  last_aggregated_at: string | null;
  is_offline: boolean;
}

async function invalidateCache(): Promise<void> {
  const res = await fetch(snippetUrl, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${cronSecret}` },
  });
  // 204 (deleted) is the happy path; 401 means the secret is wrong.
  if (res.status === 401) {
    console.error(
      'cache invalidate returned 401 — CRON_SECRET does not match deployment',
    );
    process.exit(2);
  }
  if (res.status >= 400) {
    const body = await res.text().catch(() => '');
    console.error(`cache invalidate returned ${res.status}: ${body}`);
    process.exit(1);
  }
  console.log(`[step 1] cache invalidated (${res.status})`);
}

async function fireConcurrent(n: number): Promise<SnippetBody[]> {
  const promises: Array<Promise<SnippetBody>> = [];
  for (let i = 0; i < n; i++) {
    promises.push(
      fetch(snippetUrl).then(async (r) => {
        if (!r.ok) {
          throw new Error(`GET returned ${r.status}: ${await r.text()}`);
        }
        return (await r.json()) as SnippetBody;
      }),
    );
  }
  return Promise.all(promises);
}

async function main(): Promise<void> {
  console.log(`[step 0] target: ${snippetUrl}`);
  await invalidateCache();

  // Brief settle so any in-flight requests from elsewhere finish
  // before we fire the concurrent batch.
  await new Promise((r) => setTimeout(r, WAIT_AFTER_INVALIDATE_MS));

  console.log(`[step 2] firing ${CONCURRENT} concurrent GETs`);
  const start = Date.now();
  const bodies = await fireConcurrent(CONCURRENT);
  const totalMs = Date.now() - start;
  console.log(`[step 3] all ${CONCURRENT} responses in ${totalMs}ms`);

  const timestamps = bodies.map((b) => b.last_aggregated_at);
  console.log('timestamps:');
  timestamps.forEach((t, i) => console.log(`  [${i}] ${t ?? '(null)'}`));

  // PASS criterion: every response carries the same non-null
  // last_aggregated_at — proves one rebuilder, four cache readers.
  const distinct = new Set(timestamps);
  const anyNull = timestamps.some((t) => t === null);
  if (anyNull) {
    console.error(
      `FAIL — at least one response returned null last_aggregated_at (offline state). ` +
        `Aggregation likely errored on the rebuilder; see Vercel logs.`,
    );
    process.exit(1);
  }
  if (distinct.size === 1) {
    console.log(
      `PASS — all ${CONCURRENT} responses share timestamp ${timestamps[0]}. ` +
        `Only one rebuild fired; the rest read the cache.`,
    );
    process.exit(0);
  }
  console.error(
    `FAIL — ${distinct.size} distinct timestamps across ${CONCURRENT} concurrent responses. ` +
      `Lock contention is broken: multiple requests rebuilt independently.`,
  );
  process.exit(1);
}

main().catch((err) => {
  console.error('lock-contention test errored:', err);
  process.exit(1);
});
