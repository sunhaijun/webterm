/**
 * 转录视图（ADR-0012 γ）：claude / codex 在前台时读视图的画布。
 *
 * 对话卡片（用户 / 助手 Markdown / 工具摘要）原生滚动、原生选择缩放；底部常驻一条
 * 「终端尾巴」—— xterm 缓冲的最后几行纯文本 —— 看 spinner、权限提示、菜单，点它进终端。
 * 贴底跟随的规则与块流一样：在底部就跟，翻上去看旧的就不拽人；来了新内容出一枚药丸。
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { TranscriptItem } from '../protocol/messages'
import { renderMarkdown } from './markdown'

export interface TranscriptViewProps {
  source: 'claude' | 'codex' | null
  program: string
  items: TranscriptItem[]
  /** 任何会改内容的变化 +1（贴底跟随用） */
  tick: number
  /** 终端缓冲末几行（纯文本），空数组 = 还没有输出 */
  tail: string[]
  /** 底部被写态 sheet 盖住的像素数 */
  inset?: number
  onViewTerm(): void
}

export function TranscriptView({ source, program, items, tick, tail, inset = 0, onViewTerm }: TranscriptViewProps) {
  const el = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [pending, setPending] = useState(false)
  const lastCount = useRef(items.length)

  const onScroll = () => {
    const n = el.current
    if (!n) return
    atBottom.current = n.scrollHeight - n.scrollTop - n.clientHeight < 48
    if (atBottom.current) setPending(false)
  }
  useLayoutEffect(() => {
    const n = el.current
    if (!n) return
    if (atBottom.current) {
      n.scrollTop = n.scrollHeight
    } else if (items.length > lastCount.current) {
      setPending(true)
    }
    lastCount.current = items.length
  }, [tick, items.length, inset])

  const jump = () => {
    const n = el.current
    if (n) n.scrollTop = n.scrollHeight
    atBottom.current = true
    setPending(false)
  }

  return (
    <div class="transcript" data-testid="transcript" data-source={source ?? ''} style={{ '--tr-inset': `${inset}px` }}>
      <div class="tr-scroll" data-testid="transcript-scroll" ref={el} onScroll={onScroll}>
        {items.length === 0 && (
          <div class="tr-empty" data-testid="transcript-empty">
            等待 {program} 的对话。消息整块完成后出现在这里；过程看下面的终端尾巴。
          </div>
        )}
        {items.map((it) => (
          <Card key={it.id} item={it} />
        ))}
      </div>
      {pending && (
        <button class="tr-new" data-testid="transcript-new" onClick={jump}>
          ↓ 新内容
        </button>
      )}
      <button class="tr-tail" data-testid="transcript-tail" onClick={onViewTerm} title="终端当前屏幕的末几行 · 点击进终端操作">
        <span class="tr-tail-label">
          <span class="tr-tail-prog">{program}</span> 终端 · 点开操作
        </span>
        <pre class="tr-tail-lines" data-testid="transcript-tail-lines">{tail.length ? tail.join('\n') : '（还没有输出）'}</pre>
      </button>
    </div>
  )
}

function Card({ item }: { item: TranscriptItem }) {
  switch (item.role) {
    case 'user':
      return (
        <div class="tr-card tr-user" data-testid="tr-user" data-id={item.id}>
          <pre class="tr-user-text">{item.text}</pre>
        </div>
      )
    case 'assistant':
      return (
        <div class="tr-card tr-assistant" data-testid="tr-assistant" data-id={item.id}>
          <div class="tr-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
        </div>
      )
    case 'tool':
      return (
        <div class="tr-tool" data-testid="tr-tool" data-id={item.id} title={item.text}>
          <span class="tr-tool-name">{item.name ?? '工具'}</span>
          <span class="tr-tool-text">{item.text}</span>
        </div>
      )
    default:
      return (
        <div class="tr-system" data-testid="tr-system" data-id={item.id}>
          {item.text}
        </div>
      )
  }
}
