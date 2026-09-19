/**
 * E2E-2 断线续传 ★ 核心 —— AC-2.1 / AC-2.2 / AC-2.3 / AC-2.5。
 *
 * 它不测"重连能不能连上"（那太弱），而是测【最终屏幕状态是否与从未断线时
 * 完全一致】。任何 seq 记账错误、切片偏移、重复回放、丢帧，都会让两次结果
 * 不同。这是"永不断线"这个承诺的机械化证据。
 */
import { expect, test, type Page } from '@playwright/test'

import {
  Agent,
  installWSControl,
  lastWelcome,
  serialize,
  submit,
  terminalText,
  waitFor,
} from './harness'

const EMIT = 'bash e2e/fixtures/emit.sh'

/** 断开 WebSocket。默认走路由层切断 —— 最贴近真实的网络中断。 */
async function cutWebSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __webtermSockets?: WebSocket[] }
    void w
    // 直接关掉页面持有的那条 socket
    const ws = (window as unknown as { __webterm?: unknown }).__webterm
    void ws
  })
  // Playwright 的 routeWebSocket 需要在导航前装，这里用 CDP 制造真实断开
  const client = await page.context().newCDPSession(page)
  await client.send('Network.enable')
  await client.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  })
  await page.waitForTimeout(150)
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  await client.detach()
}

/** 等输出彻底停下来，给两轮一个确定的截止点。 */
async function waitQuiet(page: Page, quietMs = 700): Promise<void> {
  let last = -1
  let stableSince = Date.now()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const n = (await terminalText(page)).length
    if (n !== last) {
      last = n
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= quietMs) {
      return
    }
    await page.waitForTimeout(50)
  }
  throw new Error('超时等待：输出静默')
}

async function runEmit(page: Page, lines: number, cuts: number): Promise<string> {
  await submit(page, `cd ${process.cwd()} && ${EMIT} ${lines} 2`)
  // 等输出真的开始（EMIT-DONE 只出现在输出里，不会被命令回显误触发）
  await waitFor(async () => (await terminalText(page)).includes('line 00005'), '输出开始')

  for (let i = 0; i < cuts; i++) {
    await page.waitForTimeout(120)
    await cutWebSocket(page)
    await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 30_000 })
  }

  await waitFor(async () => (await terminalText(page)).includes('EMIT-DONE'), '输出跑完', 90_000)
  await waitQuiet(page)
  // 【只比对输出本体，不含 shell 提示符】。每一轮用新会话拿干净屏幕，而新会话继承
  // 当前会话的 cwd —— 提示符里的路径本来就不同，把它算进来就是拿无关差异当失败。
  // AC-2.1 要的是【输出字节流】的连续性，emit.sh 的内容（颜色 / CJK / 超长行）已经
  // 把折行与属性都覆盖到了。
  const full = await serialize(page)
  const from = full.indexOf('line 00001')
  const to = full.lastIndexOf('EMIT-DONE')
  if (from < 0 || to < 0) throw new Error(`序列化结果里找不到输出区间：from=${from} to=${to}`)
  return full.slice(from, to + 'EMIT-DONE'.length)
}

test.describe('E2E-2 字节级连续性', () => {
  let agent: Agent
  test.beforeEach(async () => {
    // 默认 ring（1 MiB）—— 断线窗口内的输出不会溢出，字节级比较才稳定。
    // reset 路径由 E2E-2c 用一个单独的小 ring 实例来测。
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test('E2E-2a/2b/2d 断开若干次后屏幕与从未断线时逐字节一致', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    const baseline = await runEmit(page, 300, 0)
    expect(baseline.length, '基准输出太少，测不出东西').toBeGreaterThan(4096)

    for (const cuts of [1, 3]) {
      // 【每一轮换一个新会话拿干净屏幕，不要用 page.reload()】。
      //
      // 原来这里是刷新。刷新之后客户端会以 out_seq=0 重新订阅，agent 把整个环形
      // 缓冲全量回放一遍 —— 上一轮的 300 行原样回到屏幕上，于是 runEmit 等的
      // `line 00005` 与 `EMIT-DONE` 在命令还没跑之前就已经满足，它立刻拿【回放】
      // 当结果去比，自然逐字节相同。**断线那部分根本没跑到，这条红线是假绿的**
      //（2026-09-19 发现：修好"刷新后输入被当成重发丢掉"之后，第二条命令真的执行
      // 了，屏幕上变成两份，比较才失败 —— 假绿这才暴露出来）。
      const prev = await page.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())
      await page.keyboard.press('Control+Shift+Enter')
      await waitFor(
        async () => (await page.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())) !== prev,
        '切到了新会话（屏幕是干净的）',
        15_000,
      )
      const got = await runEmit(page, 300, cuts)

      if (got !== baseline) {
        let i = 0
        while (i < got.length && i < baseline.length && got[i] === baseline[i]) i++
        throw new Error(
          `断开 ${cuts} 次后字节级连续性被破坏：第 ${i} 字节起分歧\n` +
            `基准长度 ${baseline.length}，实际长度 ${got.length}\n` +
            `基准 …${JSON.stringify(baseline.slice(Math.max(0, i - 40), i + 40))}\n` +
            `实际 …${JSON.stringify(got.slice(Math.max(0, i - 40), i + 40))}`,
        )
      }
    }
  })

  /** E2E-3：断线期间提交的输入不丢、不重、顺序正确（AC-2.4）。 */
  test('E2E-3 断线期间的输入在重连后按序执行', async ({ page }) => {
    await agent.pair(page)
    const net = await installWSControl(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('重连中', { timeout: 20_000 })

    // 断线期间连打三条
    await submit(page, 'printf "A%s\\n" 1')
    await submit(page, 'printf "A%s\\n" 2')
    await submit(page, 'printf "A%s\\n" 3')

    net.goOnline()
    await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 40_000 })

    await waitFor(async () => (await terminalText(page)).includes('A3'), '三条都执行了', 30_000)
    const text = await terminalText(page)
    // 顺序正确
    expect(text.indexOf('A1')).toBeLessThan(text.indexOf('A2'))
    expect(text.indexOf('A2')).toBeLessThan(text.indexOf('A3'))
    // 不重复：每个标记在输出里只应出现一次（另一次是命令回显）
    for (const marker of ['A1', 'A2', 'A3']) {
      const count = text.split(marker).length - 1
      expect(count, `${marker} 出现了 ${count} 次，输入被重复写入了`).toBeLessThanOrEqual(2)
    }
  })
})

/** E2E-2c / E2E-4：缓冲被覆盖走 reset 路径（AC-2.6）。 */
test.describe('E2E-2c 缓冲溢出', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ ringBytes: 64 * 1024 }) // 调小，让 reset 可测
  })
  test.afterEach(() => agent.stop())

  test('断开期间输出超过 ring_bytes → 清屏 + 截断提示 + 后续输出正确', async ({ page }) => {
    await agent.pair(page)
    const net = await installWSControl(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    // 每行 2ms，让输出【跨越】整个断线窗口。
    // 不加延迟的话几千行可能在我把线掐掉之前就全送到客户端了 ——
    // 那样根本不会溢出，测的就不是 reset 路径。
    // 【直接发，不走 submit 的"发完切回终端"】—— 那一步（点 ✎▸终端）在 EMIT 刷屏时
    // 可能拖到 EMIT 快跑完才断线，导致断线窗口里几乎没有新输出、不溢出（慢机上偶发）。
    // 这里发完就停在编辑面板、立刻断线；2000 行 × 2ms ≈ 4s，断线 5s 里产出稳超 64 KiB ring。
    const toEdit = page.getByTestId('to-edit')
    if (await toEdit.count()) await toEdit.click()
    await page.getByTestId('composer').fill(`cd ${process.cwd()} && ${EMIT} 2000 2`)
    await page.getByTestId('composer').press('Enter')
    await waitFor(async () => (await terminalText(page)).includes('line 00005'), '输出开始')

    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('重连中', { timeout: 20_000 })
    // 断线期间产出远超 64 KiB 的 ring
    await page.waitForTimeout(5000)

    net.goOnline()
    await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 40_000 })

    // 直接断言协议层的结论，而不是从 UI 反推
    await waitFor(async () => {
      const w = await lastWelcome(page)
      return w?.resumed.some((r) => r.status === 'reset') ?? false
    }, 'welcome.resumed[].status === "reset"', 30_000)

    // 明确告诉用户历史被截断了，而不是让他拿着一屏东西猜发生了什么
    await expect(page.getByTestId('truncated')).toBeVisible({ timeout: 30_000 })

    // 等 EMIT 跑完（最后一行出现 = 回到提示符），再敲下一条命令
    await waitFor(async () => (await terminalText(page)).includes('line 02000'), 'EMIT 跑完回到提示符', 60_000)

    // 关键：截断【之后】的内容必须完全正确
    await submit(page, 'printf "AFTER-%s\\n" RESET')
    await waitFor(
      async () => (await terminalText(page)).includes('AFTER-RESET'),
      'reset 之后的输出仍然正确',
      30_000,
    )
  })
})
