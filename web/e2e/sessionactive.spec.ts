/**
 * E2E-35 会话选中态一眼可辨（AC-4.9）
 *
 * 断言的是【看得出来】，所以量的是计算样式与矩形，不是 class 名 —— 改之前
 * 选中是 --fg 14%、hover 是 8%，两个中性灰在同一屏上分不开，而 class 名一直是对的。
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const sid = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())

const bg = (p: Page, sel: string) =>
  p.evaluate((s) => getComputedStyle(document.querySelector(s)!).backgroundColor, sel)

/** 一直按到选中项落在列表的头 / 尾（`Ctrl+Shift+↑/↓` 到头会回绕，按固定次数会落错行）。 */
async function stepUntil(page: Page, key: string, where: 'first' | 'last') {
  const target = await page.locator('.session-item')[where]().getAttribute('data-sid')
  for (let i = 0; i < 8; i++) {
    if (String(await sid(page)) === target) break
    await page.keyboard.press(key)
  }
  expect(String(await sid(page)), `切到了${where === 'first' ? '第一个' : '最后一个'}会话`).toBe(target)
}

/** 打开页面并建到 n 个会话（桌面侧栏常驻，新建按钮就在列表底下）。 */
async function open(page: Page, n: number) {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  for (let i = 1; i < n; i++) {
    await page.getByTestId('new-session').click()
    await expect(page.locator('.session-item')).toHaveCount(i + 1)
  }
}

test('选中项与 hover、普通项两两不同，且带强调条', async ({ page }) => {
  await open(page, 3)

  // ① 只有一条选中，且就是当前会话
  const current = page.locator('.session-item[aria-current="true"]')
  await expect(current).toHaveCount(1)
  expect(await current.getAttribute('data-sid')).toBe(String(await sid(page)))

  // ② 三种状态两两不同：选中 / hover / 都不是
  const items = page.locator('.session-item')
  const n = await items.count()
  const activeIdx = Number(await current.evaluate((el) => [...el.parentElement!.querySelectorAll('.session-item')].indexOf(el)))
  const others = [...Array(n).keys()].filter((i) => i !== activeIdx)
  await items.nth(others[0]!).hover()

  const selected = await bg(page, '.session-item[aria-current="true"]')
  const hovered = await items.nth(others[0]!).evaluate((el) => getComputedStyle(el).backgroundColor)
  const plain = await items.nth(others[1]!).evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(selected, '选中和 hover 必须分得开').not.toBe(hovered)
  expect(selected, '选中和普通项必须分得开').not.toBe(plain)
  expect(hovered, 'hover 和普通项也该有区别').not.toBe(plain)

  // ③ 左侧强调条
  const shadow = await current.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(shadow).not.toBe('none')
  expect(shadow).toContain('inset')
})

test('切换会话时选中态跟着搬家', async ({ page }) => {
  await open(page, 3)
  const before = await sid(page)

  await page.keyboard.press('Control+Shift+ArrowDown')
  await expect
    .poll(async () => sid(page), { message: '切到了相邻会话' })
    .not.toBe(before)

  const current = page.locator('.session-item[aria-current="true"]')
  await expect(current).toHaveCount(1)
  expect(await current.getAttribute('data-sid')).toBe(String(await sid(page)))
  await expect(page.locator(`.session-item[data-sid="${before}"]`)).not.toHaveAttribute('aria-current', 'true')
})

test('选中项被切到视区外时滚回来；本来就可见则不滚', async ({ page }) => {
  await open(page, 4)

  // 列表本来全都看得见：来回切两次，一次都不该滚
  await page.keyboard.press('Control+Shift+ArrowDown')
  await page.keyboard.press('Control+Shift+ArrowUp')
  expect(await page.locator('.sidebar').evaluate((el) => el.scrollTop), '全可见时不滚').toBe(0)

  // 压到放不下：先切到第一个（列表滚到顶），再切到最后一个 —— 它必须自己滚下来
  await page.addStyleTag({ content: '.sidebar { max-height: 120px }' })
  await stepUntil(page, 'Control+Shift+ArrowUp', 'first')
  await stepUntil(page, 'Control+Shift+ArrowDown', 'last')

  const inside = await page.evaluate(() => {
    const box = document.querySelector('.sidebar')!.getBoundingClientRect()
    const el = document.querySelector('.session-item[aria-current="true"]')!.getBoundingClientRect()
    return { top: el.top >= box.top - 1, bottom: el.bottom <= box.bottom + 1, scrolled: document.querySelector('.sidebar')!.scrollTop }
  })
  expect(inside.top && inside.bottom, '选中项整条落在侧栏可视区内').toBe(true)
  expect(inside.scrolled, '确实是靠滚动做到的').toBeGreaterThan(0)

  // 切回第一个，同样要完整可见
  await stepUntil(page, 'Control+Shift+ArrowUp', 'first')
  const backInside = await page.evaluate(() => {
    const box = document.querySelector('.sidebar')!.getBoundingClientRect()
    const el = document.querySelector('.session-item[aria-current="true"]')!.getBoundingClientRect()
    return el.top >= box.top - 1 && el.bottom <= box.bottom + 1
  })
  expect(backInside).toBe(true)
})
