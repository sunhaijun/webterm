/**
 * E2E-5 连接状态指示 —— AC-2.10
 * E2E-12 阅读输出 —— AC-5.1 / AC-5.3 / AC-5.4 / AC-5.13
 */
import { devices, expect, test, type Page } from '@playwright/test'

import {
  Agent,
  EMIT,
  copySelection,
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

  test('② 改字号：生效、按形态持久化、补一条 resize 且列数跟着变', async ({ page }) => {
    await agent.open(page)
    await page.waitForTimeout(300)
    const cols0 = (await hooks.size(page)).cols
    const r0 = await hooks.resizes(page)

    await page.keyboard.press('Control+Shift+Comma')
    await page.getByTestId('font-size').fill('18')
    await expect.poll(() => hooks.fontSize(page)).toBe(18)
    await page.keyboard.press('Escape')
    await expect.poll(() => hooks.resizes(page), { message: '容器没变也要补一条 resize' }).toBeGreaterThan(r0)
    expect((await hooks.size(page)).cols, '列数跟着变').toBeLessThan(cols0)
    expect(await page.evaluate(() => localStorage.getItem('webterm.fontSize.wide'))).toBe('18')

    await page.reload()
    await waitOnline(page)
    await expect.poll(() => hooks.fontSize(page), { message: '刷新后保持' }).toBe(18)
  })

  test('⑤ 换终端字体（AC-5.13）：只列装了的；换了就换 stack、列数与 resize 跟着变；刷新保持；野值回落', async ({ page }) => {
    await agent.open(page)
    await page.waitForTimeout(300)
    await page.keyboard.press('Control+Shift+Comma')

    const select = page.getByTestId('font-family')
    await expect(select).toBeVisible()
    await expect(page.getByTestId('font-note')).toContainText('连字')
    const opts = await select.locator('option').evaluateAll((els) =>
      els.map((e) => ({ id: (e as HTMLOptionElement).value, label: (e as HTMLOptionElement).textContent ?? '' })),
    )
    expect(opts[0]?.id, '系统默认永远在第一位').toBe('system')

    // 【只列本机装了的】：把列出来的名字拿回页面里用同一套判据再量一遍，一个都不该是"没装"
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

    // 场景本身给的 skip 条件：一台机器一个清单字体都没装时，换字体那半边测不了
    test.skip(opts.length < 2, '这台机器一个清单里的字体都没装，换字体这半边测不了')
    // 挑一个和「系统默认」字宽不同的：系统默认的 monospace 往往就解析成清单里的某一项
    // （这台机器是 DejaVu Sans Mono），换成它列数当然不变
    const widths = await page.evaluate(
      (stacks) => {
        const ctx = document.createElement('canvas').getContext('2d')!
        return stacks.map((f) => {
          ctx.font = `14px ${f}`
          return ctx.measureText('M'.repeat(100)).width
        })
      },
      [await hooks.fontFamily(page), ...opts.slice(1).map((o) => `"${o.label}", monospace`)],
    )
    const diff = opts.slice(1).findIndex((_, i) => Math.abs(widths[i + 1]! - widths[0]!) > 1)
    const pick = opts[diff >= 0 ? diff + 1 : 1]!
    const cols0 = (await hooks.size(page)).cols
    const r0 = await hooks.resizes(page)
    await select.selectOption(pick.id)
    await expect.poll(() => hooks.fontFamily(page)).toContain(pick.label)
    expect(await hooks.fontFamily(page), 'stack 尾巴永远带等宽回退').toContain('monospace')
    await expect.poll(() => hooks.resizes(page), { message: '换字体也要补一条 resize' }).toBeGreaterThan(r0)
    if (diff >= 0) expect((await hooks.size(page)).cols, `换成 ${pick.label} 之后列数应当变化`).not.toBe(cols0)
    else test.info().annotations.push({ type: 'note', description: `清单里装了的字体与系统默认等宽，列数不变（${opts.map((o) => o.label).join('、')}）` })

    await page.reload()
    await waitOnline(page)
    await expect.poll(() => hooks.fontFamily(page), { message: '刷新后仍是它' }).toContain(pick.label)

    // 野值回落系统默认，不报错
    await page.evaluate(() => localStorage.setItem('webterm.font.family', 'comic-sans'))
    await page.reload()
    await waitOnline(page)
    await expect.poll(() => hooks.fontFamily(page)).toContain('ui-monospace')
    expect(await terminalText(page)).toBeDefined()
  })
})
