/** UT-render-1：WebGL 不可用时静默回退，不抛异常（AC-5.5）。 */
import { describe, expect, it, vi } from 'vitest'

describe('UT-render-1 渲染回退', () => {
  it('WebglAddon 构造失败时不抛异常', async () => {
    // jsdom 没有 WebGL2，构造 WebglAddon 必然失败 —— 正好是要测的场景
    vi.resetModules()
    const { createTerminal } = await import('../src/term/terminal')
    const { SYSTEM_STACK } = await import('../src/ui/fonts')
    const handle = createTerminal(14, SYSTEM_STACK)
    expect(() => handle.attachWebgl()).not.toThrow()
    handle.dispose()
  })

  it('detachWebgl 可以重复调用', async () => {
    const { createTerminal } = await import('../src/term/terminal')
    const { SYSTEM_STACK } = await import('../src/ui/fonts')
    const handle = createTerminal(14, SYSTEM_STACK)
    expect(() => {
      handle.detachWebgl()
      handle.detachWebgl()
    }).not.toThrow()
    handle.dispose()
  })

  it('字体是传进来的那一段，不是写死在终端里的（AC-5.13）', async () => {
    const { createTerminal } = await import('../src/term/terminal')
    const handle = createTerminal(14, '"JetBrains Mono", monospace')
    expect(handle.term.options.fontFamily).toBe('"JetBrains Mono", monospace')
    handle.dispose()
  })

  it('scrollback 至少 5000 行', async () => {
    const { SCROLLBACK, createTerminal } = await import('../src/term/terminal')
    const { SYSTEM_STACK } = await import('../src/ui/fonts')
    expect(SCROLLBACK).toBeGreaterThanOrEqual(5000)
    const handle = createTerminal(14, SYSTEM_STACK)
    expect(handle.term.options.scrollback).toBe(SCROLLBACK)
    handle.dispose()
  })
})
