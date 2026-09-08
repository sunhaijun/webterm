import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it } from 'vitest'

import { MarkTracker } from '../src/term/marks'

/**
 * 行锚点（ADR-0011 ④）：帧在 out_seq 处切开、切口处登记 marker。
 * 用真 xterm（离屏挂到 jsdom）—— 要验的正是"回调那一刻光标在哪一行"。
 */
// jsdom 没有 matchMedia，xterm 的 open() 要用它探测 prefers-color-scheme / 像素比
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  })
}

const terms: Terminal[] = []
function mk() {
  const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
  const host = document.createElement('div')
  document.body.appendChild(host)
  term.open(host)
  terms.push(term)
  return { term, tracker: new MarkTracker(term) }
}
const flush = (term: Terminal) => new Promise<void>((r) => term.write('', r))
const enc = (s: string) => new TextEncoder().encode(s)
afterEach(() => {
  for (const t of terms.splice(0)) t.dispose()
})

describe('MarkTracker', () => {
  it('锚点在帧中间：marker 落在切口那一行', async () => {
    const { term, tracker } = mk()
    // "L1\r\n" 是 4 字节；seq 4 处是 L2 的开头
    expect(tracker.markAt(4, 'k')).toBe(true)
    tracker.write(enc('L1\r\nL2\r\nL3\r\n'), 0)
    await flush(term)
    expect(tracker.get('k')?.line).toBe(1)
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe('L2')
  })

  it('锚点恰在帧尾：这一帧就登记，不等下一帧', async () => {
    const { term, tracker } = mk()
    tracker.markAt(8, 'end')
    tracker.write(enc('L1\r\nL2\r\n'), 0)
    await flush(term)
    expect(tracker.get('end')?.line).toBe(2)
  })

  it('锚点恰在帧首（上一帧写完之后才登记）：落在下一帧开头那一行', async () => {
    const { term, tracker } = mk()
    tracker.write(enc('L1\r\n'), 0)
    await flush(term)
    expect(tracker.markAt(4, 'k')).toBe(true) // seq 4 == 水位，还没过去
    tracker.write(enc('L2\r\n'), 4)
    await flush(term)
    expect(tracker.get('k')?.line).toBe(1)
  })

  it('位置已经写过去了：登记不了，返回 false', async () => {
    const { term, tracker } = mk()
    tracker.write(enc('L1\r\nL2\r\n'), 0)
    await flush(term)
    expect(tracker.markAt(4, 'late')).toBe(false)
    expect(tracker.get('late')).toBeUndefined()
  })

  it('一帧里多个锚点、顺序无关', async () => {
    const { term, tracker } = mk()
    tracker.markAt(8, 'b')
    tracker.markAt(4, 'a')
    tracker.write(enc('L1\r\nL2\r\nL3\r\n'), 0)
    await flush(term)
    expect(tracker.get('a')?.line).toBe(1)
    expect(tracker.get('b')?.line).toBe(2)
    expect(tracker.pendingCount).toBe(0)
  })

  it('reset 回放帧：前 4 字节不计数，偏移按 body 算', async () => {
    const { term, tracker } = mk()
    tracker.markAt(104, 'k') // body 里偏移 4
    const prefix = enc('\x1b[0m')
    const body = enc('L1\r\nL2\r\n')
    const data = new Uint8Array(prefix.length + body.length)
    data.set(prefix)
    data.set(body, prefix.length)
    tracker.write(data, 100, 4)
    await flush(term)
    expect(tracker.get('k')?.line).toBe(1)
  })

  it('reset：marker 全部作废，待登记清空，水位归零', async () => {
    const { term, tracker } = mk()
    tracker.markAt(4, 'k')
    tracker.markAt(999, 'far')
    tracker.write(enc('L1\r\nL2\r\n'), 0)
    await flush(term)
    expect(tracker.get('k')).toBeDefined()
    tracker.reset()
    expect(tracker.get('k')).toBeUndefined()
    expect(tracker.pendingCount).toBe(0)
    expect(tracker.markAt(0, 'again')).toBe(true) // 水位归零后从头登记
  })

  it('滚出 scrollback 的 marker 自己失效，get 拿不到', async () => {
    const term = new Terminal({ cols: 40, rows: 3, scrollback: 2, allowProposedApi: true })
    const host = document.createElement('div')
    document.body.appendChild(host)
    term.open(host)
    terms.push(term)
    const tracker = new MarkTracker(term)
    tracker.markAt(0, 'k')
    tracker.write(enc('a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\nh\r\n'), 0)
    await flush(term)
    expect(tracker.get('k')).toBeUndefined()
  })
})
