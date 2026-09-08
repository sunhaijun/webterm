/**
 * 命令块面板 —— docs/40-frontend/commands-ux.md。
 *
 * 一屏二十来行，而一次 `npm install` 几百行。连续的 scrollback 逼着人
 * 用手指去翻"上一条命令在哪儿结束、失败的是哪一条"。这里把每条命令
 * 连同它的输出收成一个可折叠的块：默认只显示标题行，点开才展开。
 *
 * 【失败的块默认展开】—— 你会去翻块列表，多半就是因为有东西挂了。
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { type Block, type BlockBytes } from './blocks'
import { plainText, renderBlockHTML } from './blockrender'
import { ellipsize, formatDuration } from './api'

export interface BlocksPanelProps {
  blocks: Block[]
  bytesOf(b: Block): BlockBytes | null
  /** 产生这些输出时的终端宽度，渲染要按它折行。 */
  cols: number
  onClose(): void
  onFill(text: string): void
}

const failed = (b: Block) => b.exitCode !== null && b.exitCode !== 0

export function BlocksPanel({ blocks, bytesOf, cols, onClose, onFill }: BlocksPanelProps) {
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [open, setOpen] = useState<Set<number>>(() => new Set(blocks.filter(failed).map((b) => b.cmdId)))

  const toggle = useCallback((id: number) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const shown = (onlyFailed ? blocks.filter(failed) : blocks).slice().reverse()

  return (
    <div class="panel-backdrop" onClick={onClose}>
      <div class="panel" data-testid="blocks-panel" onClick={(e) => e.stopPropagation()}>
        <div class="panel-head">
          <span>命令块</span>
          <button data-testid="blocks-only-failed" data-on={onlyFailed} onClick={() => setOnlyFailed((v) => !v)}>
            只看失败
          </button>
          <span style="flex:1" />
          <button data-testid="blocks-close" onClick={onClose}>
            关闭
          </button>
        </div>
        <div class="panel-body" data-testid="blocks-body">
          {shown.length === 0 && <div class="blocks-empty">还没有命令。跑一条就会出现在这里。</div>}
          {shown.map((b) => (
            <BlockRow
              key={b.cmdId}
              block={b}
              bytes={bytesOf(b)}
              cols={cols}
              open={open.has(b.cmdId)}
              onToggle={() => toggle(b.cmdId)}
              onFill={() => onFill(b.text)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

interface RowProps {
  block: Block
  bytes: BlockBytes | null
  cols: number
  open: boolean
  onToggle(): void
  onFill(): void
}

function BlockRow({ block, bytes, cols, open, onToggle, onFill }: RowProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  // 【渲染只做一次】。展开/折叠会反复触发 render，每次都开一遍模拟器
  // 的话，长输出上会明显卡。
  const done = useRef(false)

  useEffect(() => {
    if (!open || done.current || !bytes) return
    done.current = true
    let alive = true
    renderBlockHTML(bytes.bytes, cols).then((h) => {
      if (!alive) return
      if (h) setHtml(h)
      else setText(plainText(bytes.bytes)) // 渲染器不可用时的兜底
    })
    return () => {
      alive = false
    }
  }, [open, bytes, cols])

  const running = block.endSeq === null
  const lines = bytes ? countLines(bytes.bytes) : 0

  return (
    <div class="block" data-testid={`block-${block.cmdId}`} data-failed={failed(block)} data-open={open}>
      <div class="block-head" onClick={onToggle}>
        <span class="block-mark" data-failed={failed(block)} data-running={running}>
          {running ? '·' : failed(block) ? '✗' : '✓'}
        </span>
        <span class="block-cmd">{ellipsize(block.text, 60)}</span>
        {!running && block.exitCode !== 0 && block.exitCode !== null && (
          <span class="block-exit">exit {block.exitCode}</span>
        )}
        <span class="block-dur">{running ? '运行中' : formatDuration(block.durationMs)}</span>
        <span class="block-lines">{lines > 0 ? `${lines} 行` : ''}</span>
      </div>
      {open && (
        <div class="block-body">
          {bytes?.truncated && (
            <div class="block-truncated" data-testid={`block-${block.cmdId}-truncated`}>
              开头的输出已经滚出保留窗口，下面不是完整内容。
            </div>
          )}
          {html !== null ? (
            <div class="block-out" dangerouslySetInnerHTML={{ __html: html }} />
          ) : text !== null ? (
            <pre class="block-out">{text}</pre>
          ) : (
            <div class="block-out block-pending">渲染中…</div>
          )}
          <div class="block-actions">
            <button data-testid={`block-${block.cmdId}-fill`} onClick={onFill}>
              填入命令
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function countLines(b: Uint8Array): number {
  let n = 0
  for (const c of b) if (c === 0x0a) n++
  return n
}
