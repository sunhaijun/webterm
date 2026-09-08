/**
 * 把终端滚到一个块的开头 —— ADR-0011 分片 ④。
 *
 * 首选 marker（精确到行，见 marks.ts）；开头已滚出 scrollback 就停在块尾；
 * 没有 marker 就按命令原文搜（同名块从底往上数第 k 次命中）；都不行滚到底 ——
 * 至少别让人对着一片老输出发呆。返回用了哪种办法，测试与诊断用。
 */
import type { SearchAddon } from '@xterm/addon-search'
import type { IMarker, Terminal } from '@xterm/xterm'

import type { Block } from '../commands/blocks'

export type LocateHow = 'marker' | 'marker-end' | 'search' | 'bottom'

export interface LocateTarget {
  term: Terminal
  search: SearchAddon
  start?: IMarker
  end?: IMarker
}

/** 高亮多久。够看清"就是这块"，又不至于像个常驻的选区。 */
export const HIGHLIGHT_MS = 1600

export function locateBlock(t: LocateTarget, block: Block, siblings: Block[]): LocateHow {
  const { term } = t
  const start = t.start && !t.start.isDisposed ? t.start : undefined
  const end = t.end && !t.end.isDisposed ? t.end : undefined
  if (start) {
    term.scrollToLine(start.line)
    highlight(term, start, end ? Math.max(1, end.line - start.line) : 1)
    return 'marker'
  }
  if (end) {
    term.scrollToLine(Math.max(0, end.line - term.rows))
    return 'marker-end'
  }
  const needle = block.text.split('\n')[0]!.trim().slice(0, 40)
  if (needle) {
    // 同名块：这块之后还有几个同名的，就从底往上多数几次
    const later = siblings.filter((b) => b.text === block.text && b.cmdId > block.cmdId).length
    term.scrollToBottom()
    term.clearSelection()
    let ok = true
    for (let i = 0; i <= later && ok; i++) ok = t.search.findPrevious(needle, { caseSensitive: true })
    if (ok) return 'search'
  }
  term.scrollToBottom()
  return 'bottom'
}

/** 给块的范围盖一层短暂的底色。渲染层负责画，我们只登记与到点撤掉。 */
export function highlight(term: Terminal, marker: IMarker, height: number, ms = HIGHLIGHT_MS): void {
  const deco = term.registerDecoration({
    marker,
    width: term.cols,
    height,
    backgroundColor: '#2b3d55',
    layer: 'bottom',
  })
  if (!deco) return
  setTimeout(() => deco.dispose(), ms)
}
