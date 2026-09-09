/**
 * 读视图 —— ADR-0011 的常驻画布。
 *
 * 手机上默认看到的不是终端网格，而是这里：命令块流，最新在下，原生滚动。
 * 正在跑的块在底部 live-tail；没有标记时最后一块之后的输出作为尾块。
 *
 * 【贴底跟随】：用户在看最新输出时新内容要自动跟上；翻到上面去看旧块
 * 时【不能】把人拽回底部。以"更新前是否已在底部"为准。
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks'

import { type Block, type BlockBytes } from './blocks'
import { BlockList, failed, type BlockActions } from './blocklist'

export interface ReadViewProps extends BlockActions {
  blocks: Block[]
  bytesOf(b: Block): BlockBytes | null
  tail: BlockBytes | null
  /** 尾块什么时候值得显示：没有集成 / 输入去了子程序 / 尾巴大到不像是 prompt 重画 */
  showTail: boolean
  cols: number
  /** 任何会改变内容的变化都让它 +1，用来触发贴底跟随 */
  tick: number
  /** 底部被写态 sheet 盖住的像素数（ADR-0011 ③）。变了要重新贴底。 */
  inset?: number
  /** 活动会话是否有程序占屏（运行中的块改提示去终端，不拍扁）。 */
  interactive?: boolean
}

/** prompt 重画通常几十个字节；超过这个就不只是 prompt 了。 */
export const TAIL_NOISE_BYTES = 256

export function ReadView({ blocks, bytesOf, tail, showTail, cols, tick, inset = 0, interactive = false, ...actions }: ReadViewProps) {
  const el = useRef<HTMLDivElement>(null)
  // 最大化的块 id（铺满整屏细看）；null 无
  const [maximized, setMaximized] = useState<number | null>(null)
  // 失败的块默认展开；用户手动折叠/展开的记在这里
  const [open, setOpen] = useState<Set<number>>(() => new Set(blocks.filter(failed).map((b) => b.cmdId)))
  // 【按"变成失败"那一刻判断，不是按"首次出现"】：块刚出现时还在跑、退出码
  // 未知；跑完才知道失败。只在首次出现时判会让每个失败块都保持折叠 ——
  // 真踩到了。用一个"已处理过失败态"的集合，保证只自动展开一次，
  // 用户之后手动折叠不会被再次撑开。
  const autoOpened = useRef<Set<number>>(new Set(blocks.filter(failed).map((b) => b.cmdId)))
  for (const b of blocks) {
    if (failed(b) && !autoOpened.current.has(b.cmdId)) {
      autoOpened.current.add(b.cmdId)
      if (!open.has(b.cmdId)) {
        const next = new Set(open)
        next.add(b.cmdId)
        setOpen(next)
      }
    }
  }

  const atBottom = useRef(true)
  const onScroll = () => {
    const n = el.current
    if (!n) return
    atBottom.current = n.scrollHeight - n.scrollTop - n.clientHeight < 48
  }
  useLayoutEffect(() => {
    const n = el.current
    if (n && atBottom.current) n.scrollTop = n.scrollHeight
  }, [tick, blocks.length, inset])

  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const empty = blocks.length === 0 && !(showTail && tail && tail.bytes.length > 0)
  return (
    <div class="stream" data-testid="stream" data-tick={tick} ref={el} onScroll={onScroll}>
      {empty && (
        <div class="stream-empty" data-testid="stream-empty">
          还没有命令。在下面输入一条，它的输出会以块的形式出现在这里。
        </div>
      )}
      <BlockList
        blocks={blocks}
        bytesOf={bytesOf}
        cols={cols}
        order="oldest-first"
        open={open}
        onToggle={toggle}
        maximized={maximized}
        onMaximize={setMaximized}
        interactive={interactive}
        tail={showTail ? tail : null}
        tailLabel="没有命令边界的输出"
        {...actions}
      />
    </div>
  )
}
