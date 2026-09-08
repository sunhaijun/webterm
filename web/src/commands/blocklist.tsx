/**
 * 命令块列表 —— 读视图（ReadView）与块面板（BlocksPanel）共用的渲染。
 *
 * 一屏二十来行，而一次 `npm install` 几百行。连续的 scrollback 逼着人
 * 用手指去翻"上一条命令在哪儿结束、失败的是哪一条"。这里把每条命令
 * 连同它的输出收成一个可折叠的块。
 *
 * 【失败的块默认展开】—— 你会去翻块列表，多半就是因为有东西挂了。
 * 【运行中的块永远展开】—— 它就是 live-tail。
 *
 * 渲染分两档（ADR-0011）：运行中的块用纯文本，每次输出到达都重画，
 * 便宜到可以 120ms 一次；结束后用离屏 xterm 精确渲染【一次】，
 * 颜色、进度条的 \r 覆盖写、光标移动都按终端语义算。
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

import { type Block, type BlockBytes } from './blocks'
import { plainText, renderBlockHTML } from './blockrender'
import { ellipsize, formatDuration } from './api'

export const failed = (b: Block) => b.exitCode !== null && b.exitCode !== 0
export const isRunning = (b: Block) => b.endSeq === null

export interface BlockActions {
  onFill(text: string): void
  onRun?(text: string): void
  onCopy?(text: string): void
  /** "在终端里看"：块承载不了的输出（对齐表格、彩色 diff）需要门。 */
  onViewTerm?(b: Block): void
}

export interface BlockListProps extends BlockActions {
  blocks: Block[]
  bytesOf(b: Block): BlockBytes | null
  /** 产生这些输出时的终端宽度，渲染要按它折行。 */
  cols: number
  /** 面板里最新在上（翻着找）；读视图里最新在下（像对话）。 */
  order: 'newest-first' | 'oldest-first'
  open: Set<number>
  onToggle(id: number): void
  /** 尾块：没有被任何块认领的输出（降级形态），非空才渲染。 */
  tail?: BlockBytes | null
  tailLabel?: string
}

export function BlockList({ blocks, bytesOf, cols, order, open, onToggle, tail, tailLabel, ...actions }: BlockListProps) {
  const ordered = order === 'newest-first' ? blocks.slice().reverse() : blocks
  return (
    <>
      {ordered.map((b) => (
        <BlockRow
          // 结束时换 key：从"纯文本 live"切到"离屏精确渲染"要重挂一次
          key={`${b.cmdId}:${isRunning(b) ? 'run' : 'done'}`}
          block={b}
          bytes={bytesOf(b)}
          cols={cols}
          open={open.has(b.cmdId) || isRunning(b)}
          onToggle={() => onToggle(b.cmdId)}
          actions={actions}
        />
      ))}
      {tail && tail.bytes.length > 0 && <TailBlock bytes={tail} label={tailLabel ?? '当前输出'} />}
    </>
  )
}

interface RowProps {
  block: Block
  bytes: BlockBytes | null
  cols: number
  open: boolean
  onToggle(): void
  actions: BlockActions
}

function BlockRow({ block, bytes, cols, open, onToggle, actions }: RowProps) {
  const running = isRunning(block)
  const [html, setHtml] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  // 结束后的精确渲染【只做一次】。展开/折叠会反复触发 render，每次都开
  // 一遍模拟器的话，长输出上会明显卡。
  const done = useRef(false)
  // 用"是否已卸载"判断结果还要不要，【不能用 effect 的 cleanup】：live-tail
  // 每 120ms 重渲染一次、bytes 每次都是新对象，effect 若依赖它就会反复重跑，
  // cleanup 把在途的渲染标成作废，回来时被丢弃，而 done 又不让再发 ——
  // 块永远停在"渲染中…"（真踩到了：失败块自动展开那一刻恰好撞上节流重渲染）。
  const mounted = useRef(true)
  useEffect(() => () => {
    mounted.current = false
  }, [])

  const len = bytes?.bytes.length ?? -1
  const truncated = bytes?.truncated ?? false
  useEffect(() => {
    if (running || !open || done.current || !bytes) return
    // 【字节没齐就不渲染】。command.end 是 JSON 消息，可能先于最后一帧二进制
    // 到达 —— 那一刻 bytesOf 切出来的不完整甚至为空。等下一次重渲染再看。
    const expected = block.endSeq === null ? 0 : block.endSeq - block.startSeq
    if (!truncated && len < expected) return
    done.current = true
    const data = bytes.bytes
    renderBlockHTML(data, cols).then((h) => {
      if (!mounted.current) return
      if (h) setHtml(h)
      else setText(plainText(data)) // 渲染器不可用时的兜底
    })
    // 依赖只放原始值：同样内容的新 bytes 对象不该让 effect 重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, open, len, truncated, cols, block.startSeq, block.endSeq])

  // 运行中：纯文本 live-tail，随每次输出重算（便宜）
  const live = useMemo(() => (running && bytes ? plainText(bytes.bytes) : null), [running, bytes?.bytes.length, bytes])

  const lines = bytes ? countLines(bytes.bytes) : 0
  const cmdText = block.text

  return (
    <div class="block" data-testid={`block-${block.cmdId}`} data-failed={failed(block)} data-running={running} data-open={open}>
      <div class="block-head" onClick={onToggle}>
        <span class="block-mark" data-failed={failed(block)} data-running={running}>
          {running ? '⟳' : failed(block) ? '✗' : '✓'}
        </span>
        <span class="block-cmd">{ellipsize(cmdText, 60)}</span>
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
          {running ? (
            <pre class="block-out block-live" data-testid={`block-${block.cmdId}-live`}>{live ?? ''}</pre>
          ) : html !== null ? (
            <div class="block-out" dangerouslySetInnerHTML={{ __html: html }} />
          ) : text !== null ? (
            <pre class="block-out">{text}</pre>
          ) : (
            <div class="block-out block-pending">渲染中…</div>
          )}
          {!running && (
            <div class="block-actions">
              {actions.onRun && (
                <button data-testid={`block-${block.cmdId}-rerun`} onClick={() => actions.onRun!(cmdText)}>
                  重跑
                </button>
              )}
              <button data-testid={`block-${block.cmdId}-fill`} onClick={() => actions.onFill(cmdText)}>
                填入命令
              </button>
              {actions.onCopy && (
                <button
                  data-testid={`block-${block.cmdId}-copy`}
                  onClick={() => actions.onCopy!(bytes ? plainText(bytes.bytes) : '')}
                >
                  复制输出
                </button>
              )}
              {actions.onViewTerm && (
                <button data-testid={`block-${block.cmdId}-term`} onClick={() => actions.onViewTerm!(block)}>
                  在终端里看
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 尾块：降级形态。永远展开、纯文本、随输出重画。 */
function TailBlock({ bytes, label }: { bytes: BlockBytes; label: string }) {
  const text = useMemo(() => plainText(bytes.bytes), [bytes.bytes.length, bytes])
  return (
    <div class="block block-tail" data-testid="block-tail" data-open="true">
      <div class="block-head">
        <span class="block-mark" data-running="true">
          ·
        </span>
        <span class="block-cmd block-cmd-muted">{label}</span>
        <span class="block-lines">{countLines(bytes.bytes)} 行</span>
      </div>
      <div class="block-body">
        {bytes.truncated && <div class="block-truncated">开头的输出已经滚出保留窗口。</div>}
        <pre class="block-out block-live">{text}</pre>
      </div>
    </div>
  )
}

export function countLines(b: Uint8Array): number {
  let n = 0
  for (const c of b) if (c === 0x0a) n++
  return n
}
