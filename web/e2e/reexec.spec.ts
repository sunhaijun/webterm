import { expect, test } from '@playwright/test'

import { Agent, lastWelcome, submit, terminalText, waitFor } from './harness'

/**
 * E2E-26 热升级不丢会话（ADR-0016，AC-2.14）。
 *
 * 真二进制收 SIGUSR2 → 预检 → 冻结 → 交接 → 原地 exec 同一个文件。浏览器这边
 * 只该看到一次普通的断线重连：instance_id 没变（resumed.status == ok），输出不丢
 * 不重，正在跑的 shell 还在原处。
 */
let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('输出中途热升级：只见一次重连，300 行不丢不重，shell 仍活着', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  const pid = agent.pid()

  // 一条持续 6 秒的输出；完成标记只在输出里出现，不在回显的命令行里
  await submit(page, 'for i in $(seq 1 300); do printf "LINE-%03d\\n" $i; sleep 0.02; done; printf "REEXEC-%s\\n" DONE')
  await waitFor(async () => (await terminalText(page)).includes('LINE-040'), '输出跑起来了')

  // 热升级
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
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 每一行恰好一次、顺序正确
  const text = await terminalText(page)
  const lines = text.match(/LINE-\d{3}/g) ?? []
  const uniq = new Set(lines)
  expect(uniq.size, `丢了 ${300 - uniq.size} 行`).toBe(300)
  expect(lines.length, `重了 ${lines.length - 300} 行`).toBe(300)
  for (let i = 0; i < 300; i++) {
    expect(lines[i]).toBe(`LINE-${String(i + 1).padStart(3, '0')}`)
  }

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
})
