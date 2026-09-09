import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import { installInteractive } from '../src/term/interactive'

// jsdom 没有 matchMedia，xterm 的 open() 要用
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({ matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }),
  })
}

const terms: Terminal[] = []
function mk() {
  const term = new Terminal({ cols: 40, rows: 10, allowProposedApi: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  term.open(host)
  terms.push(term)
  return { term, det: installInteractive(term) }
}
const enc = (s: string) => new TextEncoder().encode(s)
const write = (term: Terminal, s: string) => new Promise<void>((r) => term.write(enc(s), r))
afterEach(() => {
  for (const t of terms.splice(0)) t.dispose()
})

/**
 * 「占屏」检测（ADR-0011 ②推广）：流式日志不算，就地重绘 / 备用缓冲 / 同步输出算。
 */
describe('installInteractive', () => {
  it('流式日志（只 \\r\\n 与行首回车）不算占屏', async () => {
    const { term, det } = mk()
    await write(term, 'building...\r\n')
    await write(term, '\rprogress 10%\rprogress 20%\r\n')
    await write(term, 'done\r\n')
    expect(det.get()).toBe(false)
  })

  it('隐藏光标 + 光标上移 = 就地重绘（claude 那种）', async () => {
    const { term, det } = mk()
    const seen: boolean[] = []
    det.onChange((on) => seen.push(on))
    await write(term, 'line1\r\nline2\r\nline3\r\n')
    expect(det.get()).toBe(false)
    await write(term, '\x1b[?25l') // 藏光标
    await write(term, '\x1b[3A') // 上移 3 行，回去重写
    expect(det.get()).toBe(true)
    expect(seen).toEqual([true])
  })

  it('同步输出（DECSET 2026）= 占屏（codex 那种）', async () => {
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

  it('光标可见时的上移不算（带进度条的日志，不藏光标）', async () => {
    const { term, det } = mk()
    await write(term, 'downloading\r\n')
    await write(term, '\x1b[1A\rlayer 1: 50%\r\n') // 上移重写一行，但光标没藏
    expect(det.get()).toBe(false)
  })

  it('clear（\\e[H\\e[2J，定位到第 1 行）不算占屏', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?25l\x1b[H\x1b[2J') // 藏光标 + 定位到 1;1 + 清屏
    expect(det.get()).toBe(false) // 第 1 行不算"重写已吐过的行"
  })

  it('主屏就地重绘是粘的：光标重新显示也不掉，直到 reset', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?25l\x1b[5A')
    expect(det.get()).toBe(true)
    await write(term, '\x1b[?25h') // 程序在输入框显示了光标，但没退出
    expect(det.get()).toBe(true)
    det.reset() // 命令结束
    expect(det.get()).toBe(false)
  })

  it('reset 只清主屏判定；备用缓冲还在就还算占屏', async () => {
    const { term, det } = mk()
    await write(term, '\x1b[?1049h\x1b[?25l\x1b[3A')
    expect(det.get()).toBe(true)
    det.reset()
    expect(det.get()).toBe(true) // 备用缓冲仍激活
  })

  it('onChange 只在合并状态翻转时回调，不抖', async () => {
    const { term, det } = mk()
    const seen: boolean[] = []
    det.onChange((on) => seen.push(on))
    await write(term, '\x1b[?25l')
    await write(term, '\x1b[2A')
    await write(term, '\x1b[3A') // 再次上移，已经是 true，不该再回调
    await write(term, '\x1b[?2026h') // 又一个占屏信号，还是 true
    expect(seen).toEqual([true])
    det.reset()
    expect(seen).toEqual([true, false])
  })
})
