import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vercelJsonPath = resolve(__dirname, '..', 'vercel.json');

const config = JSON.parse(readFileSync(vercelJsonPath, 'utf8'));

config.rewrites = [
  { source: '/((?!api/|.*\\.).+)', destination: '/index.html' },
];

writeFileSync(vercelJsonPath, JSON.stringify(config, null, 2) + '\n');

console.log('[inject-rewrite] Added SPA rewrite to vercel.json for production build');
