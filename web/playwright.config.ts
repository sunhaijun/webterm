import { defineConfig, devices } from '@playwright/test'

/**
 * E2E runs the real binary in a real browser.
 *
 * It requires a full build first (npm run build → go build), which proves the go:embed
 * path actually works; see the CI section of docs/70-testing/strategy.md.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Each test starts its own agent; serial runs make failures easier to pin down
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
})
