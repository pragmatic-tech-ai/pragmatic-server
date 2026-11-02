import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: 'tests',
    // tests/ also holds the node:test unit suites (*.test.ts); only *.spec.ts are Playwright's.
    testMatch: '**/*.spec.ts',
    timeout: 30000,
    workers: 1,
})
