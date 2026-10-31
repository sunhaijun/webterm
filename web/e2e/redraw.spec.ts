/**
 * E2E-31 备用屏会话切回 = 当前屏 —— AC-2.6 / AC-2.11 / AC-2.15 / AC-2.21（ADR-0026）。
 *
 * 字节窗口拼不出备用屏程序的当前屏，快照可以：模拟器手里就是那一屏。
 * 用 `--ring-bytes 65536` 的实例；夹具 `fixtures/altscreen.sh` 是对齐实测 claude 的假 TUI。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

import {
  ALTSCREEN,
  Agent,
  count,
  focusTerm,
  framesSince,
  hooks,
  newSession,
  submit,
  switchTo,
  terminalText,
  waitFor,
  waitSnapshot,
  waitText,
} from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start({ ringBytes: 65536 })
})
test.afterEach(() => agent.stop())

test('E2E-31 备用屏会话切回走快照：一屏 KB 量级、回到备用屏、界面只有一份、不改尺寸；退出后主屏无残影', async ({ page }) => {
  test.setTimeout(150_000)
  await agent.open(page)
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e31-'))
  const busy = join(dir, 'busy')

  // ① A 里跑假 TUI：快跑 5 秒（约 30 KB/s，把 64 KiB 的窗口顶掉好几轮），然后空闲
  const a = (await hooks.sid(page))!
  await submit(page, `${ALTSCREEN} 5 ${busy}`)
  await waitText(page, 'FRAME', '假 TUI 画出第一屏')
  expect(await hooks.altScreen(page), '假 TUI 应当进了备用屏').toBe(true)

  // ② 切到 B，等 A 顶过窗口并转入空闲
  const b = await newSession(page)
  await waitFor(() => existsSync(busy), 'A 顶掉了窗口并转入空闲', 60_000)
  await page.waitForTimeout(300)

  // ③ 切回 A
  const read = await framesSince(page)
  await switchTo(page, a)
  const snap = await waitSnapshot(read, a, '切回走快照')
  const bytes = snap.reduce((n, f) => n + f.bytes, 0)
  expect(bytes, `快照 ${bytes} 字节：当前屏是 KB 量级，不是整个 ring_bytes`).toBeLessThan(8 * 1024)
  await waitFor(() => hooks.altScreen(page), '快照把客户端带回了备用屏')
  await waitText(page, 'FRAME')
  await page.waitForTimeout(500)
  const text = await terminalText(page)
  expect(count(text, 'FRAME'), '屏幕上只有一份界面').toBe(1)
  // scrollback（主屏缓冲）里没有这个程序界面的任何副本：序列化结果包含主屏缓冲 + 备用屏，
  // 界面只该在备用屏里出现一次
  const ser = await hooks.serialize(page)
  expect(count(ser, 'FRAME'), '主屏缓冲里有假 TUI 界面的副本').toBe(1)
  expect(count(ser, 'row 05 '), '界面的内容行只有一份').toBe(1)
  // 切回时 agent 没改窗口尺寸：没有 SIGWINCH，FRAME 计数还是 000
  expect(text, '切回不该触发 SIGWINCH 整屏重画').toContain('FRAME 000')

  // ④ 让假 TUI 退出（SIGINT → ESC[?1049l 回主屏），A 再积压一轮超过窗口，切走 / 切回
  await focusTerm(page)
  await page.keyboard.press('Control+c')
  await waitFor(async () => !(await hooks.altScreen(page)), '假 TUI 退出，回到主屏')
  const flood = join(dir, 'flood')
  await submit(page, `(sleep 3; for i in $(seq 1 2500); do printf 'pad %04d %s\\n' $i ${'x'.repeat(60)}; done; touch ${flood}) &`)
  await switchTo(page, b)
  await waitFor(() => existsSync(flood), '主屏积压顶掉了窗口', 60_000)
  const read2 = await framesSince(page)
  await switchTo(page, a)
  await waitSnapshot(read2, a, '退出之后切回仍走快照')
  await waitText(page, 'pad 2500')
  await page.waitForTimeout(300)
  expect(await hooks.altScreen(page), '主屏').toBe(false)
  const main = await terminalText(page)
  expect(count(main, 'FRAME'), '主屏没有假 TUI 的残影').toBe(0)
  expect(count(main, 'tick 0'), '主屏没有假 TUI 的内容行').toBe(0)
})
