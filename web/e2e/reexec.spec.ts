/**
 * E2E-26 热升级不丢会话 —— AC-2.14（ADR-0016 / ADR-0026 §8）。
 *
 * 真二进制收 SIGUSR2 → 预检 → 冻结 → 交接 → 原地 exec 同一个文件。浏览器这边
 * 只该看到一次普通的断线重连：instance_id 没变（resumed.status == ok），输出不丢
 * 不重，正在跑的 shell 还在原处；模拟器状态也交接了 —— 升级前后新开的标签页走快照，
 * 看到的终端逐行一致。预检失败路径留给 Go 集成测试（IT-handoff-1）。
 */
import { expect, test, type BrowserContext } from '@playwright/test'

import { Agent, hooks, lastWelcome, serialize, submit, terminalText, waitFor, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** 新开一个标签页（同一个 context，Cookie 共享；out_seq == 0 → 走快照），取它的序列化结果。 */
async function freshTabSerialize(ctx: BrowserContext, url: string): Promise<string> {
  const p = await ctx.newPage()
  await p.goto(url)
  await waitOnline(p)
  await waitFor(async () => (await hooks.sid(p)) !== null, '新标签页选中了会话')
  await waitFor(async () => (await hooks.frames(p)).some((f) => f.kind === 'SNAPSHOT' && (f.flags & 1) === 0), '新标签页收到快照')
  await p.waitForTimeout(300) // 等 xterm 把快照解析完
  const s = await serialize(p)
  await p.close()
  return s
}

async function generation(): Promise<number> {
  const r = await agent.reloadProbe()
  expect(r.code, `webterm reload --probe 应当返回 0：${r.out}`).toBe(0)
  const m = r.out.match(/generation=(\d+)/)
  expect(m, r.out).toBeTruthy()
  return Number(m![1])
}

test('E2E-26 输出中途热升级：只见一次重连，300 行不丢不重，shell 仍活着，模拟器状态交接', async ({ page }) => {
  await agent.open(page)
  const pid = agent.pid()
  expect(await generation()).toBe(0)

  // 一条持续 6 秒的输出；完成标记只在输出里出现，不在回显的命令行里
  await submit(page, 'for i in $(seq 1 300); do printf "LINE-%03d\\n" $i; sleep 0.02; done; printf "REEXEC-%s\\n" DONE')
  await waitFor(async () => (await terminalText(page)).includes('LINE-040'), '输出跑起来了')

  // 热升级：盯着连接状态，记下离开「在线」的那几次
  const seen: string[] = []
  const watcher = (async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < 8_000) {
      const txt = await page.getByTestId('conn-text').textContent().catch(() => null)
      if (txt && txt !== '在线' && !seen.includes(txt)) seen.push(txt)
      await page.waitForTimeout(50)
    }
  })()
  agent.reexec()
  await waitFor(async () => (await terminalText(page)).includes('REEXEC-DONE'), '热升级后命令跑完', 20_000)
  await watcher
  await waitOnline(page)

  // 每一行恰好一次、顺序正确
  const text = await terminalText(page)
  const lines = text.match(/^LINE-\d{3}$/gm) ?? []
  const uniq = new Set(lines)
  expect(uniq.size, `丢了 ${300 - uniq.size} 行`).toBe(300)
  expect(lines.length, `重了 ${lines.length - 300} 行`).toBe(300)
  for (let i = 0; i < 300; i++) expect(lines[i]).toBe(`LINE-${String(i + 1).padStart(3, '0')}`)

  // 客户端只经历了普通重连：instance_id 没变 → 续传是 ok 不是 gone
  const w = await lastWelcome(page)
  expect(w, '重连后应当有新的 welcome').not.toBeNull()
  expect(w!.resumed.length).toBeGreaterThan(0)
  expect(w!.resumed[0]!.status, `resumed=${JSON.stringify(w!.resumed)}`).toBe('ok')
  expect(seen.length, '中途应当短暂离开「在线」再回来').toBeGreaterThan(0)

  // shell 还活着、PID 不变、新进程报第 1 代
  await submit(page, 'printf "ALIVE-%s\\n" AFTER')
  await waitFor(async () => (await terminalText(page)).includes('ALIVE-AFTER'), '交接后 shell 仍可用')
  expect(agent.pid()).toBe(pid)
  expect(agent.logs()).toContain('热升级完成')
  expect(await generation()).toBe(1)

  // ⑤ 模拟器状态交接了：会话静止时，升级前后各开一个新标签页（走快照），两份逐行一致
  await page.waitForTimeout(500)
  const before = await freshTabSerialize(page.context(), agent.baseURL)
  expect(before).toContain('ALIVE-AFTER')
  agent.reexec()
  await waitFor(async () => (await agent.reloadProbe()).out.includes('generation=2'), '第二次热升级完成', 30_000)
  await waitOnline(page)
  const after = await freshTabSerialize(page.context(), agent.baseURL)
  const a = before.split('\n')
  const b = after.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) throw new Error(`升级前后的快照第 ${i} 行不同\n前 ${JSON.stringify(a[i])}\n后 ${JSON.stringify(b[i])}`)
  }
})
