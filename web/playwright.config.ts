import { defineConfig, devices } from '@playwright/test'

/**
 * E2E 跑的是【真二进制 + 真浏览器】。
 *
 * 前置是完整构建（npm run build → go build），这保证了 go:embed 的路径是
 * 真的通的 —— 见 docs/70-testing/strategy.md 的 CI 一节。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // 每个用例都要起自己的 agent，串行更好定位问题
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
})
