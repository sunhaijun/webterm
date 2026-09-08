import { devices, expect, test } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 软键盘弹出 / 收起之后布局要【完全恢复】。
 *
 * iOS Safari 上 100vh 不随键盘变化，所以高度的唯一真相来源是
 * visualViewport（viewport.ts）。键盘弹起时页面被整体上推，要用
 * transform 抵消；收起时这些都必须撤干净 —— 撤不干净的表现就是
 * "键盘收了，但页面还是缩着的 / 顶上多出一条空白"。
 *
 * 【headless 里没有真键盘】，所以这里把 visualViewport 换成一个可编程的
 * 替身，直接驱动它的 resize/scroll。测的是应用对这些事件的反应，
 * 那正是出问题的地方。
 */
test.use({ ...devices['Pixel 5'] })

interface VV {
  __vv: { keyboardUp(fraction: number, top: number): void; keyboardDown(): void }
}

const stubViewport = `
  (() => {
    // 【高度用 getter 从 window.innerHeight 推】，不在这里固化 ——
    // init script 跑得比布局早，那时候的 innerHeight 不是真实视口，
    // 固化下来会让"没有键盘"的基准状态本身就是错的。
    let override = null
    const vv = {
      get width() { return window.innerWidth },
      get height() { return override === null ? window.innerHeight : override },
      offsetTop: 0,
      scale: 1,
      _l: {},
      addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f) },
      removeEventListener(t, f) { this._l[t] = (this._l[t] || []).filter((x) => x !== f) },
      fire(t) { (this._l[t] || []).forEach((f) => f()) },
      keyboardUp(fraction, top) {
        override = Math.round(window.innerHeight * fraction)
        this.offsetTop = top
        this.fire('resize'); this.fire('scroll')
      },
      keyboardDown() {
        override = null
        this.offsetTop = 0
        this.fire('resize'); this.fire('scroll')
      },
    }
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true })
    window.__vv = vv
  })()
`

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('软键盘弹出再收起，布局完全恢复', async ({ page }) => {
  await page.addInitScript(stubViewport)
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const snap = () =>
    page.evaluate(() => {
      const app = document.querySelector('.app') as HTMLElement
      const h = (sel: string) => {
        const el = document.querySelector(sel)
        return el ? Math.round(el.getBoundingClientRect().height) : null
      }
      return {
        appH: Math.round(app.getBoundingClientRect().height),
        inlineH: app.style.height,
        transform: app.style.transform,
        top: Math.round(app.getBoundingClientRect().top),
        termH: h('.term'),
        scrollY: window.scrollY,
        docScroll: document.documentElement.scrollHeight - window.innerHeight,
      }
    })

  const before = await snap()
  expect(before.termH, '起始状态终端应当有高度').toBeGreaterThan(100)

  // 键盘弹出：可视高度缩小，页面被上推
  await page.evaluate(() => (window as unknown as VV).__vv.keyboardUp(0.55, 40))
  await page.waitForTimeout(300)

  const up = await snap()
  expect(up.appH, '键盘弹出后 app 应当缩到可视高度').toBeLessThan(before.appH)
  expect(up.transform, '页面被上推时要用 transform 抵消').toContain('translateY')

  // 键盘收起：一切恢复
  await page.evaluate(() => (window as unknown as VV).__vv.keyboardDown())
  await page.waitForTimeout(400)

  const after = await snap()
  expect(after.appH, '键盘收起后高度必须恢复').toBe(before.appH)
  expect(after.transform, '抵消用的 transform 必须撤掉').toBe(before.transform)
  expect(after.top, 'app 不能停在被推上去的位置').toBe(before.top)
  expect(after.termH, '终端高度必须恢复').toBe(before.termH)
  // 【关键】：收起后页面不能停在滚动位置上，否则顶上会缺一块
  expect(after.scrollY, '页面不该残留滚动').toBe(0)
  expect(after.docScroll, '根容器不该可滚动').toBeLessThanOrEqual(0)

  // 恢复之后还得真能用
  await submit(page, 'printf "AFTER-IME\\n"')
  await waitFor(async () => (await terminalText(page)).includes('AFTER-IME'), '键盘收起后仍能敲命令')
})

test('反复弹出收起不会越缩越小', async ({ page }) => {
  await page.addInitScript(stubViewport)
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const appH = () =>
    page.evaluate(() => Math.round((document.querySelector('.app') as HTMLElement).getBoundingClientRect().height))
  const base = await appH()

  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as unknown as VV).__vv.keyboardUp(0.5, 60))
    await page.waitForTimeout(120)
    await page.evaluate(() => (window as unknown as VV).__vv.keyboardDown())
    await page.waitForTimeout(120)
  }

  expect(await appH(), '三轮之后高度不能漂').toBe(base)
})
