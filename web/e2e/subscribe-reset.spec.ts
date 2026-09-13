/**
 * E2E-30 切走 → 积压超过 ring_bytes → 切回（AC-2.6 / AC-2.15）
 *
 * 这条补的是「切回」那半边。E2E-2c / E2E-4 走的是重连（welcome.resumed[].status），
 * 切回走 subscribe —— 另一条代码路径，之前没有覆盖，漏掉的正是"清屏"这一步：
 * 回放的内容与屏幕上留着的旧内容接不上，直接写就是往后叠一份，来回切几次叠几份。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

async function activeSid(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())
}

async function openSessions(page: Page) {
  const sidebar = page.getByTestId('sidebar')
  if (!(await sidebar.isVisible())) await page.getByTestId('statusbar').click()
  await expect(sidebar).toBeVisible()
}

interface Recorder {
  /** 发出去的控制消息，按顺序（解析过的 JSON）。 */
  ctl(): Promise<{ t: string; cols?: number; rows?: number }[]>
  /** 发出去的 INPUT 帧内容。 */
  input(): Promise<string[]>
  clear(): Promise<void>
}

/** 记录客户端发出去的东西：控制消息的顺序 + INPUT 帧。必须在 goto 之前装。 */
async function record(page: Page): Promise<Recorder> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ctl: unknown[]; __in: string[] }
    w.__ctl = []
    w.__in = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (data: unknown) {
      if (typeof data === 'string') {
        try {
          w.__ctl.push(JSON.parse(data))
        } catch {
          /* 不是 JSON 就不记 */
        }
      } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const b = data instanceof Uint8Array ? data : new Uint8Array(data)
        if (b[0] === 0x02) w.__in.push(new TextDecoder().decode(b.subarray(12)))
      }
      return orig.call(this, data as never)
    }
  })
  return {
    ctl: () =>
      page.evaluate(
        () => (window as unknown as { __ctl: { t: string; cols?: number; rows?: number }[] }).__ctl,
      ),
    input: () => page.evaluate(() => (window as unknown as { __in: string[] }).__in),
    clear: () =>
      page.evaluate(() => {
        const w = window as unknown as { __ctl: unknown[]; __in: string[] }
        w.__ctl = []
        w.__in = []
      }),
  }
}

const PAD = 'x'.repeat(60)

/**
 * 让会话在后台产出远超 ring_bytes 的内容，末尾放一个终端查询（CPR）。
 *
 * **先 sleep 3 秒再开始产出**：这几秒用来切到别的会话，保证整段输出都落在
 * 「未订阅」期间。不等的话 2500 行几百毫秒就打完了，客户端还订阅着，全收下来
 * 之后 out_seq 追平 head_seq，切回来根本走不到 reset 分支。
 *
 * 查询落在回放窗口的尾部：客户端若没把补课的字节标成回放，xterm 会自动应答，
 * 那串应答就被当成用户输入送进 PTY（AC-2.15）。
 * 完成信号走文件 —— 会话已经切走了，屏幕上看不到它跑完没有。
 */
function floodCmd(done: string): string {
  return `(sleep 3; for i in $(seq 1 2500); do printf 'pad %04d %s\\n' $i ${PAD}; done; printf '\\033[6n'; touch ${done}) &`
}

test.describe('E2E-30 切走 → 积压超过 ring_bytes → 切回', () => {
  let agent: Agent
  test.beforeEach(async () => {
    // 小环形缓冲，让 reset 路径可测
    agent = await Agent.start({ ringBytes: 65536 })
  })
  test.afterEach(() => agent.stop())

  test('切回时缓冲已被覆盖：清屏重建，而不是接在旧内容后面', async ({ page }) => {
    const rec = await record(page)
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    const sidA = await activeSid(page)
    expect(sidA).not.toBeNull()

    await submit(page, "printf 'MARK-%s\\n' ONE")
    await waitFor(async () => (await terminalText(page)).includes('MARK-ONE'), 'A 的标记出现')

    const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e30-'))
    const done1 = join(dir, 'round1')
    await submit(page, floodCmd(done1))

    // 新建 B 并切过去
    await openSessions(page)
    await page.getByTestId('new-session').click()
    await waitFor(async () => (await activeSid(page)) !== sidA, '切到了 B')

    await waitFor(() => Promise.resolve(existsSync(done1)), 'A 在后台把缓冲顶掉了好几轮', 60_000)

    // 切回 A
    await rec.clear()
    await openSessions(page)
    await page.getByTestId(`session-${sidA}`).click()
    await waitFor(async () => (await activeSid(page)) === sidA, '切回 A')
    await expect(page.getByTestId('truncated')).toBeVisible()

    // 尺寸必须【在 subscribe 这条消息里】，而不是单发一条 resize（协议 §4.1）：
    // 单发无论排前排后都有坑，见 session-ux.md §订阅策略
    const ctl = await rec.ctl()
    const sub = ctl.find((m) => m.t === 'subscribe')
    expect(sub, '切回时应当发 subscribe').toBeDefined()
    expect(sub!.cols, 'subscribe 要带上 cols').toBeGreaterThan(0)
    expect(sub!.rows, 'subscribe 要带上 rows').toBeGreaterThan(0)
    // 切走 / 切回本身会改布局（抽屉开合），之后来一条 resize 是正常的；
    // 要命的是【排在 subscribe 前面】那一条 —— 它会让全屏程序先重画一屏，
    // 那批字节落在 redraw.seq 之前被跳过（协议 §4.1）
    const iSub = ctl.findIndex((m) => m.t === 'subscribe')
    const iResize = ctl.findIndex((m) => m.t === 'resize')
    expect(
      iResize >= 0 && iResize < iSub,
      `resize 不能排在 subscribe 之前，实际顺序：${ctl.map((m) => m.t).join(' → ')}`,
    ).toBe(false)

    // 清屏发生了：MARK-ONE 早被裁出窗口，它还在就说明回放被接在了旧屏幕后面
    const after = await terminalText(page)
    expect(after, '旧屏幕没有被清掉 —— 每切回一次就叠一份').not.toContain('MARK-ONE')
    expect(after).toContain('pad 2500')

    // 补课的字节是回放：xterm 对历史里那个 CPR 查询的应答不能当成输入送进 PTY
    const sent = await rec.input()
    expect(
      sent.some((s) => /\x1b\[\d+;\d+R/.test(s)),
      '回放里的终端查询被自动应答并送进了 PTY —— 前台程序会收到一串乱码按键',
    ).toBe(false)

    // 第二轮：再切走、再顶掉一轮缓冲、再切回。屏幕是重建而不是追加，行数不该翻倍
    const lines1 = after.split('\n').length
    const done2 = join(dir, 'round2')
    await submit(page, floodCmd(done2))
    await openSessions(page)
    const sids = await page.getByTestId(/^session-\d+$/).all()
    for (const s of sids) {
      const id = await s.getAttribute('data-testid')
      if (id !== `session-${sidA}`) {
        await s.click()
        break
      }
    }
    await waitFor(async () => (await activeSid(page)) !== sidA, '又切走了')
    await waitFor(() => Promise.resolve(existsSync(done2)), '第二轮也顶掉了缓冲', 60_000)

    await openSessions(page)
    await page.getByTestId(`session-${sidA}`).click()
    await waitFor(async () => (await activeSid(page)) === sidA, '第二次切回 A')

    const lines2 = (await terminalText(page)).split('\n').length
    expect(
      Math.abs(lines2 - lines1),
      `两轮之后行数从 ${lines1} 变成 ${lines2} —— 每轮重建的话应当基本持平`,
    ).toBeLessThan(40)
  })

  test('积压没超过 ring_bytes：增量补齐，不清屏、不回声', async ({ page }) => {
    const rec = await record(page)
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    const sidA = await activeSid(page)
    await submit(page, "printf 'MARK-%s\\n' ONE")
    await waitFor(async () => (await terminalText(page)).includes('MARK-ONE'), 'A 的标记出现')

    // 这一轮刻意【不】顶掉缓冲：200 行 ≈ 14 KiB，远小于 64 KiB。
    // 走的是 status=ok 的增量补齐 —— 没有 ATTR_PREFIX，也就没有"这是重建"的信号，
    // 补课的字节要不要算回放【全靠客户端自己记 catchup_to】（协议 §5.2）
    const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e30b-'))
    const done = join(dir, 'small')
    await submit(
      page,
      `(sleep 3; for i in $(seq 1 200); do printf 'few %04d %s\\n' $i ${PAD}; done; printf '\\033[6n'; touch ${done}) &`,
    )

    await openSessions(page)
    await page.getByTestId('new-session').click()
    await waitFor(async () => (await activeSid(page)) !== sidA, '切到了 B')
    await waitFor(() => Promise.resolve(existsSync(done)), 'A 在后台产出了一小段', 60_000)

    await rec.clear()
    await openSessions(page)
    await page.getByTestId(`session-${sidA}`).click()
    await waitFor(async () => (await activeSid(page)) === sidA, '切回 A')
    await waitFor(async () => (await terminalText(page)).includes('few 0200'), '切走期间的输出补齐了')

    // 没有溢出就没有截断，屏幕是接着长的
    await expect(page.getByTestId('truncated')).toHaveCount(0)
    expect(await terminalText(page), '增量补齐不该清屏').toContain('MARK-ONE')

    // 补课的那一段里有个 CPR 查询。它是【历史】，不是程序此刻在问 ——
    // 客户端要按 catchup_to 把这段标成回放，抑制 xterm 的自动应答（AC-2.15）
    const sent = await rec.input()
    expect(
      sent.some((s) => /\x1b\[\d+;\d+R/.test(s)),
      '切回补课时回放了历史里的查询并把应答送进了 PTY —— 前台程序会收到乱码按键',
    ).toBe(false)
  })
})
