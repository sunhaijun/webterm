/**
 * E2E-2 断线续传 ★ 核心 —— AC-2.1 / AC-2.2 / AC-2.3 / AC-2.5 / AC-2.21
 * E2E-3 断线期间的输入不丢 —— AC-2.4 / AC-2.12
 * E2E-4 快照路径的 UI 表现 —— AC-2.6
 *
 * 它不测"重连能不能连上"（那太弱），而是测【最终屏幕状态是否与从未断线时
 * 完全一致】。任何 seq 记账错误、切片偏移、重复回放、丢帧，都会让两次结果
 * 不同。这是"永不断线"这个承诺的机械化证据。
 *
 * 每一轮都在【新会话】里跑，命令前先 `printf '\033c'`（RIS）把回显的命令行清掉 ——
 * 基准与对照的每行延迟不同（命令行不同），清掉之后剩下的就只有 emit.sh 的输出。
 */
import { expect, test, type Page } from '@playwright/test'

import {
  Agent,
  EMIT,
  count,
  framesSince,
  hooks,
  installWSControl,
  lastWelcome,
  newSession,
  outSeq,
  serialize,
  submit,
  terminalText,
  waitFor,
  waitOnline,
  waitSnapshot,
  waitText,
  type WSControl,
} from './harness'

// 【不录 trace】：routeWebSocket 中继的每一条消息都会被记成一个 trace 动作，几千帧输出
// 能把 Playwright 的协议通道堵上几十秒（实测一次 waitForTimeout(300) 拖了 44 秒）
test.use({ trace: 'off' })

/** 等输出彻底停下来（outSeq 与缓冲文本都不再变），给两轮一个确定的截止点。 */
async function waitQuiet(page: Page, quietMs = 700): Promise<void> {
  let last = ''
  let since = Date.now()
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const now = `${await outSeq(page)}:${(await terminalText(page)).length}`
    if (now !== last) {
      last = now
      since = Date.now()
    } else if (Date.now() - since >= quietMs) {
      return
    }
    await page.waitForTimeout(50)
  }
  throw new Error('超时等待：输出静默')
}

/** 序列化结果截到完成标记为止 —— 之后的提示符与光标不属于这段输出。 */
function untilDone(s: string): string {
  const i = s.indexOf('EMIT-DONE')
  if (i < 0) throw new Error('序列化结果里没有 EMIT-DONE')
  return s.slice(0, i + 'EMIT-DONE'.length)
}

function assertSame(got: string, want: string, what: string): void {
  if (got === want) return
  let i = 0
  while (i < got.length && i < want.length && got[i] === want[i]) i++
  throw new Error(
    `${what}：第 ${i} 字节起分歧\n` +
      `基准长度 ${want.length}，实际长度 ${got.length}\n` +
      `基准 …${JSON.stringify(want.slice(Math.max(0, i - 60), i + 60))}\n` +
      `实际 …${JSON.stringify(got.slice(Math.max(0, i - 60), i + 60))}`,
  )
}

/** 在一个新会话里清屏后跑 emit，返回会话号。 */
async function startEmit(page: Page, args: string): Promise<number> {
  const sid = await newSession(page)
  await submit(page, `printf '\\033c'; ${EMIT} ${args}`)
  return sid
}

/** 跑完一轮并取序列化结果。 */
async function finish(page: Page): Promise<string> {
  await waitText(page, 'EMIT-DONE', '输出跑完', 90_000)
  await waitQuiet(page)
  return untilDone(await serialize(page))
}

/** 切断一次：等横幅出「重连中」，按需多等一会儿，再恢复并等回到「在线」。 */
async function cut(page: Page, net: WSControl, holdMs = 0): Promise<void> {
  await net.goOffline()
  await expect(page.getByTestId('conn-text')).toContainText('重连中', { timeout: 10_000 })
  if (holdMs) await page.waitForTimeout(holdMs)
  net.goOnline()
  await waitOnline(page, 30_000)
}

test.describe('E2E-2 字节级连续性（默认 ring 256 KiB，走增量）', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test('E2E-2a/2b/2d 断开 1 次 / 断开 5 秒 / 快速断开 10 次：屏幕与从未断线时逐字节一致', async ({ page }) => {
    test.setTimeout(240_000)
    const net = await installWSControl(page)
    await agent.open(page)

    // 基准：不断开
    await startEmit(page, '2000 0')
    const baseline = await finish(page)
    expect(baseline.length, '基准输出太少，测不出东西').toBeGreaterThan(100_000)

    // 2a：输出进行到约一半时切断
    {
      await startEmit(page, '2000 2')
      await waitText(page, 'line 01000', '输出过半')
      await cut(page, net)
      // 恢复的 toast 报出补了多少（AC-2.10）
      await expect(page.getByTestId('toast')).toContainText('已恢复')
      expect((await lastWelcome(page))!.resumed.every((r) => r.status === 'ok'), '没溢出就该走增量').toBe(true)
      assertSame(await finish(page), baseline, 'E2E-2a 断开一次后字节级连续性被破坏')
    }

    // 2b：断开 5 秒（每行 5ms：断开期间最多产 ~1100 行 ≈ 180 KiB，不溢出 256 KiB 的 ring）
    {
      await startEmit(page, '2000 5')
      await waitText(page, 'line 00200', '输出开始')
      await cut(page, net, 5000)
      expect((await lastWelcome(page))!.resumed.every((r) => r.status === 'ok'), '5 秒不溢出，仍走增量').toBe(true)
      assertSame(await finish(page), baseline, 'E2E-2b 断开 5 秒后字节级连续性被破坏')
    }

    // 2d：连续快速断开 10 次，每次间隔 300ms —— 验证没有累积错位
    {
      // 每行 10ms ≈ 20 秒：10 次断开（每次连退避约 0.7 秒）全落在输出期间
      await startEmit(page, '2000 10')
      await waitText(page, 'line 00050', '输出开始')
      for (let i = 0; i < 10; i++) {
        await net.goOffline()
        await page.waitForTimeout(300)
        net.goOnline()
        await waitOnline(page, 30_000)
      }
      expect(await terminalText(page), '10 次断开应当都落在输出期间').not.toContain('EMIT-DONE')
      assertSame(await finish(page), baseline, 'E2E-2d 连续断开 10 次后字节级连续性被破坏')
    }
  })

  test('E2E-2e 断点落在着色区间内：走增量，字节原样续上，颜色与基准一致', async ({ page }) => {
    test.setTimeout(120_000)
    const net = await installWSControl(page)
    await agent.open(page)

    await startEmit(page, '1500 0 mono')
    const baseline = await finish(page)

    const sid = await startEmit(page, '1500 3 mono')
    await waitText(page, 'line 00500', '同色区间已经开始')
    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('重连中')
    const cutAt = await outSeq(page)
    const read = await framesSince(page)
    net.goOnline()
    await waitOnline(page)

    const w = (await lastWelcome(page))!
    expect(w.resumed.find((r) => r.sid === sid)?.status, '断点在 ring 窗口内，必须走增量').toBe('ok')

    // agent 不改写输出流（AC-2.5）：续上的第一帧从断点（或之前，重叠部分客户端去重）开始，
    // 中间没有快照。【趁早读】：frames() 只留最近 512 帧，跑完再读就只剩尾巴了
    let fs: Awaited<ReturnType<typeof read>> = []
    await waitFor(async () => {
      fs = (await read()).filter((f) => f.sid === sid)
      return fs.length > 0
    }, '重连后收到第一帧')
    expect(fs.some((f) => f.kind === 'SNAPSHOT'), '增量路径不该有快照').toBe(false)
    expect(fs[0]!.seq, `续传的第一帧应当从断点 ${cutAt} 接上`).toBeLessThanOrEqual(cutAt)
    expect(fs[0]!.seq + fs[0]!.bytes, '第一帧覆盖断点').toBeGreaterThan(cutAt)

    const after = await finish(page)
    assertSame(after, baseline, 'E2E-2e 断点落在着色区间内，续上的颜色/字节与基准不同')
  })
})

test.describe('E2E-2c / E2E-4 断开期间输出超过 ring_bytes → 快照', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ ringBytes: 65536 }) // 调小，让快照路径可测
  })
  test.afterEach(() => agent.stop())

  test('E2E-2c 重连走快照：最后 2000 行 + 当前屏与基准逐行一致，无截断提示，之后的输出正确', async ({ page }) => {
    test.setTimeout(180_000)
    const net = await installWSControl(page)
    await agent.open(page)

    // 基准：同一条命令，不断开。【先 sleep 3】：对照那一轮要在这 3 秒里把线掐掉，
    // 整段输出才落在断线期间；基准用同一条命令，命令行回显也一样
    const cmd = `sleep 3; ${EMIT} 5000 0`
    await newSession(page)
    await submit(page, cmd)
    await waitText(page, 'EMIT-DONE', '基准跑完', 90_000)
    await waitQuiet(page)
    const base = (await terminalText(page)).split('\n').map((l) => l.trimEnd())

    // 对照：新会话里起同一条命令，立刻断线
    const sid = await newSession(page)
    await submit(page, `printf 'OLD-%s\\n' SCREEN; ${cmd}`)
    await waitText(page, 'OLD-SCREEN')
    // 回看位置先挪上去：快照之后应当回到底部（E2E-4）
    await hooks.scrollLines(page, -5)
    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('重连中')
    // 断线期间：3 秒后开始产出 5000 行 ≈ 800 KiB，远超 64 KiB
    const read = await framesSince(page)
    await page.waitForTimeout(7000)
    net.goOnline()
    await waitOnline(page)

    const w = (await lastWelcome(page))!
    expect(w.resumed.find((r) => r.sid === sid)?.status, '积压超过 ring_bytes 必须走快照').toBe('snapshot')
    const snap = await waitSnapshot(read, sid)
    expect(snap.length).toBeGreaterThan(0)
    await waitText(page, 'EMIT-DONE', '跑完', 60_000)
    await waitQuiet(page)

    // 没有「历史输出已截断」之类的提示（快照就是完整画面）
    await expect(page.getByTestId('truncated')).toHaveCount(0)
    await expect(page.getByText(/截断/)).toHaveCount(0)

    // 屏幕级一致（AC-2.21）：最后 2000 行历史 + 当前屏，逐行比。
    // 【行尾空白不算差异】：程序写出的空格与空格子在屏幕上一样，快照里行尾的空格
    // 记成空格子（translateToString 只裁空格子、不裁写出来的空格）—— 单测的逐格比较
    // 也把两者归一（web/tests/snapshot-xterm.test.ts 的 cellKey）
    const got = (await terminalText(page)).split('\n').map((l) => l.trimEnd())
    const { rows } = await hooks.size(page)
    const n = 2000 + rows
    expect(got.length, `快照带回来的行数（历史 ≤ 2000 + 当前屏 ${rows}）`).toBeLessThanOrEqual(n)
    expect(got.length, '快照应当带满 2000 行历史').toBeGreaterThanOrEqual(n - 1)
    const tail = (a: string[]) => a.slice(-Math.min(got.length, n))
    const g = tail(got)
    const b = tail(base)
    for (let i = 0; i < g.length; i++) {
      if (g[i] !== b[i]) throw new Error(`快照后第 ${i} 行与基准不同\n基准 ${JSON.stringify(b[i])}\n实际 ${JSON.stringify(g[i])}`)
    }

    // E2E-4：写快照之前清了屏 —— 断线前的旧内容不会被接在快照前面
    const text = got.join('\n')
    expect(count(text, 'OLD-SCREEN'), '快照之前的旧屏幕应当被清掉').toBe(0)
    expect(count(text, 'line 05000'), '同一段内容只该有一份').toBe(1)
    // E2E-4：回看位置回到底部
    expect((await hooks.viewport(page)).y, '快照之后回看位置应当回到底部').toBeGreaterThanOrEqual(got.length - rows)

    // 重连后新产生的输出完全正确
    await submit(page, "printf 'marker-%s\\n' xyz")
    await waitFor(
      async () => (await terminalText(page)).split('\n').some((l) => l.trimEnd() === 'marker-xyz'),
      '快照之后的输出仍然正确',
    )
  })
})

test.describe('E2E-3 断线期间的输入不丢', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test('断线期间敲的三条命令在重连后按序执行，不重不丢，in_ack 跨重连存活', async ({ page }) => {
    const net = await installWSControl(page)
    await agent.open(page)
    const sid = (await hooks.sid(page))!

    // 断开之前先有过输入：in_ack > 0 才验得出它没被清零（AC-2.12）
    await submit(page, "printf 'PRE-%s\\n' CUT")
    await waitText(page, 'PRE-CUT')
    await waitFor(async () => (await hooks.inputStats(page)).unackedBytes === 0, '断开前的输入都被 ack 了')

    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('重连中', { timeout: 20_000 })

    // 断线期间直接在终端里连打三条。输出是 `A1-OK`：命令回显里只有 `A%s-OK`，不会被误认成输出
    await submit(page, 'printf "A%s-OK\\n" 1')
    await submit(page, 'printf "A%s-OK\\n" 2')
    await submit(page, 'printf "A%s-OK\\n" 3')

    // 它们处于「待发送」：横幅还在、字节记在未 ack 里，而不是被静默吞掉
    await expect(page.getByTestId('conn-banner')).toBeVisible()
    const pending = (await hooks.inputStats(page)).unackedBytes
    expect(pending, '离线期间的输入应当挂在待发送队列里').toBeGreaterThan(0)

    net.goOnline()
    await waitOnline(page, 40_000)

    const w = (await lastWelcome(page))!
    const r = w.resumed.find((x) => x.sid === sid)
    expect(r, '重连应当续传当前会话').toBeTruthy()
    expect(r!.in_ack, 'in_ack 必须是断开前的累计值，不能归零（否则 input_gap）').toBeGreaterThan(0)

    await waitFor(async () => (await terminalText(page)).includes('A3-OK'), '三条都执行了', 30_000)
    // 【按子串找，不按整行比】：三条在重连后一批到达，bash 跑第一条时内核把后两条的预输入
    // 回显出来，readline 重画后输出行上会留下回显的零头（`A1p`、`inA1`），整行比就误报
    const out = await terminalText(page)
    const at = (s: string) => out.indexOf(s)
    // 顺序正确
    expect(at('A1-OK')).toBeGreaterThan(-1)
    expect(at('A1-OK')).toBeLessThan(at('A2-OK'))
    expect(at('A2-OK')).toBeLessThan(at('A3-OK'))
    // 不重复：每个标记只出现一次
    for (const m of ['A1-OK', 'A2-OK', 'A3-OK']) {
      expect(count(out, m), `${m} 输出了不止一次 —— 输入被重复写入了`).toBe(1)
    }
    await expect.poll(async () => (await hooks.inputStats(page)).unackedBytes, { message: '重发之后全部被 ack' }).toBe(0)
  })

  test('变体：断开期间提交超过 64 KiB 的输入 → 明确提示「离线输入已满」', async ({ page }) => {
    const net = await installWSControl(page)
    await agent.open(page)

    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('重连中', { timeout: 20_000 })

    // 70 KB 粘贴进终端（xterm 的 paste 事件 → onData 一次性送出）
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.term .xterm-helper-textarea')!
      ta.focus()
      const dt = new DataTransfer()
      dt.setData('text/plain', 'x'.repeat(70 * 1024))
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await expect(page.getByTestId('toast')).toContainText('离线输入已满')
  })
})
