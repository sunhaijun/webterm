import { devices, expect, test } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 脱困键 —— 真用出来的问题。
 *
 * 用户在手机上误进了 top，退不出来：功能键条上只有【粘滞 Ctrl】，
 * 它要求"点 Ctrl，再从软键盘打 c"。而 Raw 模式下看 top 的时候软键盘
 * 根本没弹出来，于是没有任何办法发出 ^C。
 */
test.use({ ...devices['Pixel 5'] })

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('卡在全屏程序里能靠 ^C 退出来', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 一个不吃 q、只能靠信号打断的前台程序 —— 比 top 更能说明问题
  await submit(page, 'while :; do sleep 1; done')
  await waitFor(
    async () => (await page.getByTestId('modebar').getAttribute('data-mode')) === 'raw',
    '自动切到 Raw（有命令在跑）',
  )

  // 【不点 Ctrl，直接点 ^C】—— 这正是软键盘没弹出来时唯一可行的路径
  await page.getByTestId('key-CtrlC').click()

  await waitFor(
    async () => (await page.getByTestId('modebar').getAttribute('data-mode')) === 'composer',
    '打断之后回到 Composer',
    15_000,
  )
  // 回到 prompt 之后还能正常干活
  await submit(page, 'printf "ALIVE-%s\\n" AFTER')
  await waitFor(async () => (await terminalText(page)).includes('ALIVE-AFTER'), '打断后仍可用')
})

test('^C 在免滚动的前 8 个里', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const geo = await page.evaluate(() => {
    const bar = document.querySelector('.keybar')!
    const keys = [...bar.children].slice(0, 8)
    const right = Math.max(...keys.map((k) => k.getBoundingClientRect().right))
    return {
      first8: keys.map((k) => k.textContent?.trim()),
      first8Right: Math.round(right),
      barRight: Math.round(bar.getBoundingClientRect().right),
    }
  })
  expect(geo.first8, '^C 应当在前 8 个里').toContain('^C')
  expect(geo.first8Right, '前 8 个必须无需横向滚动就能点到').toBeLessThanOrEqual(geo.barRight + 1)
})

test('^D / ^Z / ^L 也能一按直发', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'printf "BEFORE-CLEAR\\n"')
  await waitFor(async () => (await terminalText(page)).includes('BEFORE-CLEAR'), '先有点内容')

  await page.getByTestId('key-CtrlL').click() // 清屏
  await waitFor(async () => {
    const t = await terminalText(page)
    // 清屏之后可视区里不该还挂着那行（scrollback 里有是正常的）
    return !t.split('\n').slice(-5).join('\n').includes('BEFORE-CLEAR')
  }, '^L 清了屏')
})
