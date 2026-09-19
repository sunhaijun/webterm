import { devices, expect, test, type Page } from '@playwright/test'

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

/**
 * E2E-7 · Raw 模式软键盘直接插入的标点（AC-3.14）。
 *
 * iPhone 中文键盘下「逗号打不进终端，句号可以」：同一个键盘上两个键报的 keyCode 不同，
 * xterm 一个接得住一个接不住。这里按软键盘的样子派发
 * keydown → 插字符 → input(insertText) → keyup，三种 keyCode 都要进终端。
 * 真机的 keyCode 是 iOS 自己报的、没法在 headless 里复刻，但
 *【keydown 发生过 + insertText】这个组合就是要害，合成事件能精确覆盖。
 */
/**
 * 软键盘按下同一个键 n 下：每下都是 keydown → 浏览器把字插进 textarea → input → keyup。
 *
 * keydown 没被 preventDefault 才会真的插进去 —— xterm 处理掉的键会 cancel。
 * 【n 下在同一个 evaluate 里发完】：连打的间隔必须落在去重窗口（120ms）以内，
 * 否则测不到"去重会不会吃掉用户的第二下"。
 */
function softKeys(page: Page, ch: string, keyCode: number, n: number) {
  return page.evaluate(
    ([ch, keyCode, n]: [string, number, number]) => {
      const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!
      ta.focus()
      for (let i = 0; i < (n as number); i++) {
        const opts = { bubbles: true, cancelable: true, composed: true }
        const kd = new KeyboardEvent('keydown', { key: ch as string, keyCode: keyCode as number, ...opts })
        ta.dispatchEvent(kd)
        if (!kd.defaultPrevented) {
          const bi = new InputEvent('beforeinput', { inputType: 'insertText', data: ch as string, ...opts })
          ta.dispatchEvent(bi)
          if (!bi.defaultPrevented) {
            ta.value += ch as string
            ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch as string, bubbles: true, composed: true }))
          }
        }
        ta.dispatchEvent(new KeyboardEvent('keyup', { key: ch as string, keyCode: keyCode as number, bubbles: true, composed: true }))
      }
    },
    [ch, keyCode, n] as [string, number, number],
  )
}

test('E2E-7 软键盘直接插入的全角标点进得了终端，且不重复', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 终端直通输入：点终端区，键直送 PTY（ADR-0013+）
  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  await page.keyboard.type('echo ')

  const softKey = (ch: string, keyCode: number) => softKeys(page, ch, keyCode, 1)

  // keyCode 0 = iOS 对直接插入报的值（本 bug 的要害）；229 = 差量路；191 = keydown 路
  await softKey('，', 0)
  await softKey('。', 229)
  await softKey('！', 0)
  await softKey('？', 191)

  // 组字提交之后紧跟一个 keyCode 0 的标点 —— 打完中文接着打逗号是常事
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!
    ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'nihao', bubbles: true }))
    ta.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }))
  })
  await softKey('，', 0)

  await page.keyboard.press('Enter')
  const want = '，。！？你好，'
  await waitFor(async () => (await terminalText(page)).split('\n').some((l) => l.trim() === want), `终端回显 ${want}`)

  const text = await terminalText(page)
  expect(text, '重复发送会变成「，，」').not.toContain('，，')
  expect(text, '组字结果不能发两遍').not.toContain('你好你好')
})

/**
 * E2E-7 ② 连打两下同一个标点（AC-3.14 / ADR-0020）。
 *
 * 软键盘直接插入的字符【只走 beforeinput 这一条路】，第二下没有别的路会替它发 ——
 * 去重若按"内容 + 时间窗口"判，第二下会被静默吃掉，而用户只会看到"字打不进去"。
 */
test('E2E-7 ② 连打两下同一个标点：两下都进，不被去重吃掉', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  await page.keyboard.type('echo ')

  // 两下在同一个 evaluate 里发完 —— 间隔远小于 120ms 的去重窗口
  await softKeys(page, '，', 0, 2)

  await page.keyboard.press('Enter')
  await waitFor(
    async () => (await terminalText(page)).split('\n').some((l) => l.trim() === '，，'),
    '连打两下「，」，终端回显必须是两个 —— 第二下被去重吃掉就只剩一个',
  )
})
