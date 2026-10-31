/**
 * E2E-34 打字不该消失 —— AC-4.8 / AC-2.15 / AC-3.3 / AC-3.17（ADR-0020）。
 *
 * 三条互相独立、症状完全相同的路：敲下去没反应，屏幕毫无变化，也没有任何提示。
 *
 *   ① 切会话之后焦点落回 body —— 键落在 body 上，onData 根本不会触发
 *   ② 回放门按会话一刀切 —— 补课那几百毫秒到几秒里的按键全被丢掉
 *   ③ compositionend 没来 —— composing 卡在 true，该会话的输入到刷新为止都是死的
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { Agent, focusTerm, framesSince, hooks, terminalText, waitFor, waitSnapshot, type InputStats } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const sid = (page: Page) => hooks.sid(page)

/** 当前焦点落在哪 —— 失败时把它打出来，比"没出现"好定位得多。 */
const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.className ?? '(null)')

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

test('E2E-34 ① 切会话之后不点终端也能直接打字（AC-4.8）', async ({ page }) => {
  await agent.open(page)

  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  await typeLine(page, 'echo ONE')
  await waitFor(async () => (await terminalText(page)).includes('ONE'), 'ONE 回显')
  const sidA = await sid(page)

  // 新建会话（Ctrl+Shift+Enter）—— activate() 会把 A 的 host 从 DOM 摘掉
  await page.keyboard.press('Control+Shift+Enter')
  await waitFor(async () => (await sid(page)) !== sidA, '切到了新会话')

  // 【不点终端】直接打字
  await typeLine(page, 'echo TWO')
  await waitFor(
    async () => (await terminalText(page)).includes('TWO'),
    `新会话不点终端就打字，字掉在了 ${await focused(page)} 上`,
  )

  // 切回 A（Ctrl+Shift+↑），同样不点终端
  await page.keyboard.press('Control+Shift+ArrowUp')
  await waitFor(async () => (await sid(page)) === sidA, '切回了 A')
  await typeLine(page, 'echo THREE')
  await waitFor(
    async () => (await terminalText(page)).includes('THREE'),
    `切回旧会话就打字，字掉在了 ${await focused(page)} 上`,
  )
})

test('E2E-34 ② 切回时的回放窗口里打字不丢（AC-2.15）', async ({ page }) => {
  await agent.open(page)

  await focusTerm(page)
  const sidA = await sid(page)

  // A 在后台产 ~1 MiB：默认 ring 256 KiB，保证切回时走快照（回放门对快照同样开着）。
  // 先 sleep 2 秒，这几秒用来切到 B，保证整段输出都落在未订阅期间。
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e34-'))
  const done = join(dir, 'flooded')
  const pad = 'x'.repeat(60)
  await typeLine(
    page,
    `(sleep 2; for i in $(seq 1 15000); do printf 'pad %05d %s\\n' $i ${pad}; done; touch ${done}) &`,
  )

  await page.keyboard.press('Control+Shift+Enter')
  await waitFor(async () => (await sid(page)) !== sidA, '切到了 B')
  await waitFor(() => Promise.resolve(existsSync(done)), 'A 在后台把缓冲顶掉了', 120_000)

  // 切回 A —— 【不等任何东西】，立刻打字。字要落在快照正在解析的那个窗口里
  const read = await framesSince(page)
  await page.keyboard.press('Control+Shift+ArrowUp')
  await typeLine(page, 'echo REPLAYKEY')

  await waitSnapshot(read, sidA!, '这一轮确实走了快照')
  await waitFor(
    async () => (await terminalText(page)).includes('REPLAYKEY'),
    '回放窗口里敲的字被吞了 —— 命令被打断，什么都没执行',
    30_000,
  )
})

test('E2E-34 ③ compositionend 没来也不会把终端打死（AC-3.3）', async ({ page }) => {
  await agent.open(page)
  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })

  /** 开始组字但【不结束】—— 切输入法 / 切窗口时 compositionend 就是这么丢的。 */
  const startComposing = () =>
    page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!
      ta.focus()
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni', bubbles: true }))
    })

  // 组字期间一个字节都不发（AC-3.3 的原有语义，不能被兜底破坏）。
  // 真实输入法在组字期间报 isComposing / keyCode 229，这里照它的样子派发
  await startComposing()
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!
    for (const ch of 'NOPE') {
      ta.dispatchEvent(
        new KeyboardEvent('keydown', { key: ch, keyCode: 229, isComposing: true, bubbles: true, cancelable: true }),
      )
    }
  })
  await page.waitForTimeout(300)
  expect(await terminalText(page), '组字期间不能往 PTY 写字节').not.toContain('NOPE')

  // ① blur 兜底：元素都不是焦点了，组字不可能还在进行
  await page.evaluate(() => {
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new FocusEvent('blur'))
  })
  await typeLine(page, 'echo IMEBLUR')
  await waitFor(
    async () => (await terminalText(page)).includes('IMEBLUR'),
    'blur 之后终端还是死的 —— composing 卡住了',
  )

  // ② 普通 keydown 兜底：浏览器自己说了这不是组字中的按键。
  // 复位挂在捕获阶段，所以【这一下按键本身】也要进得去
  await startComposing()
  await typeLine(page, 'echo IMEKEY')
  await waitFor(
    async () => (await terminalText(page)).includes('IMEKEY'),
    '普通按键没能把组字状态复位 —— 第一个字符还被当成组字吞了',
  )
})

const stats = (page: Page): Promise<InputStats> => hooks.inputStats(page)

/**
 * E2E-34 ④ 输入路径可观测（AC-3.17）。
 *
 * 不测"输入能不能进去"（那是 ①②③ 的事），测的是【卡住时能不能一眼看出断在哪一段】。
 * ADR-0020 的原则本身需要可观测性，否则下次还是从猜开始。
 */
test('E2E-34 ④ 打字没反应时，inputStats 指得出断在哪一段', async ({ page }) => {
  await agent.open(page)

  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  await typeLine(page, 'echo STATS')
  await waitFor(async () => (await terminalText(page)).includes('STATS'), 'STATS 回显')

  const ok = await stats(page)
  expect(ok.keydown.n, '按键到达页面').toBeGreaterThan(0)
  expect(ok.toTerm.n, '焦点在终端上').toBeGreaterThan(0)
  expect(ok.data.n, 'xterm 吐出了 onData').toBeGreaterThan(0)
  expect(ok.sent.n, '发给了 agent').toBeGreaterThan(0)
  expect(ok.gated, '用户按键不该被回放门丢掉').toBe(0)
  expect(ok.verdict, `四段都通时的判断：${ok.verdict}`).toContain('四段都通')

  // 焦点丢掉的指纹：键还在进页面，但进不了终端
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const before = await stats(page)
  await page.keyboard.press('a')
  const after = await stats(page)

  expect(after.keydown.n, '键确实按下了').toBeGreaterThan(before.keydown.n)
  expect(after.toTerm.n, '但没进终端').toBe(before.toTerm.n)
  expect(after.focus, `焦点应当已经不是终端的 textarea，实际是 ${after.focus}`).not.toContain('xterm-helper-textarea')
  // 【这一步同时证明了按"最近一次"判而不是按总量判】：上面成功打过字，
  // 四段的总量早就大于 0，拿总量断言的话这里恒绿
  expect(after.verdict, `焦点丢掉时的判断：${after.verdict}`).toContain('焦点不在终端')
})
