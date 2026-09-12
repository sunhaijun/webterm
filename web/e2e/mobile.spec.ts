import { devices, expect, test } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 手机视口下的布局不变量。
 *
 * 【这一档以前完全没有覆盖】：E2E 的 use 只有 devices['Desktop Chrome']，
 * 而 webterm 是个手机上用的产品。代价是一个结构性 bug 长期没人发现 ——
 * style.css 里遗留着 sidebar 重构【之前】的 `.app { grid-template-rows:
 * 28px auto 1fr auto auto auto }`。重构后 .app 的子元素变成 sidebar + main
 * 两个，那六行定义把 .main auto-place 进 28px 那行，于是 .main 只有 28px、
 * .term 8px、.xterm-viewport 0 —— 终端整个不渲染。
 *
 * 所以这里【断言尺寸，不只断言存在】。元素在、类名对、文本对，都不代表
 * 用户看得见东西。
 */
test.use({ ...devices['Pixel 5'] })

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('手机视口：终端拿到真实高度，页面不滚动，命令能往返', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const geo = await page.evaluate(() => {
    const h = (sel: string) => {
      const el = document.querySelector(sel)
      return el ? Math.round(el.getBoundingClientRect().height) : null
    }
    return {
      viewportH: window.innerHeight,
      appH: h('.app'),
      mainH: h('.main'),
      termH: h('.term'),
      xtermViewportH: h('.xterm-viewport'),
      scrollH: document.documentElement.scrollHeight,
      scrollW: document.documentElement.scrollWidth,
      viewportW: window.innerWidth,
    }
  })

  // .main 必须铺满 app 外壳；被塞进 28px 那行就是这里先炸
  expect(geo.mainH, `.main 应当铺满（app ${geo.appH}px）`).toBeGreaterThan(geo.appH! - 8)

  // 终端是唯一显示面（ADR-0013）：占空间的主体就是 xterm，高度不能塌。
  expect(geo.termH, `.term 高度（视口 ${geo.viewportH}px）`).toBeGreaterThan(geo.viewportH * 0.6)
  expect(geo.xtermViewportH, '.xterm-viewport 不能是 0').toBeGreaterThan(0)

  // 【伸缩空间必须落在终端上，不能落到别的条上】。
  // .main 曾经用固定行数的 grid（28px auto 1fr auto auto auto）按位置分配，
  // 而 banner 是条件渲染的 —— 少一个子元素就整体错位，1fr 跑到 modebar 上，
  // 模式条白占 153px。当时"终端 > 40% 视口"这条断言仍然是绿的，
  // 所以这里改成【逐条卡住非终端的条不许变胖】。
  const strips = await page.evaluate(() =>
    [...document.querySelectorAll('.main > *')]
      .filter((e) => !e.classList.contains('canvas'))
      .map((e) => ({
        cls: e.className || e.tagName.toLowerCase(),
        h: Math.round(e.getBoundingClientRect().height),
      })),
  )
  for (const s of strips) {
    expect(s.h, `.main > .${s.cls} 是条状 chrome，不该占这么高`).toBeLessThanOrEqual(80)
  }

  // 【根容器不该滚动】。手机上 sidebar 是靠 translateY 收到视口下面的
  // 底部 sheet，而 transform 不会把它从可滚动区域里去掉 —— 少了
  // overflow:hidden 就能往下多滚出一个抽屉。
  expect(geo.scrollH, '页面不该纵向滚动').toBeLessThanOrEqual(geo.viewportH + 1)
  expect(geo.scrollW, '页面不该横向滚动').toBeLessThanOrEqual(geo.viewportW + 1)

  // 布局对了还得真能用
  await submit(page, 'printf "HELLO-%s\\n" MOBILE')
  await waitFor(async () => (await terminalText(page)).includes('HELLO-MOBILE'), '终端出现输出')
})

test('更窄的手机（360×640）同样不塌', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 })
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const geo = await page.evaluate(() => {
    const h = (sel: string) => {
      const el = document.querySelector(sel)
      return el ? Math.round(el.getBoundingClientRect().height) : null
    }
    return {
      viewportH: window.innerHeight,
      termH: h('.term'),
      xtermViewportH: h('.xterm-viewport'),
      scrollH: document.documentElement.scrollHeight,
    }
  })
  expect(geo.termH, `.term 高度（视口 ${geo.viewportH}px）`).toBeGreaterThan(geo.viewportH * 0.6)
  expect(geo.xtermViewportH, '.xterm-viewport 不能是 0').toBeGreaterThan(0)
  expect(geo.scrollH, '页面不该纵向滚动').toBeLessThanOrEqual(geo.viewportH + 1)

  // 和上面一条同理：伸缩空间必须落在终端上。按比例卡不够 —— 换个屏幕尺寸
  // 就可能碰巧还在阈值内，所以逐条卡住非终端的条。
  const strips = await page.evaluate(() =>
    [...document.querySelectorAll('.main > *')]
      .filter((e) => !e.classList.contains('canvas'))
      .map((e) => ({
        cls: e.className || e.tagName.toLowerCase(),
        h: Math.round(e.getBoundingClientRect().height),
      })),
  )
  for (const s of strips) {
    expect(s.h, `.main > .${s.cls} 是条状 chrome，不该占这么高`).toBeLessThanOrEqual(80)
  }
})

/**
 * 功能键条【应当】横向溢出并自己滚 —— 键比一屏宽是设计如此，不是 bug。
 * 钉住它，免得有人为了"消掉溢出"把它改成换行或裁掉，那样后面几个键
 * （Home / End / PgUp / PgDn）就点不到了。
 */
test('功能键条横向可滚，且不撑破页面', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  // 命令在跑时键区是通用键集（21 个键，比一屏宽）。滚的是键区 .keybar-scroll，
  // 不是整条 .keybar —— 行首互切键与行尾 ⋯ 钉住不动（ADR-0015）
  await submit(page, 'sleep 30')
  await expect(page.getByTestId('key-Escape')).toBeVisible({ timeout: 10_000 })

  const kb = await page.evaluate(() => {
    const el = document.querySelector('.keybar .keybar-scroll')
    if (!el) return null
    return {
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
      docScrollW: document.documentElement.scrollWidth,
      viewportW: window.innerWidth,
    }
  })
  expect(kb, '.keybar-scroll 应当存在').not.toBeNull()
  expect(kb!.overflowX, '功能键条要能自己横向滚').toBe('auto')
  expect(kb!.scrollW, '键的总宽超过一屏才需要滚').toBeGreaterThan(kb!.clientW)
  expect(kb!.docScrollW, '但它不该把页面撑宽').toBeLessThanOrEqual(kb!.viewportW + 1)
})

/**
 * E2E-10 ⑦ 安全区：PWA 全屏（viewport-fit=cover + black-translucent）时内容延伸到刘海
 * 与 Home 指示条底下，四边的 inset 必须由 .app 的 padding 吃掉。Chromium 里
 * env(safe-area-inset-*) 恒为 0，所以直接覆盖 .app 上的 --sa-* 自定义属性来验几何。
 *
 * 真机上出过：状态栏顶到刘海底下、键行压在 Home 指示条上 —— 因为没人吃 inset。
 */
test('PWA 安全区：刘海与 Home 指示条的 inset 落在 .app 上，终端相应变矮，页面不溢出', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await page.waitForTimeout(300)

  const geo = () =>
    page.evaluate(() => {
      const r = (sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height), left: Math.round(b.left) }
      }
      return {
        app: r('.app')!, statusbar: r('.statusbar')!, term: r('.term')!, bottom: r('.bottom')!,
        scrollH: document.documentElement.scrollHeight, vh: window.innerHeight,
      }
    })
  const before = await geo()
  expect(before.statusbar.top, '没有刘海时状态栏贴顶').toBe(0)

  // 模拟 iPhone 竖屏：刘海 47px、Home 指示条 34px、横向 0
  await page.evaluate(() => {
    const app = document.querySelector('.app') as HTMLElement
    app.style.setProperty('--sa-top', '47px')
    app.style.setProperty('--sa-bottom', '34px')
  })
  await page.waitForTimeout(250)
  const after = await geo()
  expect(after.app.height, '.app 高度是 JS 写的可视视口高度，不该变').toBe(before.app.height)
  expect(after.statusbar.top, '状态栏让出刘海').toBe(47)
  expect(after.app.bottom - after.bottom.bottom, '键行让出 Home 指示条').toBe(34)
  expect(after.term.height, '终端正好矮掉上下 inset').toBe(before.term.height - 81)
  expect(after.scrollH, '页面不该因此溢出').toBeLessThanOrEqual(after.vh + 1)

  // 横屏刘海在侧边：左右 inset 也要让
  await page.evaluate(() => {
    const app = document.querySelector('.app') as HTMLElement
    app.style.setProperty('--sa-left', '44px')
  })
  await page.waitForTimeout(250)
  expect((await geo()).term.left, '终端让出侧边刘海').toBe(44)

  // 复位
  await page.evaluate(() => {
    const app = document.querySelector('.app') as HTMLElement
    for (const p of ['--sa-top', '--sa-bottom', '--sa-left']) app.style.removeProperty(p)
  })
  await page.waitForTimeout(250)
  const reset = await geo()
  expect(reset.statusbar.top).toBe(0)
  expect(reset.term.height).toBe(before.term.height)
})

/**
 * E2E-12 ⑥ 的手机版（AC-5.9 多端）：Pixel 5 上滚上去同样暂停跟随，提示条落在键行之上、
 * 点一下补齐。滚动仍走 xterm 视口钩子 —— 单指拖动在 1× 时就是交给 xterm 的。
 */
test('手机：回看时暂停跟随，提示条在键行之上，点一下补齐', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const count = async () => ((await terminalText(page)).match(/MF-\d{3}/g) ?? []).length
  await submit(page, 'for i in $(seq 1 150); do printf "MF-%03d\\n" $i; sleep 0.03; done; printf "MF-%s\\n" END')
  // 等真有 scrollback 可滚（贴底时 viewport.y == baseY）：Pixel 5 的终端有 39 行，
  // 只等 30 行输出时根本滚不动 —— CI 机器快，正好踩到
  await waitFor(
    async () => (await page.evaluate(() => (window as unknown as { __webterm: { viewport(): { y: number } } }).__webterm.viewport().y)) >= 15,
    '有足够的 scrollback',
  )
  await page.evaluate(() => (window as unknown as { __webterm: { scrollLines(n: number): void } }).__webterm.scrollLines(-10))
  const pill = page.getByTestId('follow-pill')
  await expect(pill).toBeVisible()
  const frozen = await count()
  await page.waitForTimeout(600)
  expect(await count()).toBe(frozen)

  // 提示条在画布里、键行之上，不被底栏盖住
  const geo = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect()
    return { pillBottom: Math.round(r('[data-testid=follow-pill]').bottom), barTop: Math.round(r('.bottom').top), canvasBottom: Math.round(r('.canvas').bottom) }
  })
  expect(geo.pillBottom).toBeLessThanOrEqual(geo.barTop)
  expect(geo.pillBottom).toBeLessThanOrEqual(geo.canvasBottom)

  await pill.click()
  await expect(pill).toHaveCount(0)
  await waitFor(async () => (await terminalText(page)).includes('MF-END'), '命令跑完', 20_000)
  const lines = (await terminalText(page)).match(/MF-\d{3}/g) ?? []
  expect(new Set(lines).size).toBe(150)
  expect(lines.length).toBe(150)
})
