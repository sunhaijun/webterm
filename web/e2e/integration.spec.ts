/**
 * E2E-9 输入模式自动切换（AC-3.5）与 E2E-13 shell 集成降级（AC-3.7 / AC-7.6）。
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

async function mode(page: Page): Promise<{ mode: string; locked: boolean }> {
  return page.evaluate(() => {
    const w = window as unknown as { __webterm: { mode(): { mode: string; locked: boolean } } }
    return w.__webterm.mode()
  })
}

test.describe('E2E-9 输入模式自动切换', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test('停在 prompt → Composer；命令在跑 → Raw；结束立即切回', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    // shell 集成握手完成之后才有数据源
    await expect(page.getByTestId('degraded')).toHaveCount(0)
    await waitFor(async () => (await mode(page)).mode === 'composer', '停在 prompt → Composer')

    // 跑一条慢命令 → 去抖后切 Raw
    await submit(page, 'sleep 2')
    await waitFor(async () => (await mode(page)).mode === 'raw', '命令在跑 → Raw', 10_000)
    await expect(page.getByTestId('composer'), 'Raw 模式下输入框收起').toBeHidden()

    // 命令结束 → 立即切回 Composer
    await waitFor(async () => (await mode(page)).mode === 'composer', '命令结束 → Composer', 15_000)
    await expect(page.getByTestId('composer')).toBeVisible()
  })

  test('瞬间结束的命令不应该闪一下 Raw', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    await waitFor(async () => (await mode(page)).mode === 'composer', '初始 Composer')

    // 采样模式变化，看中途有没有出现过 raw
    await page.evaluate(() => {
      const w = window as unknown as {
        __webterm: { mode(): { mode: string } }
        __modeSamples?: string[]
      }
      w.__modeSamples = []
      setInterval(() => w.__modeSamples!.push(w.__webterm.mode().mode), 10)
    })

    await submit(page, 'ls')
    await waitFor(async () => (await terminalText(page)).includes('$ ls'), '命令执行完')
    await page.waitForTimeout(600)

    const samples = await page.evaluate(
      () => (window as unknown as { __modeSamples: string[] }).__modeSamples,
    )
    expect(samples.includes('raw'), `瞬间命令闪了 Raw：${samples.join(',')}`).toBe(false)
  })

  test('手动切换会锁定自动切换，解锁后按当前状态重算', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    await waitFor(async () => (await mode(page)).mode === 'composer', '初始 Composer')

    await page.getByTestId('mode-toggle').click()
    expect(await mode(page)).toEqual({ mode: 'raw', locked: true })

    // 锁定之后 prompt 消息不再改变模式
    await page.waitForTimeout(500)
    expect((await mode(page)).mode).toBe('raw')

    await page.getByTestId('mode-unlock').click()
    await waitFor(async () => {
      const m = await mode(page)
      return m.mode === 'composer' && !m.locked
    }, '解锁后回到 Composer')
  })

  test('Raw 模式下按键直通 PTY', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    await waitFor(async () => (await mode(page)).mode === 'composer', '初始 Composer')

    await page.getByTestId('mode-toggle').click()
    expect((await mode(page)).mode).toBe('raw')

    // 直接往终端上敲
    await page.locator('.xterm-helper-textarea').press('e')
    await page.locator('.xterm-helper-textarea').press('c')
    await page.locator('.xterm-helper-textarea').press('h')
    await page.locator('.xterm-helper-textarea').press('o')
    await page.locator('.xterm-helper-textarea').press('Space')
    await page.locator('.xterm-helper-textarea').press('r')
    await page.locator('.xterm-helper-textarea').press('a')
    await page.locator('.xterm-helper-textarea').press('w')
    await page.locator('.xterm-helper-textarea').press('Enter')

    await waitFor(async () => (await terminalText(page)).includes('raw'), '按键直通到了 PTY')
  })
})

/** E2E-13 shell 集成降级 —— 终端【照常可用】是底线（US-7.1）。 */
test.describe('E2E-13 集成降级', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ noShellIntegration: true })
  })
  test.afterEach(() => agent.stop())

  test('集成不可用时：提示可见、终端照常、模式可手动切', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    // 不打扰但明确的提示，并告诉用户怎么修
    await expect(page.getByTestId('degraded')).toBeVisible()
    await expect(page.getByTestId('degraded')).toContainText('shell 集成未生效')

    // 终端【照常可用】—— 这是底线
    await submit(page, 'printf "DEGRADED-%s\\n" OK')
    await waitFor(async () => (await terminalText(page)).includes('DEGRADED-OK'), '终端仍然能用')

    // 模式固定 Composer，自动切换不发生
    expect(await mode(page)).toEqual({ mode: 'composer', locked: false })
    await submit(page, 'sleep 1')
    await page.waitForTimeout(800)
    expect((await mode(page)).mode, '没有数据源就不该自动切').toBe('composer')

    // 但用户能手动切到 Raw，否则 vim 之类就没法用了
    await page.getByTestId('mode-toggle').click()
    expect((await mode(page)).mode).toBe('raw')
  })
})
