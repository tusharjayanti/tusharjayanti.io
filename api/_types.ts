// Local replacements for `VercelRequest` / `VercelResponse` from
// `@vercel/node`. The runtime objects Vercel hands to Node-serverless
// handlers ARE the same shape — Node `IncomingMessage` / `ServerResponse`
// with a few Express-style methods (`.status()`, `.send()`, `.json()`)
// layered on the response. We just need the type surface; pulling in
// `@vercel/node` for that surface dragged ajv / minimatch / path-to-
// regexp / smol-toml / undici as transitive devDeps with ~9 npm-audit
// vulnerabilities, none of which were ever reachable from production
// (devDep, types-only consumption).
//
// Keep the interfaces minimal — only the surface the handlers actually
// touch. If a handler grows to need more (cookies, query, etc.), add
// it here rather than reaching for the upstream package.

import type { IncomingMessage, ServerResponse } from 'node:http';

// IncomingMessage already includes `.method`, `.headers` (plain object,
// IncomingHttpHeaders), and is async-iterable (extends Readable). No
// augmentation needed — alias for naming consistency.
export type VercelRequest = IncomingMessage;

// ServerResponse already includes `.setHeader()` and `.end()`. Vercel's
// runtime augments it with three Express-style methods we use across
// these handlers: `.status(code)` returns `this` for chaining,
// `.send(body)` writes a string/Buffer/etc. response, `.json(body)`
// serializes JSON.
export interface VercelResponse extends ServerResponse {
  status(code: number): this;
  send(body: unknown): this;
  json(body: unknown): this;
}
