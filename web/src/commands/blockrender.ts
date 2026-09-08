/**
 * 把一个命令块的原始字节渲染成 HTML。
 *
 * 【用真的模拟器，不手写 ANSI 解析】。命令输出里什么都有：SGR 颜色、
 * \r 覆盖写的进度条（npm / pip 都这么干）、光标移动、擦除。手写一个
 * "够用"的解析器，早晚会在某个进度条上吐出一屏乱码 —— 而那恰恰是
 * 用户最想折叠起来的那类输出。
 *
 * 所以开一个离屏 xterm 当渲染器：把字节喂进去，让它按终端语义算出
 * 最终屏幕内容，再用 serialize addon 导出 HTML。一次渲一个块，
 * 复用同一个实例。
 */
import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/xterm'

/** 单个块最多渲染多少行 —— 再多也没人看，还拖慢页面。 */
export const MAX_RENDER_ROWS = 2000

interface Offscreen {
  term: Terminal
  ser: SerializeAddon
}

let off: Offscreen | null = null

function offscreen(cols: number): Offscreen {
  if (!off) {
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px;overflow:hidden'
    document.body.appendChild(host)
    const term = new Terminal({
      cols,
      // 【rows 取 1】。serializeAsHTML 会把【整个视口】都导出来，
      // 24 行的视口意味着一行输出也要拖着 23 行空白 —— 在手机上
      // 一个块就占满整屏。把视口压到 1 行，输出全部落进 scrollback，
      // 导出的行数就等于真实产出的行数。
      rows: 1,
      scrollback: MAX_RENDER_ROWS,
      allowProposedApi: true,
      // 主题必须和真终端一致，否则导出的 HTML 自带一套配色，
      // 贴进面板里就是白底黑字的一块。
      theme: { background: '#111111', foreground: '#e6e6e6' },
    })
    const ser = new SerializeAddon()
    term.loadAddon(ser)
    term.open(host)
    off = { term, ser }
  }
  if (off.term.cols !== cols) off.term.resize(cols, off.term.rows)
  return off
}

/**
 * 渲染一段输出。
 *
 * cols 必须和产生这段输出时的终端宽度一致 —— 不一致的话换行位置会错，
 * 表格和进度条都会散。
 */
export function renderBlockHTML(bytes: Uint8Array, cols: number): Promise<string> {
  return new Promise((resolve) => {
    let o: Offscreen
    try {
      o = offscreen(Math.max(cols, 20))
    } catch {
      resolve('') // 渲染器起不来，交给调用方走纯文本兜底
      return
    }
    o.term.reset()
    if (bytes.length === 0) {
      // xterm 对空写入【不回调】—— 不处理这条，promise 会永远挂着，UI 停在"渲染中…"
      resolve('')
      return
    }
    o.term.write(bytes, () => {
      try {
        resolve(o.ser.serializeAsHTML({ scrollback: MAX_RENDER_ROWS }))
      } catch {
        resolve('')
      }
    })
  })
}

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const OTHER_ESC = /\x1b[@-Z\\-_]/g

/**
 * 纯文本渲染：剥掉转义序列，按 \r 覆盖写。
 *
 * 运行中的块和尾块用它（便宜，随每次输出重画）；结束后的块走离屏 xterm。
 *
 * 【行尾的 \r 不是覆盖写，是换行的一半】。PTY 吐出来的是 CRLF：
 * "AAA\r\nBBB\r\n"。先按 \n 切行再按 \r 取最后一段，每行都会变成空串 ——
 * 整块内容凭空消失（真踩到了：live-tail 一直是空白）。所以先把 \r\n
 * 归一成 \n，只有行【内】的 \r 才是进度条那种回到行首重画。
 *
 * 行内 \r 取最后一个【非空】段：进度条刚打出 \r 还没重画的瞬间，最后一段
 * 是空的，这时该显示上一帧而不是一片空白。
 */
export function plainText(bytes: Uint8Array): string {
  const raw = new TextDecoder().decode(bytes)
  const noEsc = raw.replace(OSC, '').replace(CSI, '').replace(OTHER_ESC, '')
  return noEsc
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      const parts = line.split('\r')
      for (let i = parts.length - 1; i >= 0; i--) {
        if (parts[i] !== '') return parts[i] ?? ''
      }
      return ''
    })
    .join('\n')
}
