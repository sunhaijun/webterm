/**
 * E2E-34 打字不该消失（AC-4.8 / AC-2.15 / AC-3.3，ADR-0020）。
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

import { Agent, terminalText, waitFor } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const sid = (page: Page) =>
  page.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())

/** 当前焦点落在哪 —— 失败时把它打出来，比"没出现"好定位得多。 */
const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.className ?? '(null)')

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

test('E2E-34 ① 切会话之后不点终端也能直接打字（AC-4.8）', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

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
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  const sidA = await sid(page)

  // A 在后台产 ~1.5 MiB：默认 ring 是 1 MiB，保证切回时走满窗口的 reset 回放。
  // 回放越大，"回放期间打字"这个窗口越真实 —— 手机上它就是秒级的。
  // 先 sleep 2 秒，这几秒用来切到 B，保证整段输出都落在未订阅期间。
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e33-'))
  const done = join(dir, 'flooded')
  const pad = 'x'.repeat(60)
  await typeLine(
    page,
    `(sleep 2; for i in $(seq 1 22000); do printf 'pad %05d %s\\n' $i ${pad}; done; touch ${done}) &`,
  )

  await page.keyboard.press('Control+Shift+Enter')
  await waitFor(async () => (await sid(page)) !== sidA, '切到了 B')
  await waitFor(() => Promise.resolve(existsSync(done)), 'A 在后台把缓冲顶掉了', 120_000)

  // 切回 A —— 【不等任何东西】，立刻打字。字要落在回放正在解析的那个窗口里
  await page.keyboard.press('Control+Shift+ArrowUp')
  await typeLine(page, 'echo REPLAYKEY')

  await expect(page.getByTestId('truncated'), '这一轮确实走了 reset 回放').toBeVisible()
  await waitFor(
    async () => (await terminalText(page)).includes('REPLAYKEY'),
    '回放窗口里敲的字被吞了 —— 命令被打断，什么都没执行',
    30_000,
  )
})

test('E2E-34 ③ compositionend 没来也不会把终端打死（AC-3.3）', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
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
