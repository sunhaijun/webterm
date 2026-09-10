import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 双指缩放读（ADR-0013 / E2E-24）：终端固定 43 列，双指放大是纯视觉的
 * transform，不改 PTY 尺寸；缩回 1× 或双击复位。
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use({ ...PIXEL, launchOptions: { args: ['--disable-webgl'] } })
test.setTimeout(60_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const zoom = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { zoom(): number } }).__webterm.zoom())
const size = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { size(): { cols: number; rows: number } } }).__webterm.size())
const screenTransform = (p: Page) =>
  p.evaluate(() => (document.querySelector('.xterm-screen') as HTMLElement | null)?.style.transform ?? '')

/** 在 .term 上派发一次双指手势：从间距 d0 张到 d1（中点固定）。 */
async function pinch(p: Page, d0: number, d1: number) {
  await p.evaluate(
    ({ d0, d1 }: { d0: number; d1: number }) => {
      const host = document.querySelector('.term') as HTMLElement
      const cx = 180
      const cy = 300
      const mk = (id: number, x: number, y: number) => new Touch({ identifier: id, target: host, clientX: x, clientY: y })
      const two = (gap: number) => [mk(1, cx - gap / 2, cy), mk(2, cx + gap / 2, cy)]
      const fire = (type: string, touches: Touch[]) =>
        host.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }))
      fire('touchstart', two(d0))
      fire('touchmove', two((d0 + d1) / 2))
      fire('touchmove', two(d1))
      fire('touchend', [])
    },
    { d0, d1 },
  )
}

test('双指张开放大：zoom > 1，.xterm-screen 有 scale；PTY 尺寸不变', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, "printf 'ZOOM-%s\\n' READY")
  await waitFor(async () => (await terminalText(page)).includes('ZOOM-READY'), '有内容')

  const before = await size(page)
  expect(await zoom(page)).toBe(1)

  await pinch(page, 100, 260) // 张到 2.6 倍
  const z = await zoom(page)
  expect(z, `放大到 ${z}`).toBeGreaterThan(1.4)
  expect(await screenTransform(page)).toContain('scale(')
  expect(await size(page), 'PTY 尺寸不能变（纯视觉缩放）').toEqual(before)

  // 双击复位
  await page.evaluate(() => {
    const host = document.querySelector('.term') as HTMLElement
    const t = () => [new Touch({ identifier: 1, target: host, clientX: 180, clientY: 300 })]
    const fire = (type: string, touches: Touch[]) => host.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }))
    fire('touchstart', t()); fire('touchend', [])
    fire('touchstart', t()); fire('touchend', [])
  })
  await waitFor(async () => (await zoom(page)) === 1, '双击复位到 1×', 3_000)
  expect(await screenTransform(page)).toBe('')
})

test('轻微捏合不放大：缩回 1× 时 transform 清空', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await pinch(page, 200, 120) // 捏合（缩小）
  expect(await zoom(page)).toBe(1)
  expect(await screenTransform(page)).toBe('')
})
