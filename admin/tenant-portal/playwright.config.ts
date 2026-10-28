import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: 'tests',
    // Only the gated e2e specs; the *.test.ts files belong to the node:test unit run.
    testMatch: '**/*.spec.ts',
    timeout: 30000,
    workers: 1,
})
