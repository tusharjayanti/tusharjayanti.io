import { defineConfig } from 'vitest/config';

// Integration tests live under tests/ so they're excluded from the default
// vitest.config.ts include set — `npm test` stays fast and offline. This
// config is invoked explicitly via `npm run test:integration` and hits the
// linked Supabase project + Voyage API.

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
