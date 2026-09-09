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
afterEach(() => { for (const t of terms.splice(0)) t.dispose() })

/**
 * 占屏检测（ADR-0011 ②）：交互式全屏程序（建立富键盘 / 同步输出 / 备用缓冲）算；
 * 进度条（藏光标 + 上移重绘）不算 —— 否则会把 npm 之类误判、甩用户进终端。
 */
describe('installInteractive', () => {
  it('流式日志不算占屏', async () => {
    const { term, det } = mk()
    await write(term, 'building...\r\n\rprogress 10%\rprogress 20%\r\ndone\r\n')
    expect(det.get()).toBe(false)
  })

  it('【进度条不算】藏光标 + 多行上移重绘（npm/cargo 那类）', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?25l') // 藏光标
    for (let i = 0; i < 4; i++) await write(term, 'a\r\nb\r\nc\r\n\x1b[3A') // 三行上移重绘
    await write(term, '\x1b[?25h')
    expect(det.get(), 'npm 式进度条不该被判占屏').toBe(false)
  })

  it('Kitty 键盘协议入栈（\\e[>1u）= 占屏（claude/codex）', async () => {
    const { term, det } = mk()
    const seen: boolean[] = []; det.onChange((on) => seen.push(on))
    await write(term, 'hi\r\n')
    expect(det.get()).toBe(false)
    await write(term, '\x1b[>1u')
    expect(det.get()).toBe(true)
    expect(seen).toEqual([true])
  })

  it('modifyOtherKeys（\\e[>4;2m）= 占屏', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[>4;2m')
    expect(det.get()).toBe(true)
  })

  it('CSI > 的颜色以外场景才算：普通 SGR 颜色（\\e[31m）不算', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[31mred\x1b[0m\r\n')
    expect(det.get()).toBe(false)
  })

  it('同步输出（DECSET 2026）= 占屏', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?2026h')
    expect(det.get()).toBe(true)
  })

  it('备用缓冲（vim / top）= 占屏', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?1049h')
    expect(det.get()).toBe(true)
    await write(term, '\x1b[?1049l')
    expect(det.get()).toBe(false)
  })

  it('主屏占屏是粘的，直到 reset', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[>1u')
    expect(det.get()).toBe(true)
    await write(term, 'more output\r\n')
    expect(det.get()).toBe(true)
    det.reset()
    expect(det.get()).toBe(false)
  })

  it('reset 只清主屏判定；备用缓冲还在就还算', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?1049h\x1b[>1u')
    expect(det.get()).toBe(true)
    det.reset()
    expect(det.get()).toBe(true) // 备用缓冲仍激活
  })

  it('onChange 只在合并状态翻转时回调', async () => {
    const { term, det } = mk()
    const seen: boolean[] = []; det.onChange((on) => seen.push(on))
    await write(term, '\x1b[>1u')
    await write(term, '\x1b[>4;2m') // 又一个占屏信号，仍 true
    await write(term, '\x1b[?2026h')
    expect(seen).toEqual([true])
    det.reset()
    expect(seen).toEqual([true, false])
  })
})
