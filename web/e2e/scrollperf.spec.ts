/**
 * E2E-37 滚动与写入的基线测量（只记录，不断言）—— ADR-0026 §7。
 *
 * 输出链路先用原生（流式 TextDecoder → term.write，DOM 渲染器，xterm 自带的触摸滚动）。
 * 这条场景量出原生的表现，作为将来"要不要加优化"的依据：要加回任何一项优化
 * （按帧合并、回看暂停、写入预算、WebGL、自写滚动），先拿这几个数对比，带着数据写 ADR。
 *
 * 【这台机器没 GPU，只看主线程毫秒数】：长任务（duration > 50ms）的个数与最长一次。
 * 结果写进测试报告（annotation）并打印；只断言「测到了东西」，不断言快慢。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, EMIT, hooks, newSession, rectOf, submit, waitFor, waitText } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)
test.setTimeout(180_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** 长任务观察器：页面一加载就装上，记下每个长任务的起止。 */
const LONGTASKS = () => {
  const w = window as unknown as { __long: { start: number; dur: number }[] }
  w.__long = []
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push({ start: e.startTime, dur: e.duration })
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    /* 不支持 longtask 的浏览器：记录为空 */
  }
}

const now = (p: Page) => p.evaluate(() => performance.now())

/** [from, to] 之间的长任务（duration > 50）。 */
async function longTasks(p: Page, from: number, to = Infinity) {
  const all = await p.evaluate(() => (window as unknown as { __long: { start: number; dur: number }[] }).__long)
  const xs = all.filter((t) => t.start >= from && t.start <= to && t.dur > 50).map((t) => Math.round(t.dur))
  return { count: xs.length, max: xs.length ? Math.max(...xs) : 0, total: xs.reduce((a, b) => a + b, 0) }
}

function record(name: string, v: unknown) {
  const s = `${name}: ${JSON.stringify(v)}`
  test.info().annotations.push({ type: 'E2E-37', description: s })
  console.log(`[E2E-37] ${s}`)
}

test('E2E-37 基线：输出期间 / 拖动期间 / 切回 1 MiB 快照 的主线程长任务（只记录）', async ({ page }) => {
  await page.addInitScript(LONGTASKS)
  await agent.open(page)
  const a = (await hooks.sid(page))!

  // ① emit.sh 4000 0 期间
  const t1 = await now(page)
  await submit(page, `${EMIT} 4000 0`)
  await waitText(page, 'EMIT-DONE', '输出跑完', 90_000)
  const t1e = await now(page)
  const write = await longTasks(page, t1, t1e)
  record('①输出 4000 行', { ms: Math.round(t1e - t1), ...write })

  // ② 输出跑完后，20 帧单指纵向拖（每帧 12px）
  const r = (await rectOf(page, '[data-testid=terminal]'))!
  const x = r.left + r.width / 2
  let y = r.top + 60
  const y0 = (await hooks.viewport(page)).y
  const cdp = await page.context().newCDPSession(page)
  const t2 = await now(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 0; i < 20; i++) {
    y += 12
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
    await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => res(null))))
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
  await page.waitForTimeout(300)
  const t2e = await now(page)
  const drag = await longTasks(page, t2, t2e)
  const y1 = (await hooks.viewport(page)).y
  record('②拖动 20 帧 × 12px', { ms: Math.round(t2e - t2), scrolledRows: y0 - y1, ...drag })

  // ③ 切回一个积压 1 MiB 的会话（走快照）：从按下切换键到快照写完
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e37-'))
  const done = join(dir, 'flood')
  const pad = 'x'.repeat(60)
  await submit(page, `(sleep 2; for i in $(seq 1 15000); do printf 'pad %05d %s\\n' $i ${pad}; done; printf 'FLOOD-%s\\n' END; touch ${done}) &`)
  const b = await newSession(page)
  await waitFor(() => existsSync(done), 'A 在后台积压了 1 MiB', 120_000)
  await page.waitForTimeout(500)
  expect(await hooks.sid(page)).toBe(b)
  const t3 = await now(page)
  const ms = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const w = window as unknown as { __webterm: { text(): string } }
        const t0 = performance.now()
        // Ctrl+Shift+↑ = 上一个会话（与按真键走同一个 window keydown 监听）
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', ctrlKey: true, shiftKey: true, bubbles: true }))
        const tick = () => {
          if (w.__webterm.text().includes('FLOOD-END')) resolve(performance.now() - t0)
          else requestAnimationFrame(tick)
        }
        tick()
      }),
  )
  expect(await hooks.sid(page)).toBe(a)
  const t3e = await now(page)
  const snap = (await hooks.frames(page)).filter((f) => f.sid === a && f.kind === 'SNAPSHOT')
  record('③切回 1 MiB 积压（快照）', {
    ms: Math.round(ms),
    snapshotBytes: snap.reduce((n, f) => n + f.bytes, 0),
    ...(await longTasks(page, t3, t3e)),
  })

  // 只断言「量到了」：各段都真的发生过
  expect(t1e - t1).toBeGreaterThan(0)
  expect(snap.length, '③ 确实走了快照').toBeGreaterThan(0)
})
