/**
 * E2E-29 左右滑动切会话（AC-4.7）
 *
 * 终端区单指横滑切相邻会话：左滑下一个、右滑上一个。轴锁把它和「单指纵向拖 = 滚
 * scrollback」分开；切换是纯 CSS 位移，PTY 尺寸全程不变。
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use({ ...PIXEL, launchOptions: { args: ['--disable-webgl'] } })
test.setTimeout(90_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const sid = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())
const size = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { size(): { cols: number; rows: number } } }).__webterm.size())
const pageTransform = (p: Page) =>
  p.evaluate(() => (document.querySelector('.term-host') as HTMLElement | null)?.style.transform ?? '')

/**
 * 在 .term 上派发一次单指拖动：从中心出发，分 steps 步走到 (dx, dy)，全程耗时 ms。
 *
 * 【耗时要给真】：阈值里有速度那一条（> 0.5 px/ms），一口气发完的合成手势
 * 在时间轴上等于「瞬移」，30px 也会被当成甩动。
 */
async function drag(p: Page, dx: number, dy: number, ms = 0, steps = 7) {
  await p.evaluate(
    async ({ dx, dy, ms, steps }: { dx: number; dy: number; ms: number; steps: number }) => {
      const host = document.querySelector('.term') as HTMLElement
      const r = host.getBoundingClientRect()
      const x0 = r.left + r.width / 2
      const y0 = r.top + r.height / 2
      const mk = (x: number, y: number) => [new Touch({ identifier: 1, target: host, clientX: x, clientY: y })]
      const fire = (type: string, touches: Touch[]) =>
        host.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }))
      const sleep = (t: number) => new Promise((res) => setTimeout(res, t))
      fire('touchstart', mk(x0, y0))
      for (let i = 1; i <= steps; i++) {
        if (ms > 0) await sleep(ms / steps)
        fire('touchmove', mk(x0 + (dx * i) / steps, y0 + (dy * i) / steps))
      }
      fire('touchend', [])
    },
    { dx, dy, ms, steps },
  )
}

/** 从会话抽屉新建一个会话，返回新的 sid。 */
async function newSession(p: Page, prev: number | null): Promise<number> {
  await p.getByTestId('statusbar').click()
  await p.getByTestId('new-session').click()
  await waitFor(async () => (await sid(p)) !== prev, '切到了新会话', 10_000)
  const s = await sid(p)
  expect(s).not.toBeNull()
  return s!
}

test('左滑下一个、右滑上一个；纵向拖与短拖都不切；PTY 尺寸全程不变', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const a = await sid(page)
  const b = await newSession(page, a)
  const c = await newSession(page, b)
  expect(new Set([a, b, c]).size, '三个不同的会话').toBe(3)
  const before = await size(page)

  // 当前在 C（最后建的）。右滑 = 上一个 → B
  await drag(page, 140, 0)
  await expect.poll(() => sid(page), { message: '右滑到上一个' }).toBe(b)
  // 左滑 = 下一个 → C
  await drag(page, -140, 0)
  await expect.poll(() => sid(page), { message: '左滑到下一个' }).toBe(c)

  // 纵向拖走的是滚 scrollback 那一路，不切会话
  await drag(page, 0, 140)
  expect(await sid(page), '纵向拖不切会话').toBe(c)

  // 短拖（30px，240ms ≈ 0.13 px/ms）：位移与速度都不过阈值 —— 不切，弹回并清干净
  await drag(page, 30, 0, 240)
  expect(await sid(page), '短拖不切会话').toBe(c)
  await expect.poll(() => pageTransform(page), { message: '弹回并清掉 inline transform' }).toBe('')

  expect(await size(page), '切会话是纯 CSS 位移，PTY 尺寸不变').toEqual(before)
})

test('切过去的是那个会话的内容，不是同一块屏', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const a = await sid(page)
  await submit(page, "printf 'MARK-%s\\n' AAA")
  await waitFor(async () => (await terminalText(page)).includes('MARK-AAA'), 'A 里有内容')

  const b = await newSession(page, a)
  await submit(page, "printf 'MARK-%s\\n' BBB")
  await waitFor(async () => (await terminalText(page)).includes('MARK-BBB'), 'B 里有内容')

  // 横滑回 A：屏上是 A 的内容
  await drag(page, 140, 0)
  await expect.poll(() => sid(page)).toBe(a)
  await waitFor(async () => (await terminalText(page)).includes('MARK-AAA'), '看到的是 A 的内容')
  expect(await terminalText(page)).not.toContain('MARK-BBB')

  // 再横滑回 B
  await drag(page, -140, 0)
  await expect.poll(() => sid(page)).toBe(b)
  await waitFor(async () => (await terminalText(page)).includes('MARK-BBB'), '看到的是 B 的内容')
})

test('只有一个会话时横滑什么也不发生', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  const a = await sid(page)

  await drag(page, -140, 0)
  expect(await sid(page), '没有可切的目标').toBe(a)
  expect(await pageTransform(page), '也不该有跟手位移残留').toBe('')
})
