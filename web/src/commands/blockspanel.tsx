/**
 * 命令块面板 —— 终端视图里的模态入口。读视图（ADR-0011）已经把块流
 * 当主画布，这里只剩一层壳：最新在上、只看失败、关闭。渲染在 BlockList。
 */
import { useCallback, useState } from 'preact/hooks'

import { type Block, type BlockBytes } from './blocks'
import { BlockList, failed } from './blocklist'

export interface BlocksPanelProps {
  blocks: Block[]
  bytesOf(b: Block): BlockBytes | null
  /** 产生这些输出时的终端宽度，渲染要按它折行。 */
  cols: number
  onClose(): void
  onFill(text: string): void
  /** 「在终端里看」：定位到该块（ADR-0011 ④）。 */
  onViewTerm?(b: Block): void
}

export function BlocksPanel({ blocks, bytesOf, cols, onClose, onFill, onViewTerm }: BlocksPanelProps) {
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [maximized, setMaximized] = useState<number | null>(null)
  const [open, setOpen] = useState<Set<number>>(() => new Set(blocks.filter(failed).map((b) => b.cmdId)))

  const toggle = useCallback((id: number) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const shown = onlyFailed ? blocks.filter(failed) : blocks

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
          <BlockList
            blocks={shown}
            bytesOf={bytesOf}
            cols={cols}
            order="newest-first"
            open={open}
            onToggle={toggle}
            maximized={maximized}
            onMaximize={setMaximized}
            onFill={onFill}
            onViewTerm={onViewTerm}
          />
        </div>
      </div>
    </div>
  )
}
