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
      streamH: h('.stream'),
      xtermViewportH: h('.xterm-viewport'),
      scrollH: document.documentElement.scrollHeight,
      scrollW: document.documentElement.scrollWidth,
      viewportW: window.innerWidth,
    }
  })

  // .main 必须铺满 app 外壳；被塞进 28px 那行就是这里先炸
  expect(geo.mainH, `.main 应当铺满（app ${geo.appH}px）`).toBeGreaterThan(geo.appH! - 8)

  // 读视图（ADR-0011）：占空间的主体是块流；xterm 不可见但【保持真实尺寸】——
  // FitAddon 据它算 cols/rows 发给 PTY，所以它的高度也不能塌。
  expect(geo.streamH, `.stream 高度（视口 ${geo.viewportH}px）`).toBeGreaterThan(geo.viewportH * 0.6)
  expect(geo.termH, `.term 高度（视口 ${geo.viewportH}px）`).toBeGreaterThan(geo.viewportH * 0.6)
  expect(geo.xtermViewportH, '.xterm-viewport 不能是 0').toBeGreaterThan(0)

  // 【伸缩空间必须落在终端上，不能落到别的条上】。
  // .main 曾经用固定行数的 grid（28px auto 1fr auto auto auto）按位置分配，
  // 而 banner 是条件渲染的 —— 少一个子元素就整体错位，1fr 跑到 modebar 上，
  // 模式条白占 153px。当时"终端 > 40% 视口"这条断言仍然是绿的，
  // 所以这里改成【逐条卡住非终端的条不许变胖】。
  const strips = await page.evaluate(() =>
    [...document.querySelectorAll('.main > *')]
      .filter((e) => !e.classList.contains('term') && !e.classList.contains('stream'))
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
      streamH: h('.stream'),
      xtermViewportH: h('.xterm-viewport'),
      scrollH: document.documentElement.scrollHeight,
    }
  })
  expect(geo.streamH, `.stream 高度（视口 ${geo.viewportH}px）`).toBeGreaterThan(geo.viewportH * 0.6)
  expect(geo.termH, `.term 高度（视口 ${geo.viewportH}px）`).toBeGreaterThan(geo.viewportH * 0.6)
  expect(geo.xtermViewportH, '.xterm-viewport 不能是 0').toBeGreaterThan(0)
  expect(geo.scrollH, '页面不该纵向滚动').toBeLessThanOrEqual(geo.viewportH + 1)

  // 和上面一条同理：伸缩空间必须落在终端上。按比例卡不够 —— 换个屏幕尺寸
  // 就可能碰巧还在阈值内，所以逐条卡住非终端的条。
  const strips = await page.evaluate(() =>
    [...document.querySelectorAll('.main > *')]
      .filter((e) => !e.classList.contains('term') && !e.classList.contains('stream'))
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

  const kb = await page.evaluate(() => {
    const el = document.querySelector('.keybar')
    if (!el) return null
    return {
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
      docScrollW: document.documentElement.scrollWidth,
      viewportW: window.innerWidth,
    }
  })
  expect(kb, '.keybar 应当存在').not.toBeNull()
  expect(kb!.overflowX, '功能键条要能自己横向滚').toBe('auto')
  expect(kb!.scrollW, '键的总宽超过一屏才需要滚').toBeGreaterThan(kb!.clientW)
  expect(kb!.docScrollW, '但它不该把页面撑宽').toBeLessThanOrEqual(kb!.viewportW + 1)
})
