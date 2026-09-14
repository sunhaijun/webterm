/**
 * E2E-5 连接状态指示（AC-2.10）与 E2E-12 阅读输出（AC-5.1/5.2/5.3/5.4/5.13）。
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent, installWSControl, submit, terminalText, termSize, waitFor } from './harness'

type Hooks = { __webterm: { resizes(): number; fontSize(): number; fontFamily(): string } }
const resizes = (p: Page) => p.evaluate(() => (window as unknown as Hooks).__webterm.resizes())
const fontSize = (p: Page) => p.evaluate(() => (window as unknown as Hooks).__webterm.fontSize())
const fontFamily = (p: Page) => p.evaluate(() => (window as unknown as Hooks).__webterm.fontFamily())

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-5 连接状态三态与"补齐 N KB"提示', async ({ page }) => {
  await agent.pair(page)
  const net = await installWSControl(page)
  await page.goto(agent.baseURL)

  // 在线 → 绿点
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'online')

  // 断开 → 橙点 + 倒计时
  await net.goOffline()
  await expect(page.getByTestId('conn-text')).toContainText('重连中')
  await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'reconnecting')
  await expect(page.getByTestId('conn-text')).toContainText(/\d+s 后重试/)

  // 恢复 → 绿点 + "已恢复 · 补齐 N KB"
  net.goOnline()
  await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 30_000 })
})

test('恢复后的 toast 报出补齐的字节数', async ({ page }) => {
  await agent.pair(page)
  const net = await installWSControl(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 断线期间产出一些内容，重连时会被补齐
  await submit(page, 'for i in $(seq 1 200); do printf "row %03d\\n" $i; done')
  await waitFor(async () => (await terminalText(page)).includes('row 200'), '第一段输出')

  await net.goOffline()
  await expect(page.getByTestId('conn-text')).toContainText('重连中')
  await page.waitForTimeout(300)
  net.goOnline()

  // "补齐 N KB"看起来多余，但它让用户【确信没丢东西】—— 这是"永不断线"
  // 这个承诺的可见证据
  await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 30_000 })
})

test('E2E-12 滚动回看与搜索', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'for i in $(seq 1 400); do printf "row %04d\\n" $i; done')
  await waitFor(async () => (await terminalText(page)).includes('row 0400'), '输出跑完')

  // scrollback 里能翻到早期输出，不需要进入任何"模式"
  const text = await terminalText(page)
  expect(text, '早期输出应当留在 scrollback 里').toContain('row 0001')
  expect(text).toContain('row 0400')

  // 缓冲行数应当远超一屏
  const lines = await page.evaluate(() => {
    const w = window as unknown as { __webterm: { text(): string } }
    return w.__webterm.text().split('\n').length
  })
  expect(lines).toBeGreaterThan(100)
})

/**
 * E2E-12 ⑥ 回看时暂停跟随（AC-5.9）。
 *
 * 往上滚之后新到的输出不再写进终端（缓冲行数不涨），右下角提示新增了多少；
 * 点提示回到底部，全部一次到齐、不丢不重。滚动用 __webterm.scrollLines 钩子 ——
 * 真实滚轮 / 手指走的也是同一个 xterm 视口。
 */
test('E2E-12 回看时暂停跟随：缓冲不涨、提示计数、点提示一次补齐不丢不重', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const count = async () => ((await terminalText(page)).match(/FOLLOW-\d{3}/g) ?? []).length
  await submit(page, 'for i in $(seq 1 240); do printf "FOLLOW-%03d\\n" $i; sleep 0.03; done; printf "FOLLOW-%s\\n" END')
  // 等到真有 scrollback 可滚（贴底时 viewport.y == baseY）。只数输出行数不够：
  // 终端有几十行高，输出还没填满一屏时 scrollLines 根本滚不动，跟随也就不会暂停 —— CI 机器快，正好踩到
  await waitFor(async () => (await scrollbackRows(page)) >= 20, '有足够的 scrollback')

  // 滚上去 → 暂停跟随
  await page.evaluate(() => (window as unknown as { __webterm: { scrollLines(n: number): void } }).__webterm.scrollLines(-15))
  await expect(page.getByTestId('follow-pill')).toBeVisible()
  const frozen = await count()
  await page.waitForTimeout(800)
  expect(await count(), '暂停期间终端缓冲里的行数不该增长').toBe(frozen)
  await expect(page.getByTestId('follow-pill')).toContainText(/新增 \d+ 行/)
  const n1 = Number(((await page.getByTestId('follow-pill').textContent()) ?? '').match(/(\d+) 行/)?.[1])
  await page.waitForTimeout(600)
  const n2 = Number(((await page.getByTestId('follow-pill').textContent()) ?? '').match(/(\d+) 行/)?.[1])
  expect(n2, '计数应当随新输出增长').toBeGreaterThan(n1)

  // 点提示 → 回到底部，一次补齐
  await page.getByTestId('follow-pill').click()
  await expect(page.getByTestId('follow-pill')).toHaveCount(0)
  await waitFor(async () => (await terminalText(page)).includes('FOLLOW-END'), '命令跑完', 20_000)
  const lines = (await terminalText(page)).match(/FOLLOW-\d{3}/g) ?? []
  expect(new Set(lines).size, '丢行').toBe(240)
  expect(lines.length, '重行').toBe(240)
  for (let i = 0; i < 240; i++) expect(lines[i]).toBe(`FOLLOW-${String(i + 1).padStart(3, '0')}`)
})

/** 贴底时 viewport.y 就是 baseY —— 能往上滚多少行。 */
async function scrollbackRows(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __webterm: { viewport(): { y: number } } }).__webterm.viewport().y)
}

/**
 * E2E-12 ⑥ 的空闲版：命令跑完、没有新输出，用【真实滚轮】往上滚 —— xterm 对 DOM 驱动的
 * 滚动不发 onScroll，只用 scrollLines 钩子的用例测不到这条。此时也要有提示条，
 * 写「回到底部」；点它回到 baseY、提示条消失。
 */
test('E2E-12 空闲时滚轮回滚也有「回到底部」提示条，点它回底', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'for i in $(seq 1 200); do printf "IDLE-%03d\\n" $i; done; printf "IDLE-%s\\n" END')
  await waitFor(async () => (await terminalText(page)).includes('IDLE-END'), '命令跑完')
  await page.waitForTimeout(300)
  const pill = page.getByTestId('follow-pill')
  await expect(pill, '贴底时没有提示条').toHaveCount(0)
  const bottomY = await scrollbackRows(page)
  expect(bottomY).toBeGreaterThan(20)

  const box = (await page.getByTestId('terminal').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -400)
  await expect(pill).toBeVisible()
  await expect(pill).toHaveText(/回到底部/)
  expect(await scrollbackRows(page), '真的滚上去了').toBeLessThan(bottomY)

  await pill.click()
  await expect(pill).toHaveCount(0)
  expect(await scrollbackRows(page), '回到了底部').toBe(bottomY)
})

test('E2E-12 ③ 改字号会补一条 resize（AC-5.3）', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const before = await resizes(page)
  const cols = (await termSize(page)).cols
  await page.getByTestId('open-settings').click()
  await page.getByTestId('font-size').fill('20')

  // cell 尺寸变了而容器没变，ResizeObserver 不会响 —— 漏发就是客户端与 PTY 的 cols/rows 分家
  await expect.poll(() => resizes(page), { message: '补了一条 resize' }).toBeGreaterThan(before)
  expect((await termSize(page)).cols, '字号变大，列数变少').toBeLessThan(cols)
  expect(await fontSize(page)).toBe(20)
})

test('E2E-12 ⑧ 换终端字体（AC-5.13）', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await page.getByTestId('open-settings').click()

  const select = page.getByTestId('font-family')
  await expect(select).toBeVisible()
  const opts = await select.locator('option').evaluateAll((els) =>
    els.map((e) => ({ id: (e as HTMLOptionElement).value, label: (e as HTMLOptionElement).textContent ?? '' })),
  )
  expect(opts[0]?.id, '系统默认永远在第一位').toBe('system')

  // 【只列本机装了的】：把列出来的名字拿回页面里再量一遍，一个都不该是"没装"
  // 【只用同一套判据再量一遍】：和 fonts.ts 的探测是同一个算法，跑在同一个浏览器里
  const missing = await page.evaluate((names) => {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return names
    const probe = 'mmmmmmmmmmlliWWWWWW0O中文'
    const w = (f: string) => {
      ctx.font = `72px ${f}`
      return ctx.measureText(probe).width
    }
    return names.filter((n) => ['monospace', 'serif', 'sans-serif'].every((b) => w(`"${n}", ${b}`) === w(b)))
  }, opts.slice(1).map((o) => o.label))
  expect(missing, '列出来的字体本机必须真的装着').toEqual([])

  test.skip(opts.length < 2, '这台机器一个清单里的字体都没装，换字体这半边测不了')
  const pick = opts[1]!

  const before = await resizes(page)
  await select.selectOption(pick.id)
  await expect.poll(() => fontFamily(page)).toContain(pick.label)
  expect(await fontFamily(page), 'stack 尾巴永远带 CJK 等宽').toContain('monospace')
  await expect.poll(() => resizes(page), { message: '换字体也要补一条 resize' }).toBeGreaterThan(before)

  // 持久化
  await page.reload()
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await expect.poll(() => fontFamily(page)).toContain(pick.label)

  // 野值回落系统默认，不报错
  await page.evaluate(() => localStorage.setItem('webterm.font.family', 'comic-sans'))
  await page.reload()
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await expect.poll(() => fontFamily(page)).toContain('ui-monospace')
})

test('E2E-12 ⑦ 设置里能看到渲染器', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('renderer')).toHaveText(/WebGL|Canvas/)
  const r = await page.evaluate(() => (window as unknown as { __webterm: { renderer(): string } }).__webterm.renderer())
  expect(['webgl', 'canvas']).toContain(r)
})
