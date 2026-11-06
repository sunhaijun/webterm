/**
 * E2E-47 One session, a browser and `webterm attach` (AC-1.23, AC-4.14, ADR-0050).
 *
 * `webterm attach` runs under e2e/fixtures/ptyrun.py, which gives it a PTY of a set size, as
 * `ssh -t` would. The size follows the client in use: a client claims it when its user types,
 * and terminal reports never claim. Playwright keeps every page focused, so the focus rules are
 * covered by UT-claim-1.
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent, hooks, submit, waitFor, waitText, type AttachProc } from './harness'

test.setTimeout(120_000)

let agent: Agent
let att: AttachProc | null = null
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => {
  att?.kill()
  att = null
  agent.stop()
})

/** Records what the page sends, in order: a control message's `t`, or 'input' for INPUT frames. */
async function recordOrder(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __order: string[] }
    w.__order = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (data: unknown) {
      if (typeof data === 'string') {
        try {
          w.__order.push((JSON.parse(data) as { t: string }).t)
        } catch {
          /* not JSON */
        }
      } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const b = data instanceof Uint8Array ? data : new Uint8Array(data)
        if (b[0] === 0x02) w.__order.push('input')
      }
      return orig.call(this, data as never)
    }
  })
  return () => page.evaluate(() => (window as unknown as { __order: string[] }).__order.filter((t) => t !== 'ping'))
}

const sizeIs = async (page: Page, cols: number, rows: number) => {
  const s = await hooks.sessionSize(page)
  return s.cols === cols && s.rows === rows
}

test('E2E-47 a browser and webterm attach share a session; the size follows the client in use', async ({ browser }) => {
  // 1. Device A has the only session
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const a = await ctxA.newPage()
  const orderA = await recordOrder(a)
  await agent.open(a)
  const sizeA = await hooks.size(a)
  await submit(a, 'echo A1-$(stty size | tr " " x)')
  await waitText(a, `A1-${sizeA.rows}x${sizeA.cols}`)

  // 2. Device B opens the same session: its subscribe sets the size; A doesn't fight back
  const ctxB = await browser.newContext({ viewport: { width: 900, height: 600 } })
  const b = await ctxB.newPage()
  await agent.open(b)
  const sizeB = await hooks.size(b)
  expect(sizeB.cols).not.toBe(sizeA.cols)
  await waitFor(() => sizeIs(a, sizeB.cols, sizeB.rows), "A sees B's size", 2_000)
  const resizesBefore = (await orderA()).filter((t) => t === 'resize').length
  await a.waitForTimeout(500)
  expect((await orderA()).filter((t) => t === 'resize').length, 'A sends nothing in response').toBe(resizesBefore)

  // 3. Typing in A claims A's size before the input goes out
  const mark = (await orderA()).length
  await submit(a, 'echo A2-$(stty size | tr " " x)')
  const after = (await orderA()).slice(mark)
  expect(after[0], `A's first message after typing: ${after.join(',')}`).toBe('resize')
  expect(after[1]).toBe('input')
  await waitText(a, `A2-${sizeA.rows}x${sizeA.cols}`)

  // 4. webterm attach on a 100×30 terminal draws the session and claims its size
  att = agent.attach(100, 30, '1')
  await waitFor(() => att!.output().includes('A2-'), 'attach drew the session')
  await waitFor(() => sizeIs(a, 100, 30), 'attach claimed 100x30')

  // 5. Typing in attach reaches the session; both clients see the output
  att.write('echo AT-$(stty size | tr " " x)\r')
  await waitFor(() => att!.output().includes('AT-30x100'), 'output in attach')
  await waitText(a, 'AT-30x100')

  // 6. Typing in A claims back; attach shows what A typed
  await submit(a, 'echo from-browser')
  await waitFor(() => sizeIs(a, sizeA.cols, sizeA.rows), 'A claimed its size back')
  await waitFor(() => att!.output().includes('from-browser'), 'attach shows the browser input')

  // 7. A terminal report on attach's stdin doesn't claim; a keystroke does
  att.write('\x1b[5;1R')
  await a.waitForTimeout(1_000)
  expect(await sizeIs(a, sizeA.cols, sizeA.rows), 'a CPR report must not claim').toBe(true)
  att.write('\x15') // Ctrl+U: also clears what bash took from the report
  await waitFor(() => sizeIs(a, 100, 30), 'a keystroke in attach claims')

  // 8. Closing attach's terminal ends the client; the session stays and takes input
  att.hangUp()
  expect(await att.exited).toBe(0)
  att = null
  await submit(a, 'echo still-$((20+22))')
  await waitText(a, 'still-42')

  // 9. --list needs no terminal
  const list = await agent.attachList()
  expect(list.code).toBe(0)
  expect(list.out).toMatch(/^\s+1\s+\S+\s+~/m)

  await ctxA.close()
  await ctxB.close()
})
