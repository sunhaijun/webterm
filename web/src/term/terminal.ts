/**
 * xterm 封装：渲染、滚动、搜索。
 *
 * 见 docs/40-frontend/layout-responsive.md 的「渲染」一节。
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'

/** scrollback 至少 5000 行（AC-5.1）。 */
export const SCROLLBACK = 5000

export interface TermHandle {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  serialize: SerializeAddon
  /** 挂 WebGL；失败时静默回退到 canvas（AC-5.5）。 */
  attachWebgl(): void
  /** 卸掉 WebGL —— 切走的会话必须放掉上下文，见下面的注释。 */
  detachWebgl(): void
  /**
   * 备用屏幕缓冲是否激活（ADR-0011 分片 ②）。
   *
   * vim / top / less / htop 都会 DECSET 1049 切到备用缓冲，普通流式命令
   * 不会 —— 这是"有程序占屏"的机械信号，比 prompt_state=running 精确：
   * sleep 100 和 top 都是 running，只有 top 切了备用缓冲。
   */
  altScreen(): boolean
  dispose(): void
}

export function createTerminal(fontSize: number): TermHandle {
  const term = new Terminal({
    fontSize,
    fontFamily:
      'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace',
    scrollback: SCROLLBACK,
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    theme: { background: '#111111', foreground: '#e6e6e6' },
  })

  const fit = new FitAddon()
  const search = new SearchAddon()
  const serialize = new SerializeAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(serialize)

  // 正确计算 CJK 与 emoji 的宽度，否则中英混排会错位
  const uni = new Unicode11Addon()
  term.loadAddon(uni)
  term.unicode.activeVersion = '11'

  let webgl: WebglAddon | null = null

  const attachWebgl = () => {
    if (webgl) return
    try {
      const addon = new WebglAddon()
      // 上下文丢了就回退，不要留一个黑屏
      addon.onContextLoss(() => {
        addon.dispose()
        webgl = null
      })
      term.loadAddon(addon)
      webgl = addon
    } catch {
      // webgl2 创建失败或 addon 抛异常 → 静默回退到默认 canvas renderer
      webgl = null
    }
  }

  const detachWebgl = () => {
    // 浏览器的 WebGL 上下文数有上限（Chrome 约 16 个），而会话上限是 20
    // 且切走的 xterm 实例不销毁 —— 全挂上必然撞线，症状是别的终端莫名变黑。
    // 所以只有当前可见的终端持有上下文。
    webgl?.dispose()
    webgl = null
  }

  return {
    term,
    fit,
    search,
    serialize,
    attachWebgl,
    detachWebgl,
    altScreen: () => term.buffer.active.type === 'alternate',
    dispose() {
      detachWebgl()
      term.dispose()
    },
  }
}
