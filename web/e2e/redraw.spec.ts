/**
 * E2E-31 备用屏会话切回 = 重画（AC-2.16 / AC-2.17，ADR-0019）
 *
 * E2E-30 测的是主屏那条路（字节回放）。这条测备用屏：**不回放窗口**，
 * 改成清屏 + 恢复粘性模式 + 逼程序自己整屏重画。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

// 会话默认起在 $HOME，夹具路径要自己 cd 过去（同 continuity.spec.ts）。
// 夹具快跑 5 秒把窗口顶掉好几轮，然后转入空闲 —— 空闲之后切回来，量到的字节
// 才只是"重建这一屏"的成本（AC-2.17）。
const tui = (done: string) => `cd ${process.cwd()} && bash e2e/fixtures/altscreen.sh 5 ${done}`

async function activeSid(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())
}

async function altScreen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __webterm: { altScreen(): boolean } }).__webterm.altScreen())
}

async function openSessions(page: Page) {
  const sidebar = page.getByTestId('sidebar')
  if (!(await sidebar.isVisible())) await page.getByTestId('statusbar').click()
  await expect(sidebar).toBeVisible()
}

interface Tap {
  /** 收到的控制消息类型，按顺序。 */
  rx(): Promise<string[]>
  /** 收到的 OUTPUT 字节数。 */
  bytes(): Promise<number>
  /** 收到过几帧带 ATTR_PREFIX 的（= 字节回放的重建帧）。 */
  attrFrames(): Promise<number>
  reset(): Promise<void>
}

/** 监听【收到】的东西。必须在 goto 之前装。 */
async function tap(page: Page): Promise<Tap> {
  await page.addInitScript(() => {
    const w = window as unknown as { __rx: string[]; __bytes: number; __attr: number }
    w.__rx = []
    w.__bytes = 0
    w.__attr = 0
    const Orig = window.WebSocket
    class Tapped extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        this.addEventListener('message', (ev: MessageEvent) => {
          if (typeof ev.data === 'string') {
            try {
              w.__rx.push(String((JSON.parse(ev.data) as { t: string }).t))
            } catch {
              /* 不是 JSON 就不记 */
            }
          } else if (ev.data instanceof ArrayBuffer) {
            const b = new Uint8Array(ev.data)
            w.__bytes += b.length
            if ((b[1] ?? 0) & 1) w.__attr += 1
          }
        })
      }
    }
    window.WebSocket = Tapped as unknown as typeof WebSocket
  })
  return {
    rx: () => page.evaluate(() => (window as unknown as { __rx: string[] }).__rx),
    bytes: () => page.evaluate(() => (window as unknown as { __bytes: number }).__bytes),
    attrFrames: () => page.evaluate(() => (window as unknown as { __attr: number }).__attr),
    reset: () =>
      page.evaluate(() => {
        const w = window as unknown as { __rx: string[]; __bytes: number; __attr: number }
        w.__rx = []
        w.__bytes = 0
        w.__attr = 0
      }),
  }
}

/** 切到另一个会话（列表里第一个不是 sid 的）。 */
async function switchAway(page: Page, sid: number) {
  await openSessions(page)
  for (const item of await page.getByTestId(/^session-\d+$/).all()) {
    if ((await item.getAttribute('data-testid')) !== `session-${sid}`) {
      await item.click()
      break
    }
  }
  await waitFor(async () => (await activeSid(page)) !== sid, '切走了')
}

async function switchBack(page: Page, sid: number) {
  await openSessions(page)
  await page.getByTestId(`session-${sid}`).click()
  await waitFor(async () => (await activeSid(page)) === sid, `切回 ${sid}`)
}

test.describe('E2E-31 备用屏会话切回 = 重画', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ ringBytes: 65536 })
  })
  test.afterEach(() => agent.stop())

  test('切回不回放窗口：清屏 + 恢复模式 + 程序自己重画', async ({ page }) => {
    const rx = await tap(page)
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e31a-'))
    const busyDone = join(dir, 'busy')
    const sidA = (await activeSid(page))!
    await submit(page, tui(busyDone))
    await waitFor(async () => (await terminalText(page)).includes('FRAME'), '假 TUI 画出第一屏')
    expect(await altScreen(page), '假 TUI 应当进了备用屏').toBe(true)

    // 新建 B 切过去，让 A 在后台把 64 KiB 的窗口顶掉好几轮
    await openSessions(page)
    await page.getByTestId('new-session').click()
    await waitFor(async () => (await activeSid(page)) !== sidA, '切到了 B')
    await waitFor(() => Promise.resolve(existsSync(busyDone)), 'A 顶掉了窗口并转入空闲', 60_000)
    await page.waitForTimeout(300)

    await rx.reset()
    await switchBack(page, sidA)

    // 走的是 redraw，不是字节回放
    await waitFor(async () => (await rx.rx()).includes('redraw'), '收到 redraw 消息')
    expect(await rx.attrFrames(), '备用屏会话不该收到 ATTR_PREFIX 回放帧').toBe(0)
    expect((await rx.rx()).includes('reset'), '备用屏会话不该收到 reset 通知').toBe(false)

    // 备用屏没有历史，那条提示是误导
    await expect(page.getByTestId('truncated')).toHaveCount(0)

    // 模式前缀确实把客户端带回了备用屏
    await waitFor(async () => altScreen(page), '客户端回到备用屏')

    // 程序被逼着整屏重画，屏幕上是【当前】那一帧，没有旧帧的副本
    await waitFor(async () => (await terminalText(page)).includes('FRAME'), '重画到达')
    const text = await terminalText(page)
    expect((text.match(/FRAME/g) ?? []).length, '屏幕上只该有一份界面').toBe(1)

    // AC-2.17：这条路传的是一屏，不是整个 ring_bytes
    const bytes = await rx.bytes()
    expect(bytes, `切回传了 ${bytes} 字节，应当远小于 64 KiB 的窗口`).toBeLessThan(8 * 1024)
  })

  test('程序退出备用屏之后，切回自动回到字节回放那条路', async ({ page }) => {
    const rx = await tap(page)
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e31b-'))
    const sidA = (await activeSid(page))!
    await submit(page, tui(join(dir, 'busy')))
    await waitFor(async () => (await terminalText(page)).includes('FRAME'), '假 TUI 画出第一屏')

    // 从 B 里把它打断：夹具收到 INT 会发 ESC[?1049l 退回主屏
    await openSessions(page)
    await page.getByTestId('new-session').click()
    await waitFor(async () => (await activeSid(page)) !== sidA, '切到了 B')
    await submit(page, 'pkill -INT -f altscreen.sh')
    await page.waitForTimeout(1000)

    await switchBack(page, sidA)
    await waitFor(async () => !(await altScreen(page)), '假 TUI 退出，回到主屏')

    // 现在 A 是普通 shell：再顶一轮窗口，这次必须走字节回放
    const done = join(dir, 'flood')
    await submit(
      page,
      `(sleep 3; for i in $(seq 1 2500); do printf 'pad %04d %s\\n' $i ${'x'.repeat(60)}; done; touch ${done}) &`,
    )
    await switchAway(page, sidA)
    await waitFor(() => Promise.resolve(existsSync(done)), '主屏积压顶掉了窗口', 60_000)

    await rx.reset()
    await switchBack(page, sidA)

    await expect(page.getByTestId('truncated')).toBeVisible()
    expect(await rx.attrFrames(), '主屏会话要走 ATTR_PREFIX 的字节回放').toBeGreaterThan(0)
    expect((await rx.rx()).includes('redraw'), '主屏会话不该走 redraw').toBe(false)
  })
})
