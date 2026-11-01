/**
 * E2E-37 Baseline for scrolling and writing (record only, no pass/fail) — ADR-0026 §7.
 *
 * The output path is plain for now: streaming TextDecoder -> term.write, DOM renderer, xterm's own
 * touch scrolling. This scenario measures that baseline so any future optimization (per-frame
 * batching, pausing during scrollback, write budgets, WebGL, custom scrolling) is justified against
 * these numbers in its ADR.
 *
 * The test machine has no GPU, so only main-thread time counts: the number of long tasks
 * (duration > 50ms) and the longest one. Results go into the report as annotations and are printed.
 * The test asserts only that something was measured, not how fast it was.
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

/** LONGTASKS installs a long-task observer at page load and records each task's start and duration. */
const LONGTASKS = () => {
  const w = window as unknown as { __long: { start: number; dur: number }[] }
  w.__long = []
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push({ start: e.startTime, dur: e.duration })
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    /* browser without longtask support: record stays empty */
  }
}

const now = (p: Page) => p.evaluate(() => performance.now())

/** longTasks returns the long tasks (duration > 50) that started within [from, to]. */
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

test('E2E-37 baseline: main-thread long tasks during output, during drag, and switching back to a 1 MiB snapshot (record only)', async ({ page }) => {
  await page.addInitScript(LONGTASKS)
  await agent.open(page)
  const a = (await hooks.sid(page))!

  // (1) During emit.sh 4000 0.
  const t1 = await now(page)
  await submit(page, `${EMIT} 4000 0`)
  await waitText(page, 'EMIT-DONE', 'output finished', 90_000)
  const t1e = await now(page)
  const write = await longTasks(page, t1, t1e)
  record('(1) output 4000 lines', { ms: Math.round(t1e - t1), ...write })

  // (2) After output finishes: a one-finger vertical drag of 20 frames, 12px each.
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
  record('(2) drag 20 frames × 12px', { ms: Math.round(t2e - t2), scrolledRows: y0 - y1, ...drag })

  // (3) Switch back to a session with 1 MiB of backlog (snapshot path): from the switch keypress until the snapshot is written.
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e37-'))
  const done = join(dir, 'flood')
  const pad = 'x'.repeat(60)
  await submit(page, `(sleep 2; for i in $(seq 1 15000); do printf 'pad %05d %s\\n' $i ${pad}; done; printf 'FLOOD-%s\\n' END; touch ${done}) &`)
  const b = await newSession(page)
  await waitFor(() => existsSync(done), 'A built up 1 MiB of backlog in the background', 120_000)
  await page.waitForTimeout(500)
  expect(await hooks.sid(page)).toBe(b)
  const t3 = await now(page)
  const ms = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const w = window as unknown as { __webterm: { text(): string } }
        const t0 = performance.now()
        // Ctrl+Shift+Up = previous session (same window keydown listener as a real keypress).
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
  record('(3) switch back to 1 MiB backlog (snapshot)', {
    ms: Math.round(ms),
    snapshotBytes: snap.reduce((n, f) => n + f.bytes, 0),
    ...(await longTasks(page, t3, t3e)),
  })

  // Assert only that each phase actually happened.
  expect(t1e - t1).toBeGreaterThan(0)
  expect(snap.length, '(3) went through the snapshot path').toBeGreaterThan(0)
})
