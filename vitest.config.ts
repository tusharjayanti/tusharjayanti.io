import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'api/**/*.test.ts',
      'src/**/*.test.ts',
      'rag/**/*.test.ts',
      'scripts/**/*.test.mjs',
      'scripts/**/*.test.ts',
      'middleware.test.ts',
    ],
    // voyageai@0.2.x ships an ESM bundle whose top-level index.mjs does
    // `import './api'` — a directory import that Node's strict ESM
    // loader (the one tsx/vitest uses) refuses to resolve. Vite's
    // resolver handles directory imports natively, so processing
    // voyageai inline through Vite's pipeline bypasses the strict
    // loader entirely. Production paths (Vercel's serverless bundler,
    // Vite's frontend build) already handle this; the inline directive
    // is test-only.
    server: {
      deps: {
        inline: ['voyageai'],
      },
    },
  },
});
