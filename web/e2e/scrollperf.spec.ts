/**
 * E2E-37 滚动跟手与写入预算（AC-5.15 / AC-5.16，ADR-0024 §2）
 *
 * 【这台机器没有 GPU，绝对帧率没有意义】。所以断言的是两件能重复测准的事：
 * 主线程有没有 > 50ms 的长任务，以及每帧落了几次 scrollTop —— 而不是 FPS。
 * 同理关掉 WebGL：SwiftShader 软渲染的抖动比它测的东西还大。
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use({ ...PIXEL, launchOptions: { args: ['--disable-webgl'] } })
test.setTimeout(180_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const sid = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())
const scrollTop = (p: Page) => p.evaluate(() => (document.querySelector('.xterm-viewport') as HTMLElement).scrollTop)

interface Probe {
  /** 拖动期间 duration > 50 的长任务时长（ms）。 */
  longTasks(): Promise<number[]>
  /** `.xterm-viewport.scrollTop` 被写了多少次。 */
  sets(): Promise<number>
  reset(): Promise<void>
}

/**
 * 装两个探针：长任务观察器 + scrollTop 写入计数。
 *
 * 【计数必须钩 setter】。听 scroll 事件不行 —— 浏览器把它合并到每帧一个，
 * 那样无论实现每帧写几次都只看到一次，断言等于没写。
 */
async function probe(page: Page): Promise<Probe> {
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __sets: number }
    w.__long = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(e.duration)
    }).observe({ entryTypes: ['longtask'] })

    const vp = document.querySelector('.xterm-viewport') as HTMLElement
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
    w.__sets = 0
    Object.defineProperty(vp, 'scrollTop', {
      configurable: true,
      get() {
        return desc.get!.call(this)
      },
      set(v: number) {
        w.__sets++
        desc.set!.call(this, v)
      },
    })
  })
  return {
    longTasks: () => page.evaluate(() => (window as unknown as { __long: number[] }).__long.filter((d) => d > 50)),
    sets: () => page.evaluate(() => (window as unknown as { __sets: number }).__sets),
    reset: () =>
      page.evaluate(() => {
        const w = window as unknown as { __long: number[]; __sets: number }
        w.__long = []
        w.__sets = 0
      }),
  }
}

/**
 * 单指纵向拖：`frames` 帧，每帧走 `framePx`，每帧内派发 `perFrame` 个 touchmove。
 *
 * 【`perFrame` 必须能大于 1，这条场景才测得出东西】。每帧只发一个的话，旧实现
 * （每个 touchmove 改一次 scrollTop）与新实现（每帧落一次）都是"每帧一次"，
 * 断言根本区分不开。而一帧堆好几个 touchmove 不是臆造的：主线程忙的时候浏览器
 * 就是这么把事件攒着一次性派发的。
 *
 * 【每帧之间要真的等一帧】：速度按帧采样（`inertia.sample`），同一 tick 发完的
 * 合成手势没有速度信息，松手也就不会有惯性。返回实际跨了几帧。
 */
async function dragDown(page: Page, frames: number, framePx: number, perFrame = 1): Promise<number> {
  return page.evaluate(
    async ({ frames, framePx, perFrame }: { frames: number; framePx: number; perFrame: number }) => {
      const host = document.querySelector('.term') as HTMLElement
      const r = host.getBoundingClientRect()
      const x = r.left + r.width / 2
      let y = r.top + 40
      const mk = (yy: number) => [new Touch({ identifier: 1, target: host, clientX: x, clientY: yy })]
      const fire = (type: string, yy: number) =>
        host.dispatchEvent(new TouchEvent(type, { touches: mk(yy), targetTouches: mk(yy), changedTouches: mk(yy), bubbles: true, cancelable: true }))
      // 【抬起时 touches 必须是空的】。手势结束的整条路（落地最后一段位移、判甩动）
      // 都挂在 `e.touches.length === 0` 上，带着 touches 发 touchend 等于那条路没跑
      const end = (yy: number) =>
        host.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: mk(yy), bubbles: true, cancelable: true }))
      const frame = () => new Promise((res) => requestAnimationFrame(() => res(null)))
      fire('touchstart', y)
      let n = 0
      for (let i = 0; i < frames; i++) {
        for (let j = 0; j < perFrame; j++) {
          y += framePx / perFrame
          fire('touchmove', y)
        }
        await frame()
        n++
      }
      end(y)
      return n
    },
    { frames, framePx, perFrame },
  )
}

/** 在终端上点一下（touchstart + touchend），用来验"再次触摸立刻停"。 */
async function tap(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.querySelector('.term') as HTMLElement
    const r = host.getBoundingClientRect()
    const t = [new Touch({ identifier: 9, target: host, clientX: r.left + r.width / 2, clientY: r.top + 60 })]
    const fire = (type: string, touches: Touch[]) =>
      host.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }))
    fire('touchstart', t)
    fire('touchend', [])
  })
}

/** 当前焦点落在哪 —— 失败时打出来，比"没出现"好定位得多（与 inputalive.spec.ts 同）。 */
const focused = (page: Page) => page.evaluate(() => document.activeElement?.className ?? '(null)')

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

async function fillScrollback(page: Page): Promise<void> {
  // 【要先 cd】：会话的 cwd 不是 web/，夹具是相对路径（与 continuity.spec.ts 同一条）
  await submit(page, `cd ${process.cwd()} && bash e2e/fixtures/emit.sh 4000 0`)
  await waitFor(async () => (await terminalText(page)).includes('EMIT-DONE'), 'emit 跑完', 120_000)
  await waitFor(async () => (await scrollTop(page)) > 0, '有 scrollback 可滚')
}

test('E2E-37 ① 拖动跟手：每帧至多落一次 scrollTop，期间没有 > 50ms 的长任务', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await fillScrollback(page)

  const p = await probe(page)
  const before = await scrollTop(page)
  // 20 帧 × 每帧 3 个 touchmove = 60 个事件。旧实现会落 60 次，新实现至多 20 次
  const frames = await dragDown(page, 20, 12, 3)
  const sets = await p.sets()

  // 真的滚了 —— 先证明这次拖动有效，再谈它花了多少次写入
  expect(await scrollTop(page), '手指向下拖 = 露出上文，scrollTop 变小').toBeLessThan(before)
  expect(sets, '一次都没落地？那测的不是滚动').toBeGreaterThan(0)
  // 【这里量的是"远少于事件数"，不是精确的帧数】：`.xterm-viewport.scrollTop`
  // 不只有我们写 —— xterm 的 syncScrollArea 也会写（把视口对齐到行边界），
  // 那几次混在计数里、也不归我们管。精确的"每帧至多一次"在 UT-scroll-1
  // （tests/dragscroll.test.ts）里量，那边没有 xterm，数到的每一次都是我们的。
  const moves = frames * 3
  expect(sets, `落了 ${sets} 次 / 派发了 ${moves} 个 touchmove / 跨了 ${frames} 帧：按帧合并了才会远少于事件数（AC-5.15）`).toBeLessThan(moves / 2)
  expect(await p.longTasks(), '拖动期间不该有 > 50ms 的长任务').toEqual([])
})

test('E2E-37 ② 松手有惯性：继续滑、1 秒内停；再触摸立刻停', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await fillScrollback(page)

  await dragDown(page, 20, 12)
  const atRelease = await scrollTop(page)
  await page.waitForTimeout(120)
  const gliding = await scrollTop(page)
  expect(gliding, '松手后还在滑').toBeLessThan(atRelease)

  // 1 秒内停下来
  await page.waitForTimeout(900)
  const settled = await scrollTop(page)
  await page.waitForTimeout(150)
  expect(await scrollTop(page), '1 秒内应当已经停住').toBe(settled)

  // 再甩一次，滑行中途按一下 —— 立刻停
  await dragDown(page, 20, 12)
  await page.waitForTimeout(80)
  await tap(page)
  const stopped = await scrollTop(page)
  await page.waitForTimeout(200)
  expect(await scrollTop(page), '手指落下就该停住，不能继续滑').toBe(stopped)
})

test('E2E-37 ③ 满窗口回放有预算：回放期间输入不被吃掉，也没有 > 50ms 的长任务', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 【全程用键盘切会话，不走抽屉】。抽屉会把焦点收进浮层（AC-5.11），关掉之后
  // 敲的字未必回到终端 —— 那样测的就成了焦点，不是写入预算。
  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  await typeLine(page, 'echo READY')
  await waitFor(async () => (await terminalText(page)).includes('READY'), `打字进不去终端，焦点在 ${await focused(page)}`)
  const sidA = await sid(page)

  // A 在后台产 ~1.5 MiB：默认 ring 是 1 MiB，保证切回时走【满窗口】的 reset 回放 ——
  // 这是单次写入量最大的一条路。先 sleep 2 秒，这几秒用来切到 B。
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e37-'))
  const done = join(dir, 'flooded')
  const pad = 'x'.repeat(60)
  await typeLine(page, `(sleep 2; for i in $(seq 1 22000); do printf 'pad %05d %s\\n' $i ${pad}; done; touch ${done}) &`)

  await page.keyboard.press('Control+Shift+Enter')
  await waitFor(async () => (await sid(page)) !== sidA, '切到了 B', 15_000)
  await waitFor(() => Promise.resolve(existsSync(done)), 'A 在后台把 1 MiB 窗口顶满了', 120_000)

  const p = await probe(page)

  // 切回 A —— 【不等任何东西】，立刻打字。字要落在回放正在解析的那个窗口里
  await page.keyboard.press('Control+Shift+ArrowUp')
  // 【探针在切换之后才归零】：切会话本身要摘挂 DOM、fit、reset 终端，那是一个同步的
  // 大任务（实测 ~54ms），它发生在按键处理里、【不在回放窗口内】。这条场景量的是
  // 回放写入有没有把主线程占死，不是切会话的重排（那是 ADR-0021 / E2E-32 的事）
  await p.reset()
  await typeLine(page, 'echo BUDGETKEY')

  await expect(page.getByTestId('truncated'), '这一轮确实走了满窗口的 reset 回放').toBeVisible()
  await waitFor(
    async () => (await terminalText(page)).includes('BUDGETKEY'),
    `回放期间敲的字被吃掉了，焦点在 ${await focused(page)}`,
    30_000,
  )
  const long = await p.longTasks()
  expect(long, `满窗口回放期间不该有 > 50ms 的长任务（AC-5.16），实测 ${JSON.stringify(long)}`).toEqual([])
})
