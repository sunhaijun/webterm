/**
 * E2E-5 连接状态指示 —— AC-2.10
 * E2E-12 阅读输出 —— AC-5.1 / AC-5.3 / AC-5.4
 */
import { devices, expect, test, type Page } from '@playwright/test'

import {
  Agent,
  EMIT,
  copySelection,
  focusTerm,
  hooks,
  installWSControl,
  lastWelcome,
  outSeq,
  rectOf,
  selectLine,
  submit,
  terminalText,
  waitFor,
  waitOnline,
  waitText,
} from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
const WIDE = { viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } }

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** 「补齐 N KB」→ 字节数。 */
function parseBytes(s: string): number {
  const m = s.match(/补齐 ([\d.]+) (B|KB|MB)/)
  if (!m) throw new Error(`toast 里没有字节数：${s}`)
  return Number(m[1]) * (m[2] === 'MB' ? 1024 * 1024 : m[2] === 'KB' ? 1024 : 1)
}

/** 终端几何：矩形 + 行列 + resize 计数。 */
const geo = async (p: Page) => ({ rect: await rectOf(p, '[data-testid=terminal]'), size: await hooks.size(p), resizes: await hooks.resizes(p) })

async function connFlow(page: Page, form: 'compact' | 'wide') {
  const net = await installWSControl(page)
  await agent.open(page)
  const sid = (await hooks.sid(page))!

  // ① 在线：横幅视觉隐藏，conn-text 在 DOM 里且是「在线」
  const banner = page.getByTestId('conn-banner')
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  expect((await banner.boundingBox())!.width, '在线时横幅视觉隐藏').toBeLessThanOrEqual(1)
  if (form === 'wide') await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'online')
  else await expect(page.getByTestId('conn-dot')).toHaveCount(0)
  await page.waitForTimeout(300)
  const g0 = await geo(page)

  // 断线期间有一段输出，恢复时要补
  await submit(page, `${EMIT} 300 10`)
  await waitText(page, 'line 00010')

  // ② 切断 → 横幅「重连中 · Ns 后重试」，倒计时递减
  await net.goOffline()
  const cutSeq = await outSeq(page)
  await expect(page.getByTestId('conn-text')).toContainText('重连中')
  if (form === 'wide') await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'reconnecting')
  expect((await banner.boundingBox())!.width, '不在线时横幅可见').toBeGreaterThan(100)
  // 退避长到 ≥ 2 秒之后，倒计时看得见在走
  let n = 0
  await waitFor(async () => {
    const m = ((await page.getByTestId('conn-text').textContent()) ?? '').match(/重连中 · (\d+)s 后重试/)
    n = m ? Number(m[1]) : 0
    return n >= 2
  }, '出现 ≥ 2 秒的倒计时', 20_000)
  await expect(page.getByTestId('conn-text'), '倒计时递减').toContainText(`重连中 · ${n - 1}s 后重试`, { timeout: 3_000 })

  // ③ 横幅不改几何
  expect(await geo(page), '横幅出现前后终端矩形、行列、resize 计数都不变').toEqual(g0)

  // ④ 恢复 → 横幅消失，toast「已恢复 · 补齐 N KB」，3 秒后消失
  net.goOnline()
  await waitOnline(page)
  const toast = page.getByTestId('toast')
  await expect(toast).toContainText('已恢复 · 补齐')
  expect((await banner.boundingBox())!.width, '恢复后横幅视觉隐藏').toBeLessThanOrEqual(1)
  if (form === 'wide') await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'online')
  const got = parseBytes((await toast.textContent()) ?? '')
  // ⑤ 与实际补齐的量一致（数量级）：重连那一刻 agent 的 head_seq − 断开时的 out_seq
  const head = (await lastWelcome(page))!.sessions.find((s) => s.sid === sid)!.head_seq
  const want = head - cutSeq
  expect(want, '断线期间确实有输出').toBeGreaterThan(1024)
  expect(got / want, `toast 报 ${got} B，实际补了 ${want} B`).toBeGreaterThan(0.8)
  expect(got / want, `toast 报 ${got} B，实际补了 ${want} B`).toBeLessThan(1.25)
  expect(await geo(page), 'toast 也不改几何').toEqual(g0)
  await expect(toast, '3 秒后消失').toHaveCount(0, { timeout: 5_000 })
}

test.describe('E2E-5 连接状态指示', () => {
  test.describe('Pixel 5', () => {
    test.use(PIXEL)
    test('compact：在线不显示；断线横幅倒计时；横幅不改几何；恢复 toast 报补齐字节', async ({ page }) => {
      await connFlow(page, 'compact')
    })
  })
  test.describe('1440×900', () => {
    test.use(WIDE)
    test('wide：状态点在线色 → 重连色；同样的横幅与 toast', async ({ page }) => {
      await connFlow(page, 'wide')
    })
  })
})

test.describe('E2E-12 阅读输出（1440×900）', () => {
  test.use(WIDE)

  test('①③④ 向上滚就能看到早期输出；选区不被新输出破坏；复制内容正确', async ({ page }) => {
    await agent.open(page)
    await submit(page, `${EMIT} 3000 0`)
    await waitText(page, 'EMIT-DONE', '输出跑完', 60_000)

    // ① 滚轮向上滚，不进入任何模式
    const t = (await rectOf(page, '[data-testid=terminal]'))!
    await page.mouse.move(t.left + t.width / 2, t.top + t.height / 2)
    const y0 = (await hooks.viewport(page)).y
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -2000)
    await expect.poll(async () => (await hooks.viewport(page)).y, { message: '滚轮能往回滚' }).toBeLessThan(y0 - 100)
    await hooks.scrollLines(page, -100_000)
    expect((await hooks.viewport(page)).y, '滚到了缓冲顶部').toBe(0)
    const { rows } = await hooks.size(page)
    const firstScreen = (await terminalText(page)).split('\n').slice(0, rows)
    expect(firstScreen.some((l) => l.startsWith('line 00001 ')), '最早的输出还在 scrollback 里（顶上一屏能看到）').toBe(true)
    await hooks.scrollLines(page, 100_000)

    // ③ 选中一行，此时有新输出到达 → 选区仍是原来那一行
    await submit(page, "(sleep 1; for i in $(seq 1 30); do printf 'NEW-%02d\\n' $i; sleep 0.03; done) &")
    await waitText(page, /^\[\d+\] \d+$/m, '后台任务起来了')
    await selectLine(page, 'line 02995 ')
    const sel0 = await copySelection(page)
    expect(sel0).toContain('line 02995')
    await waitText(page, /^NEW-30$/m, '新输出到了')
    await page.waitForTimeout(300)
    // ④ 复制 → 剪贴板内容就是那一行
    const sel1 = await copySelection(page)
    expect(sel1, '新输出不破坏选区').toBe(sel0)
  })

  test('② 外观跟随系统、不刷新就换；字号 14px；没有设置入口，Ctrl+Shift+, 不弹东西（AC-5.3）', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await agent.open(page)
    // 终端区看到的底色是 .stage 的；xterm 自己的主题（ANSI 色、反色单元格用得上）写在
    // .xterm-viewport 的内联样式里（CSS 把它的背景压成透明）
    const bg = () =>
      page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        stage: getComputedStyle(document.querySelector('.stage')!).backgroundColor,
        xterm: document.querySelector<HTMLElement>('.xterm-viewport')!.style.backgroundColor,
      }))
    const light = 'rgb(251, 251, 252)'
    const dark = 'rgb(13, 17, 23)'
    expect(await bg(), '浅色：--bg / --term-bg').toEqual({ body: 'rgb(255, 255, 255)', stage: light, xterm: light })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect
      .poll(bg, { message: '系统切到深色：界面与 xterm 一起变，不用刷新' })
      .toEqual({ body: dark, stage: dark, xterm: dark })

    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.xterm-rows')!).fontSize)).toBe('14px')

    await expect(page.getByTestId('open-settings')).toHaveCount(0)
    await focusTerm(page)
    await page.keyboard.press('Control+Shift+Comma')
    await page.waitForTimeout(300)
    await expect(page.locator('.drawer'), 'Ctrl+Shift+, 不再打开任何浮层').toHaveCount(0)
  })
})
