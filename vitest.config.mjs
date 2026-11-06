import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Durable Object and Worker tests in a real workerd (Miniflare). Test-only bindings: a throwaway JWT
// secret explicitly enabled for local HS256, inline case documents, no broadcast coalescing, and a
// throwaway deploy-guard token.
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.toml' },
    miniflare: { bindings: { BUILD_SHA: 'a'.repeat(40), SUPABASE_JWT_SECRET: 'test-only-secret-not-for-production', CASE_ALLOW_HS256: '1', CASE_DEV_INLINE_CASES: '1', BROADCAST_COALESCE_MS: '0', LOCK_GRACE_MS: '0', AUTO_LOCK_MS: '0', DEPLOY_GUARD_TOKEN: 'test-only-deploy-guard-token' } },
  })],
  test: {
    // Each file boots a real workerd. Serialize files so cold starts cannot starve
    // another file's unchanged 5-second test deadline; tests retain their own concurrency.
    fileParallelism: false,
    include: ['tests/worker/**/*.test.mjs'],
  },
});
