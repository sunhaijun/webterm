/**
 * E2E-43 Split UTF-8 loses no characters (AC-2.23; ADR-0026 §7, layout.md "Rendering").
 *
 * xterm.js `write(Uint8Array)` drops a three-byte character whose second byte is 0x80 when the
 * split falls after that second byte (`。` `…` `—`). The browser decodes each session's output with
 * a streaming TextDecoder and writes strings instead.
 */
import { expect, test } from '@playwright/test'

import { Agent, hooks, submit, terminalText, waitFor, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const LINE = '。…—END'
const hasLine = async (page: Parameters<typeof terminalText>[0]) =>
  (await terminalText(page)).split('\n').some((l) => l.trimEnd() === LINE)

test('E2E-43 three characters each split after byte 2 across OUTPUT frames still render as "。…—END", also after reload', async ({ page }) => {
  await agent.open(page)
  const sid = (await hooks.sid(page))!

  // sleep 0.3 between pieces puts a PTY read boundary between each printf, so each piece is its own OUTPUT frame.
  const n0 = (await hooks.frames(page)).length
  await submit(page, "printf '\\xe3\\x80'; sleep 0.3; printf '\\x82\\xe2\\x80'; sleep 0.3; printf '\\xa6\\xe2\\x80'; sleep 0.3; printf '\\x94END\\n'")
  await waitFor(() => hasLine(page), `terminal line reads ${LINE}`, 10_000)

  // Confirm the split happened: at least 4 OUTPUT frames (2, 3, 3 and 5 bytes).
  const fs = (await hooks.frames(page)).slice(n0).filter((f) => f.sid === sid && f.kind === 'OUTPUT')
  const sizes = fs.map((f) => f.bytes)
  expect(sizes.includes(2) && sizes.filter((b) => b === 3).length >= 2, `frame sizes ${sizes.join(',')}`).toBe(true)

  // After a reload (snapshot path) the line is still intact.
  await page.reload()
  await waitOnline(page)
  await waitFor(async () => (await hooks.frames(page)).some((f) => f.sid === sid && f.kind === 'SNAPSHOT'), 'reload took the snapshot path')
  await waitFor(() => hasLine(page), `line still reads ${LINE} after reload`, 10_000)
})
