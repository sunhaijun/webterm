import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import { installInteractive } from '../src/term/interactive'

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) })
}
const terms: Terminal[] = []
function mk() {
  const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  const host = document.createElement('div'); document.body.appendChild(host); term.open(host); terms.push(term)
  return { term, det: installInteractive(term) }
}
const enc = (s: string) => new TextEncoder().encode(s)
const write = (term: Terminal, s: string) => new Promise<void>((r) => term.write(enc(s), r))
const tick = () => new Promise<void>((r) => setTimeout(r, 0)) // 冲刷模式变化的微任务通知
afterEach(() => { for (const t of terms.splice(0)) t.dispose() })

/**
 * 占屏检测（ADR-0011 ②）。模式类（备用缓冲 / DECCKM / 鼠标）实时读、退出即复位；
 * 键盘协议 / 2026 是粘信号、到命令边界 reset() 才清。进度条一概不算。
 */
describe('installInteractive', () => {
  it('流式日志不算', async () => {
    const { term, det } = mk()
    await write(term, 'building...\r\n\rp 10%\rp 20%\r\ndone\r\n')
    expect(det.get()).toBe(false)
  })

  it('【进度条不算】藏光标 + 多行上移重绘（npm/cargo）', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?25l')
    for (let i = 0; i < 4; i++) await write(term, 'a\r\nb\r\nc\r\n\x1b[3A')
    await write(term, '\x1b[?25h')
    expect(det.get()).toBe(false)
  })

  it('应用光标键 DECCKM（\\e[?1h，top）= 占屏；复位（\\e[?1l）后【立即】不占屏（不粘）', async () => {
    const { term, det } = mk()
    const seen: boolean[] = []
    det.onChange((on) => seen.push(on))
    await write(term, '\x1b[?1h')
    expect(det.get(), 'DECCKM 开 → 占屏').toBe(true)
    await write(term, '\x1b[?1l')
    expect(det.get(), 'DECCKM 关 → 立即不占屏').toBe(false)
    await tick()
    expect(seen).toEqual([true, false])
  })

  it('鼠标跟踪（\\e[?1000h）= 占屏；复位后不占屏', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?1000h')
    expect(det.get()).toBe(true)
    await write(term, '\x1b[?1000l')
    expect(det.get()).toBe(false)
  })

  it('Kitty 键盘协议入栈（\\e[>1u）= 占屏（claude/codex），且是【粘】的', async () => {
    const { term, det } = mk()
    await write(term, 'hi\r\n')
    expect(det.get()).toBe(false)
    await write(term, '\x1b[>1u')
    expect(det.get()).toBe(true)
    await write(term, 'more\r\n') // 没有复位可读 → 保持占屏，直到 reset()
    expect(det.get()).toBe(true)
    det.reset()
    expect(det.get()).toBe(false)
  })

  it('modifyOtherKeys（\\e[>4;2m）= 占屏（粘）', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[>4;2m')
    expect(det.get()).toBe(true)
    det.reset()
    expect(det.get()).toBe(false)
  })

  it('普通 SGR 颜色（\\e[31m）不算', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[31mred\x1b[0m\r\n')
    expect(det.get()).toBe(false)
  })

  it('同步输出（DECSET 2026）= 占屏（粘）', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?2026h')
    expect(det.get()).toBe(true)
    det.reset()
    expect(det.get()).toBe(false)
  })

  it('备用缓冲（vim / less）= 占屏，关掉即不占屏', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?1049h')
    expect(det.get()).toBe(true)
    await write(term, '\x1b[?1049l')
    expect(det.get()).toBe(false)
  })

  it('less 那种：备用缓冲 + DECCKM 一起，退出（都复位）即不占屏 —— 不靠 reset()', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?1049h\x1b[?1h') // less 进：备用缓冲 + 应用光标键
    expect(det.get()).toBe(true)
    await write(term, '\x1b[?1l\x1b[?1049l') // q 退：都复位
    expect(det.get(), '退出后立即回落，不用等命令边界').toBe(false)
  })

  it('reset 清粘信号；备用缓冲还在就还算', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?1049h\x1b[>1u')
    expect(det.get()).toBe(true)
    det.reset()
    expect(det.get()).toBe(true) // 备用缓冲仍在
  })

  it('onChange：粘信号翻转', async () => {
    const { term, det } = mk()
    const seen: boolean[] = []
    det.onChange((on) => seen.push(on))
    await write(term, '\x1b[>1u')
    await write(term, '\x1b[>4;2m')
    await tick()
    expect(seen).toEqual([true])
    det.reset()
    expect(seen).toEqual([true, false])
  })
})
