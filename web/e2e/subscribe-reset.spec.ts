/**
 * E2E-30 切走 → 积压超过 ring_bytes → 切回 —— AC-2.6 / AC-2.15。
 *
 * E2E-2c / E2E-4 走的是重连（welcome.resumed[].status），这条走切回（subscribe），
 * 是另一条代码路径。用 `--ring-bytes 65536` 的实例。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import {
  Agent,
  count,
  framesSince,
  hooks,
  newSession,
  recordSent,
  submit,
  switchTo,
  terminalText,
  waitFor,
  waitSnapshot,
  waitText,
  type SentRecorder,
} from './harness'

const PAD = 'x'.repeat(60)

/**
 * 后台产出 `lines` 行（每行约 70 B），末尾一个终端查询（CPR），完成信号走文件。
 *
 * **先 sleep 3 秒再开始**：这几秒用来切到别的会话，保证整段输出都落在「未订阅」期间。
 * 查询落在补课 / 快照的尾部：客户端若没把它标成回放，xterm 会自动应答，
 * 那串应答就被当成用户输入送进 PTY（AC-2.15）。
 */
function floodCmd(tag: string, lines: number, done: string): string {
  return `(sleep 3; for i in $(seq 1 ${lines}); do printf '${tag} %04d %s\\n' $i ${PAD}; done; printf '\\033[6n'; touch ${done}) &`
}

const cprSent = async (rec: SentRecorder) => (await rec.input()).some((s) => /\x1b\[\d+;\d+R/.test(s))

/** 切回时客户端发了什么：subscribe 自带尺寸，且没有 resize 排在它前面。 */
async function assertSubscribeCarriesSize(rec: SentRecorder, sid: number) {
  const ctl = await rec.ctl()
  const iSub = ctl.findIndex((m) => m.t === 'subscribe' && m.sid === sid)
  expect(iSub, `切回时应当发 subscribe：${ctl.map((m) => m.t).join(' → ')}`).toBeGreaterThanOrEqual(0)
  const sub = ctl[iSub] as { cols?: number; rows?: number }
  expect(sub.cols, 'subscribe 要带上 cols').toBeGreaterThan(0)
  expect(sub.rows, 'subscribe 要带上 rows').toBeGreaterThan(0)
  const iResize = ctl.findIndex((m) => m.t === 'resize')
  expect(iResize >= 0 && iResize < iSub, `resize 不能排在 subscribe 之前：${ctl.map((m) => m.t).join(' → ')}`).toBe(false)
}

async function setup(page: Page, agent: Agent) {
  await agent.open(page)
  const a = (await hooks.sid(page))!
  await submit(page, "printf 'MARK-%s\\n' ONE")
  await waitText(page, /^MARK-ONE$/m, 'A 的标记出现')
  return a
}

test.describe('E2E-30 切走 → 积压 → 切回（ring 64 KiB）', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ ringBytes: 65536 })
  })
  test.afterEach(() => agent.stop())

  test('① 积压超过 ring_bytes → 快照：清屏重建，不接在旧屏幕后面，不回声', async ({ page }) => {
    test.setTimeout(150_000)
    const rec = await recordSent(page)
    const a = await setup(page, agent)
    const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e30-'))

    // 2500 行 × 70 B ≈ 175 KiB，远超 64 KiB
    const done1 = join(dir, 'round1')
    await submit(page, floodCmd('pad', 2500, done1))
    const b = await newSession(page)
    await waitFor(() => existsSync(done1), 'A 在后台把缓冲顶掉了好几轮', 60_000)

    await rec.clear()
    const read = await framesSince(page)
    await switchTo(page, a)
    await assertSubscribeCarriesSize(rec, a)

    // 收到的是 SNAPSHOT，不是从旧位置接着的 OUTPUT
    await waitSnapshot(read, a, '切回走快照')
    const first = (await read()).find((f) => f.sid === a)!
    expect(first.kind, '切回后 A 的第一帧应当是 SNAPSHOT').toBe('SNAPSHOT')
    await waitText(page, 'pad 2500')
    await page.waitForTimeout(500)

    // 清屏发生了：MARK-ONE 早已超出快照的 2000 行，它还在就说明快照被接在了旧屏幕后面
    const after = await terminalText(page)
    expect(count(after, 'MARK-ONE'), '旧屏幕没有被清掉 —— 快照被接在了旧内容后面').toBe(0)
    expect(count(after, 'pad 2500 '), '同一段内容只有一份').toBe(1)
    // 快照里那个 CPR 查询是历史：xterm 的应答不能当输入送进 PTY
    expect(await cprSent(rec), '回放里的终端查询被自动应答并送进了 PTY').toBe(false)

    // 第二轮：再切走、再顶掉一轮、再切回 —— 每轮都是重建，不是往后追加
    const lines1 = after.split('\n').length
    const done2 = join(dir, 'round2')
    await submit(page, floodCmd('pad', 2500, done2))
    await switchTo(page, b)
    await waitFor(() => existsSync(done2), '第二轮也顶掉了缓冲', 60_000)
    const read2 = await framesSince(page)
    await switchTo(page, a)
    await waitSnapshot(read2, a, '第二轮切回也走快照')
    await page.waitForTimeout(500)
    const lines2 = (await terminalText(page)).split('\n').length
    const { rows } = await hooks.size(page)
    expect(Math.abs(lines2 - lines1), `两轮之后行数从 ${lines1} 变成 ${lines2} —— 差了不止一屏`).toBeLessThan(rows)
  })

  test('② 积压没超过 ring_bytes → 增量补齐：不清屏、补齐、不回声', async ({ page }) => {
    const rec = await recordSent(page)
    const a = await setup(page, agent)
    const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e30b-'))

    // 200 行 ≈ 14 KiB，远小于 64 KiB：走增量。增量路径上没有任何线上信号说"这段是历史"，
    // 要不要算回放全靠客户端自己记 catchup_to（协议 §5.3）
    const done = join(dir, 'small')
    await submit(page, floodCmd('few', 200, done))
    await newSession(page)
    await waitFor(() => existsSync(done), 'A 在后台产出了一小段', 60_000)

    await rec.clear()
    const read = await framesSince(page)
    await switchTo(page, a)
    await assertSubscribeCarriesSize(rec, a)
    await waitText(page, 'few 0200', '切走期间的输出补齐了')
    await page.waitForTimeout(500)

    const fs = (await read()).filter((f) => f.sid === a)
    expect(fs.length).toBeGreaterThan(0)
    expect(fs.every((f) => f.kind === 'OUTPUT'), '增量补齐：只有 OUTPUT，没有 SNAPSHOT').toBe(true)
    expect(count(await terminalText(page), 'MARK-ONE'), '增量补齐不该清屏').toBeGreaterThan(0)
    expect(await cprSent(rec), '切回补课时回放了历史里的查询并把应答送进了 PTY').toBe(false)
  })
})
