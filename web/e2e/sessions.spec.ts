/**
 * E2E-6 多会话与未读 —— AC-2.11 / AC-4.3
 * E2E-11 会话生命周期 —— AC-4.2 / AC-4.5 / US-7.3
 * E2E-18 agent 重启后不张冠李戴 —— AC-2.13
 */
import { devices, expect, test, type Page } from '@playwright/test'

import {
  Agent,
  EMIT,
  copySelection,
  count,
  focusTerm,
  hooks,
  installWSControl,
  lastWelcome,
  newSession,
  openDrawer,
  outSeq,
  selectLine,
  submit,
  switchTo,
  terminalText,
  waitFor,
  waitOnline,
  waitText,
} from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
const WIDE = { viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } }

const EXIT_LINE = '[进程已结束（退出码 1）· 按 Enter 关闭]'

/** 视口是不是贴在缓冲底部（按缓冲算：DOM 的 scrollTop 要等下一帧才同步，量它会抖）。 */
const atBottom = async (p: Page) => {
  const lines = (await hooks.text(p)).split('\n').length
  const { rows } = await hooks.size(p)
  return (await hooks.viewport(p)).y >= lines - rows
}

/** E2E-6 的主体：两种形态只有「未读标记长在哪」不同。 */
async function unreadFlow(page: Page, agent: Agent, form: 'compact' | 'wide') {
  await agent.open(page)
  const a = (await hooks.sid(page))!
  const b = await newSession(page)
  await switchTo(page, a)

  // A 里持续输出 5 秒
  await submit(page, `${EMIT} 100 50`)
  await waitText(page, 'line 00005', 'A 开始产出')
  await switchTo(page, b)

  // A 出现未读标记（session.updated{head_seq} > 本地 out_seq；字节不过网络）
  await waitFor(async () => hooks.unread(page, a), 'A 出现未读', 20_000)
  if (form === 'compact') {
    await expect(page.getByTestId('open-sessions'), '会话按钮带红点').toHaveAttribute('data-unread', 'true')
    await openDrawer(page)
    await expect(page.getByTestId(`session-${a}`), '抽屉里 A 那行有未读点').toHaveAttribute('data-unread', 'true')
    await expect(page.getByTestId(`session-${a}`).locator('.unread-dot')).toBeVisible()
    await page.keyboard.press('Escape')
  } else {
    await expect(page.getByTestId(`tab-${a}`)).toHaveAttribute('data-unread', 'true')
    await expect(page.getByTestId(`tab-${a}-unread`), 'A 的标签有未读点').toBeVisible()
  }

  // B 正常工作
  await submit(page, 'echo in-b')
  await waitFor(async () => (await terminalText(page)).split('\n').some((l) => l.trimEnd() === 'in-b'), 'B 正常工作')

  // 切回 A：切走期间的输出全在，未读清除
  await switchTo(page, a)
  await waitText(page, 'EMIT-DONE', 'A 的输出补齐了', 30_000)
  const t = await terminalText(page)
  for (const n of [1, 50, 100]) expect(count(t, `line ${String(n).padStart(5, '0')} `), `line ${n} 恰好一次`).toBe(1)
  expect(await hooks.unread(page, a)).toBe(false)
  if (form === 'compact') await expect(page.getByTestId('open-sessions')).toHaveAttribute('data-unread', 'false')
  else await expect(page.getByTestId(`tab-${a}`)).toHaveAttribute('data-unread', 'false')

  // 切走前在底部 → 切回来跟到底部
  expect(await atBottom(page), '切走前在底部，切回应当在底部').toBe(true)

  // 切走前不在底部 → 切回来保持原位（期间 A 还有一小段输出）
  await submit(page, `sleep 1; ${EMIT} 3 0`)
  await page.waitForTimeout(300) // 回显先落定，再往回滚
  await hooks.scrollLines(page, -20)
  const top = await hooks.viewport(page)
  expect(await atBottom(page)).toBe(false)
  await switchTo(page, b)
  await page.waitForTimeout(2500)
  await switchTo(page, a)
  await waitFor(async () => count(await terminalText(page), 'EMIT-DONE') === 2, '第二段输出补齐')
  const back = await hooks.viewport(page)
  expect(back.top, `切回后回看位置应当不动（之前 y=${top.y}，之后 y=${back.y}）`).toBe(top.top)
}

test.describe('E2E-6 多会话与未读', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test.describe('Pixel 5', () => {
    test.use(PIXEL)
    test('切走的会话继续跑：会话按钮红点 + 抽屉未读点；切回内容完整、未读清除、回看位置保持', async ({ page }) => {
      await unreadFlow(page, agent, 'compact')
    })
  })

  test.describe('1440×900', () => {
    test.use(WIDE)
    test('切走的会话继续跑：标签未读点；切回内容完整、未读清除、回看位置保持', async ({ page }) => {
      await unreadFlow(page, agent, 'wide')
    })
  })
})

test.describe('E2E-11 会话生命周期（上限 5）', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ maxSessions: 5 })
  })
  test.afterEach(() => agent.stop())
  test.use(WIDE)

  test('① 建到上限：+ 禁用并说明原因，快捷键给 toast', async ({ page }) => {
    await agent.open(page)
    for (let i = 1; i < 5; i++) await newSession(page)
    await expect(page.locator('.tabbar .tab')).toHaveCount(5)
    // 点了没反应是最糟的行为（US-7.3）
    const plus = page.getByTestId('new-session')
    await expect(plus).toBeDisabled()
    await expect(plus).toHaveAttribute('title', '会话数已达上限 5')
    await focusTerm(page)
    await page.keyboard.press('Control+Shift+Enter')
    await expect(page.getByTestId('toast')).toContainText('会话数已达上限 5')
  })

  test('②–⑥ shell 退出：提示行在最后输出之后、不计入 seq、可回看可复制、刷新后只有一行、Enter 关闭', async ({ page }) => {
    await agent.open(page)
    const keep = (await hooks.sid(page))!
    const sid = await newSession(page)

    await submit(page, "printf 'LAST-%s\\n' LINE")
    await waitText(page, /^LAST-LINE$/m)
    await submit(page, 'exit 1')
    await waitText(page, EXIT_LINE)
    // 提示行是本地写的、不计入 seq：写完之后 outSeq 不再变，且等于 agent 的 head_seq（刷新后的 welcome 里核对）
    const seqAtLine = await outSeq(page)
    await page.waitForTimeout(500)
    expect(await outSeq(page), '提示行出现之后 outSeq 不再变').toBe(seqAtLine)

    // 它在 LAST-LINE 之后，而且在缓冲的末尾
    const lines = (await terminalText(page)).split('\n').map((l) => l.trimEnd())
    const iLast = lines.findIndex((l) => l === 'LAST-LINE')
    const iExit = lines.findIndex((l) => l.includes(EXIT_LINE))
    expect(iExit, '提示行在 LAST-LINE 之后').toBeGreaterThan(iLast)
    expect(lines.slice(iExit + 1).every((l) => l === ''), '提示行之后没有别的内容').toBe(true)

    // ④ 标签标出已退出
    await expect(page.getByTestId(`tab-${sid}`)).toHaveAttribute('data-exited', 'true')

    // ③ 已退出会话的内容仍可滚动、可选择复制
    await hooks.scrollLines(page, -3)
    await hooks.scrollLines(page, 3)
    await selectLine(page, 'LAST-LINE')
    expect(await copySelection(page)).toContain('LAST-LINE')

    // ⑤ 刷新：快照里没有提示行（它不在 agent 的模拟器里），按会话状态再写一次 —— 只有一行
    await page.reload()
    await waitOnline(page)
    const head = (await lastWelcome(page))!.sessions.find((x) => x.sid === sid)!.head_seq
    expect(seqAtLine, `提示行不计入 seq：刷新前 outSeq ${seqAtLine}，agent 的 head_seq ${head}`).toBe(head)
    await switchTo(page, sid)
    await waitText(page, EXIT_LINE)
    await page.waitForTimeout(500)
    expect(count(await terminalText(page), EXIT_LINE), '刷新之后提示行只有一行').toBe(1)
    expect(await outSeq(page)).toBeGreaterThan(0)

    // ⑥ 在该会话里按 Enter → 关闭（不需要确认），切到相邻会话
    let asked = false
    page.on('dialog', (d) => {
      asked = true
      void d.dismiss()
    })
    await focusTerm(page)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(`tab-${sid}`)).toHaveCount(0)
    expect(asked, 'exited 会话关闭不需要确认').toBe(false)
    await expect(page.getByTestId('close-confirm'), 'exited 会话关闭不弹确认浮层').toHaveCount(0)
    await waitFor(async () => (await hooks.sid(page)) === keep, '切到相邻会话')
  })

  test('⑦ 关闭 running 会话（会话菜单 → 关闭）弹自己的确认浮层：取消 / Esc 不关，Enter 关（ADR-0038）', async ({ page }) => {
    await agent.open(page)
    const sid = await newSession(page)
    const name = (await page.getByTestId(`tab-${sid}`).locator('.tab-name').textContent())!

    let dialogs = 0
    page.on('dialog', (d) => {
      dialogs++
      void d.dismiss()
    })
    const confirm = page.getByTestId('close-confirm')
    const ask = async () => {
      await page.getByTestId(`tab-${sid}`).click({ button: 'right' })
      await page.getByTestId('session-close').click()
      await expect(confirm, '关闭 running 会话必须二次确认').toBeVisible()
    }
    await ask()
    await expect(confirm).toContainText(`关闭「${name}」？`)
    await expect(page.getByTestId('close-ok'), '焦点在「关闭」上').toBeFocused()
    await page.getByTestId('close-cancel').click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId(`tab-${sid}`), '取消了就不该关掉').toBeVisible()

    await ask()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId(`tab-${sid}`), 'Esc 也是取消').toBeVisible()

    await ask()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(`tab-${sid}`), 'Enter 确认').toHaveCount(0)
    expect(dialogs, '不用浏览器对话框').toBe(0)
  })
})

test.describe('E2E-11 ④ compact：抽屉里已退出的会话显示 exit 1（警示色）', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())
  test.use(PIXEL)

  test('exit 1 在抽屉列表里', async ({ page }) => {
    await agent.open(page)
    const sid = await newSession(page)
    await submit(page, 'exit 1')
    await waitText(page, EXIT_LINE)
    await openDrawer(page)
    const row = page.getByTestId(`session-${sid}`)
    await expect(row).toHaveAttribute('data-exited', 'true')
    await expect(row.locator('.sl-meta')).toHaveText('exit 1')
    await expect(row.locator('.sl-meta')).toHaveAttribute('data-failed', 'true')
  })
})

test.describe('E2E-18 agent 重启后不张冠李戴', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test('B 带着旧 instance_id 与 resume{sid:1} 重连 → gone，屏幕不接 A 新会话的输出', async ({ page, context }) => {
    // 标签页 A
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    expect(sid).toBe(1)

    // 标签页 B（同一个 context：Cookie 共享，client_id 各自一个），也看着 sid 1，攒一大段输出
    const pageB = await context.newPage()
    const netB = await installWSControl(pageB)
    await pageB.goto(agent.baseURL)
    await waitOnline(pageB)
    await waitFor(async () => (await hooks.sid(pageB)) === 1, 'B 看着 sid 1')
    await submit(pageB, `${EMIT} 200 0; printf 'B-%s\\n' OLD`)
    await waitText(pageB, /^B-OLD$/m)
    const oldSeq = await outSeq(pageB)
    expect(oldSeq).toBeGreaterThan(10_000)
    const oldInstance = (await lastWelcome(pageB))!.instance_id

    // B 先断着，让 A 先重连
    await netB.goOffline()
    await agent.restart()

    // A 重连：会话全没了 → 新建一个，它拿到 sid 1
    await waitOnline(page)
    await expect(page.getByTestId('empty')).toBeVisible()
    await page.getByTestId('empty-new-session').click()
    await waitFor(async () => (await hooks.sid(page)) === 1, 'A 的新会话拿到 sid 1')
    await submit(page, "printf 'A-%s\\n' NEW")
    await waitText(page, /^A-NEW$/m)

    // B 随后重连：hello 里带着旧 instance_id 与 resume{sid:1, out_seq:很大}
    netB.goOnline()
    await waitOnline(pageB)
    const w = (await lastWelcome(pageB))!
    expect(w.instance_id, 'agent 确实重启过').not.toBe(oldInstance)
    expect(w.resumed.find((r) => r.sid === 1)?.status, `resumed=${JSON.stringify(w.resumed)}`).toBe('gone')
    await expect(pageB.getByTestId('toast')).toContainText('会话已结束')

    // 屏幕上没有把 A 的新会话接到 B 的旧内容后面：旧内容没了；若 B 显示 sid 1，那是从快照重建的新会话
    await pageB.waitForTimeout(1000)
    const text = await terminalText(pageB)
    expect(text, 'B 的旧内容不该还在屏幕上').not.toContain('B-OLD')
    if (text.includes('A-NEW')) expect(count(text, 'line 00001'), '新会话里没有旧输出').toBe(0)
  })
})
