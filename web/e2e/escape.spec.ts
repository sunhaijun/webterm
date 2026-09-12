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
    async () => (await page.evaluate(() => (window as unknown as { __webterm: { mode(): { mode: string } } }).__webterm.mode().mode)) === 'raw',
    '自动切到 Raw（有命令在跑）',
  )

  // 【不点 Ctrl，直接点 ^C】—— 这正是软键盘没弹出来时唯一可行的路径
  await page.getByTestId('key-CtrlC').click()

  await waitFor(
    async () => (await page.evaluate(() => (window as unknown as { __webterm: { mode(): { mode: string } } }).__webterm.mode().mode)) === 'composer',
    '打断之后回到 Composer',
    15_000,
  )
  // 回到 prompt 之后还能正常干活
  await submit(page, 'printf "ALIVE-%s\\n" AFTER')
  await waitFor(async () => (await terminalText(page)).includes('ALIVE-AFTER'), '打断后仍可用')
})

test('^C 在免滚动的前 5 个里（提示符态与命令在跑都是）', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 键区是 .keybar-scroll（行首互切键、行尾 ⋯ 钉住不算，ADR-0015）。
  // 前 5 个键的右缘不超出键区可视右缘 = 无需横向滚动就能点到（AC-3.9）
  const geo = () =>
    page.evaluate(() => {
      const area = document.querySelector('.keybar .keybar-scroll')!
      const keys = [...area.querySelectorAll('.keybar-key')].slice(0, 5)
      const right = Math.max(...keys.map((k) => k.getBoundingClientRect().right))
      return {
        first5: keys.map((k) => k.textContent?.trim()),
        first5Right: Math.round(right),
        areaRight: Math.round(area.getBoundingClientRect().right),
      }
    })

  // 停在提示符：提示符键集里 ^C 也在前 5 个（清掉打错的半行、刚起的命令）
  let g = await geo()
  expect(g.first5, '提示符键集：^C 应当在前 5 个里').toContain('^C')
  expect(g.first5Right, '前 5 个必须无需横向滚动就能点到').toBeLessThanOrEqual(g.areaRight + 1)

  // 命令在跑：通用键集 —— ^C 要用的正是这个时刻
  await submit(page, 'sleep 30')
  await expect(page.getByTestId('key-Escape')).toBeVisible({ timeout: 10_000 })
  g = await geo()
  expect(g.first5, '^C 应当在前 5 个里').toContain('^C')
  expect(g.first5Right, '前 5 个必须无需横向滚动就能点到').toBeLessThanOrEqual(g.areaRight + 1)
})

test('^D / ^Z / ^L 一按直发正确控制码', async ({ page }) => {
  const sent: string[] = []
  await page.exposeFunction('__rec', (x: string) => sent.push(x))
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (d: unknown) {
      try {
        const buf = d instanceof ArrayBuffer ? d : (d as { buffer?: ArrayBuffer })?.buffer
        if (buf) { const u = new Uint8Array(buf); let x = ''; for (let i = 0; i < u.length; i++) x += String.fromCharCode(u[i]!); (window as unknown as { __rec(s: string): void }).__rec(x) }
      } catch { /* ignore */ }
      return send.call(this, d as never)
    }
  })
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, 'sleep 30')
  await expect(page.getByTestId('keybar')).toBeVisible({ timeout: 10_000 })
  for (const [k, code] of [['key-CtrlL', '\x0c'], ['key-CtrlD', '\x04'], ['key-CtrlZ', '\x1a']] as const) {
    sent.length = 0
    await page.getByTestId(k).click()
    await waitFor(async () => sent.some((x) => x.includes(code)), k + ' 发出控制码', 3_000)
  }
})
