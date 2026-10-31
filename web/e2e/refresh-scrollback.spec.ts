/**
 * E2E-36 刷新之后仍能往回拖 —— AC-5.14 / AC-2.6 / AC-2.13（ADR-0026）。
 *
 * 默认 `--ring-bytes`。刷新把浏览器的状态清空（out_seq 回到 0），订阅一律走快照：
 * agent 从模拟器里导出当前屏 + 至多 2000 行历史。浏览器不存任何本地快照。
 *
 * emit.sh 的每行是 `line NNNNN …`，147 列宽 —— 用 1440×900 保证一行不折，
 * 「最后 2000 行」才正好落在第 1000 行之后。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import {
  ALTSCREEN,
  Agent,
  EMIT,
  count,
  hooks,
  newSession,
  submit,
  switchTo,
  terminalText,
  waitFor,
  waitOnline,
  waitSnapshot,
  waitText,
} from './harness'

test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } })

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** reload 之后等快照写完。 */
async function reloadAndSnapshot(page: Page, sid: number) {
  await page.reload()
  await waitOnline(page)
  await waitFor(async () => (await hooks.sid(page)) !== null, '刷新后选中了会话')
  if ((await hooks.sid(page)) !== sid) await switchTo(page, sid)
  await waitFor(async () => (await hooks.frames(page)).some((f) => f.sid === sid && f.kind === 'SNAPSHOT' && (f.flags & 1) === 0), '刷新后走快照')
  await page.waitForTimeout(500)
}

test('E2E-36 刷新后能滚回最后 2000 行、只有一份、接得上；备用屏会话是当前屏；agent 重启则没有旧会话', async ({ page }) => {
  test.setTimeout(150_000)
  await agent.open(page)
  const a = (await hooks.sid(page))!
  expect((await hooks.size(page)).cols, '一行 emit 不折行').toBeGreaterThanOrEqual(147)

  // ①
  await submit(page, `${EMIT} 3000 0`)
  await waitText(page, 'EMIT-DONE', '输出跑完', 60_000)

  // ② 刷新：out_seq == 0 → 快照
  await reloadAndSnapshot(page, a)
  expect((await hooks.frames(page)).find((f) => f.sid === a)?.kind, '刷新后的第一帧是 SNAPSHOT').toBe('SNAPSHOT')

  // ③④ 能滚回去、只有一份
  const ser = await hooks.serialize(page)
  expect(ser, '最后 2000 行之内的内容还在').toContain('line 01500')
  expect(ser, '超出 2000 行的不在').not.toContain('line 00100')
  const text = await terminalText(page)
  expect(count(text, 'line 01500 '), '只有一份').toBe(1)
  expect(count(text, 'EMIT-DONE')).toBe(1)

  // ⑤ 接得上：再跑一条，前面的内容不重排
  const before = text.split('\n')
  await submit(page, "printf 'AFTER-%s\\n' RELOAD")
  await waitText(page, /^AFTER-RELOAD$/m)
  const after = (await terminalText(page)).split('\n')
  const keep = before.length - 1 // 最后一行是提示符，命令敲在它上面
  expect(after.slice(0, keep), '刷新后接着的输出不该让前面的内容重排').toEqual(before.slice(0, keep))

  // ⑦ 备用屏会话刷新后是当前屏：FRAME 只出现一次，scrollback 里没有界面的副本
  const b = await newSession(page)
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e36-'))
  await submit(page, `${ALTSCREEN} 1 ${join(dir, 'busy')}`)
  await waitText(page, 'FRAME', '假 TUI 画出第一屏')
  await page.waitForTimeout(1500)
  await reloadAndSnapshot(page, b)
  expect(await hooks.altScreen(page), '刷新后回到备用屏').toBe(true)
  expect(count(await terminalText(page), 'FRAME'), '当前屏上界面只有一份').toBe(1)
  expect(count(await hooks.serialize(page), 'FRAME'), '主屏缓冲里没有界面的副本').toBe(1)

  // ⑥ agent 重启：instance_id 变，会话全部销毁 —— 刷新后新建的会话里不出现任何旧输出
  const oldInstance = (await hooks.welcome(page))!.instance_id
  await agent.restart()
  await page.reload()
  await waitOnline(page)
  await waitFor(async () => (await hooks.sid(page)) !== null, '刷新后自动建了新会话')
  expect((await hooks.welcome(page))!.instance_id).not.toBe(oldInstance)
  const sid = (await hooks.sid(page))!
  await waitSnapshot(() => hooks.frames(page), sid, '新会话的第一屏')
  await page.waitForTimeout(800)
  const fresh = await terminalText(page)
  expect(fresh, '旧会话的输出不该出现').not.toContain('line 0')
  expect(fresh).not.toContain('EMIT-DONE')
  expect(fresh).not.toContain('FRAME')
})
