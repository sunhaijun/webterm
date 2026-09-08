import { expect, test } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * shell 集成的活性判定（协议 §4.6 / §4.7）。
 *
 * 【"多久没标记"不是存活信号】—— 长命令跑着、停在 prompt 前发呆都不产生
 * 标记。精确的信号是一次 Enter 的往返：有输出却零标记。这里在真 bash 上
 * 复现三种处境，验证结论落在正确的一边。
 *
 * 探针 2 秒到期、连续 2 次才下结论，所以相邻两次 Enter 之间要留 > 2 秒。
 */
let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const rawTextarea = (page: import('@playwright/test').Page) => page.locator('.xterm-helper-textarea')

/**
 * 在 Raw 模式下把一行敲进 PTY。
 *
 * 读视图（ADR-0011，手机默认）里 xterm 不可见，Raw 的落点是直发输入行；
 * 终端视图里才是 xterm 的隐藏 textarea。两条路都覆盖。
 */
async function typeRaw(page: import('@playwright/test').Page, text: string) {
  const line = page.getByTestId('raw-input')
  if (await line.isVisible().catch(() => false)) {
    await line.fill(text)
    await line.press('Enter')
    return
  }
  const ta = rawTextarea(page)
  await ta.focus()
  for (const ch of text) await ta.press(ch === ' ' ? 'Space' : ch)
  await ta.press('Enter')
}

test('钩子在本 shell 被摘掉：与子 shell 同形，提示"没有集成"而不是判失效', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await expect(page.getByTestId('degraded')).toHaveCount(0)

  // 把我们的钩子全摘了。【注意这条命令的副作用】：它自己的 133;C 发出去了
  // （DEBUG trap 在命令跑之前触发），但 PROMPT_COMMAND 被它清掉，所以
  // 133;D 永远不会来 —— 服务端状态从此卡在 running。这和 exec bash / ssh
  // 在字节流里【完全同形】，所以后续 Enter 走的是"子程序"分支：提示
  // unmarked，integration 不动。修复手段也相同：重新接入集成脚本。
  await submit(page, "trap - DEBUG; PROMPT_COMMAND=; PS1='> '")
  await waitFor(async () => (await terminalText(page)).includes('> '), '新 prompt 出现')

  await page.waitForTimeout(600)
  await typeRaw(page, 'echo NOHOOK-1')
  await waitFor(async () => (await terminalText(page)).includes('NOHOOK-1'), '第一条有输出')
  await page.waitForTimeout(2500)
  await typeRaw(page, 'echo NOHOOK-2')
  await waitFor(async () => (await terminalText(page)).includes('NOHOOK-2'), '第二条有输出')

  await expect(page.getByTestId('unmarked')).toBeVisible({ timeout: 10_000 })
  // 不能报 inactive：外层 shell 的钩子状态我们并不知道，而且这与 ssh 不可区分
  await expect(page.getByTestId('degraded')).toHaveCount(0)
})

test('进了没有集成的子 shell：提示但不判失效；退出后自动恢复', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 模拟 ssh / su / 容器：一个没有我们钩子的子 shell（外层照常收到 133;C）
  await submit(page, 'bash --norc --noprofile')
  await waitFor(
    async () => (await page.getByTestId('modebar').getAttribute('data-mode')) === 'raw',
    '外层看到命令在跑 → Raw',
  )
  await page.waitForTimeout(600)

  await typeRaw(page, 'echo INSUB-1')
  await waitFor(async () => (await terminalText(page)).includes('INSUB-1'), '子 shell 有回应')
  await page.waitForTimeout(2500)
  await typeRaw(page, 'echo INSUB-2')
  await waitFor(async () => (await terminalText(page)).includes('INSUB-2'), '子 shell 再次回应')

  // 【提示出现，但 integration 没被判成不可用】
  await expect(page.getByTestId('unmarked')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('degraded')).toHaveCount(0)

  // 退出子 shell → 外层 133;D / A / B 回来 → 提示消失
  await typeRaw(page, 'exit')
  await expect(page.getByTestId('unmarked')).toHaveCount(0, { timeout: 10_000 })
  await waitFor(
    async () => (await page.getByTestId('modebar').getAttribute('data-mode')) === 'composer',
    '回到 prompt → Composer',
  )
})

test('正常使用：连续敲命令不会被误判', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  for (let i = 0; i < 4; i++) {
    await submit(page, `printf "OK-${i}\\n"`)
    await waitFor(async () => (await terminalText(page)).includes(`OK-${i}`), `第 ${i} 条`)
    await page.waitForTimeout(700)
  }
  // 再来两个空 Enter —— 它们只重画 prompt，同样不能被当成未标记往返
  await submit(page, '')
  await page.waitForTimeout(2500)
  await submit(page, '')
  await page.waitForTimeout(2500)

  await expect(page.getByTestId('degraded')).toHaveCount(0)
  await expect(page.getByTestId('unmarked')).toHaveCount(0)
})
