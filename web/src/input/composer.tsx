/**
 * Composer —— 独立的多行输入框。
 *
 * IME 组字完全发生在原生 textarea 里，所以候选框位置正确、可任意修改、
 * 可粘贴、可多行、有撤销。这【绕过了】IME 问题而不是修补它（ADR-0007）。
 */
import { useEffect, useRef, useState } from 'preact/hooks'

import { HistoryCursor, atFirstLineStart, atLastLineEnd, fetchHistory } from './history'
import { chord } from './keymap'

export interface ComposerHandle {
  /** 把文本填进输入框并聚焦（历史/快捷命令点击时用）。 */
  fill(text: string): void
  focus(): void
}

export interface ComposerProps {
  hidden: boolean
  onSubmit(text: string): void
  /** 直通 PTY 的字节（Ctrl+C 之类）。 */
  onRaw(bytes: string): void
  onHandle(h: ComposerHandle): void
  /** 高度变化时通知外层重新 fit 终端。 */
  onResize?(): void
}

export function Composer({ hidden, onSubmit, onRaw, onHandle, onResize }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const cursor = useRef(new HistoryCursor())
  const [composing, setComposing] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 【必须用 setAttribute】。Chrome 把 autocorrect 实现成了 boolean IDL
    // 属性，JSX 里写 autocorrect="off" 会让框架去赋【属性】—— "off" 是个
    // 真值，于是反射出来的是 autocorrect="on"，正好是反的。
    // 而移动端的自动纠正会把 cd 改成 Cd、把 ls 改成 is（AC-3.10）。
    for (const [k, v] of [
      ['autocorrect', 'off'],
      ['autocapitalize', 'off'],
      ['autocomplete', 'off'],
      ['spellcheck', 'false'],
    ] as const) {
      el.setAttribute(k, v)
    }
    onHandle({
      fill(text) {
        el.value = text
        // 光标置于末尾，方便直接改后面几个字（AC-6.4）
        el.setSelectionRange(text.length, text.length)
        el.focus()
        autoGrow(el, onResize)
      },
      focus: () => el.focus(),
    })
  }, [onHandle, onResize])

  const submit = () => {
    const el = ref.current
    if (!el) return
    onSubmit(el.value)
    el.value = ''
    cursor.current.reset()
    autoGrow(el, onResize)
  }

  const browse = async (dir: 'older' | 'newer') => {
    const el = ref.current
    if (!el) return
    if (!cursor.current.browsing) {
      // 有输入内容时做前缀匹配，空输入时翻全部
      const prefix = el.value
      const items = await fetchHistory(prefix)
      cursor.current.load(prefix, items, el.value)
    }
    const next = dir === 'older' ? cursor.current.older() : cursor.current.newer()
    if (next.text === null) return
    el.value = next.text
    el.setSelectionRange(next.text.length, next.text.length)
    autoGrow(el, onResize)
  }

  return (
    <textarea
      class="composer"
      ref={ref}
      data-testid="composer"
      data-composing={composing ? 'true' : 'false'}
      hidden={hidden}
      rows={1}
      // 这四个属性在上面的 effect 里用 setAttribute 设，原因见那里
      enterkeyhint="send"
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onInput={(e) => autoGrow(e.currentTarget, onResize)}
      onKeyDown={(e) => {
        const el = e.currentTarget

        // 【组字期间按 Enter 是在选词，绝不能提交】。
        // 这是中文输入的关键一点 —— 漏了它，按 Enter 选词就会误提交。
        if (e.isComposing) return

        if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
          e.preventDefault()
          submit()
          return
        }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          submit()
          return
        }
        // Ctrl+C 在 Composer 里也直通 PTY —— 用户按它的意图几乎总是打断进程
        if (e.key === 'c' && e.ctrlKey && !e.shiftKey && el.selectionStart === el.selectionEnd) {
          e.preventDefault()
          onRaw(chord('c', { ctrl: true }))
          return
        }
        if (e.key === 'ArrowUp' && atFirstLineStart(el.value, el.selectionStart, el.selectionEnd)) {
          e.preventDefault()
          void browse('older')
          return
        }
        if (e.key === 'ArrowDown' && atLastLineEnd(el.value, el.selectionStart, el.selectionEnd)) {
          e.preventDefault()
          void browse('newer')
          return
        }
        if (e.key === 'Tab') {
          // v0.1 插两个空格，补全留给 v0.2
          e.preventDefault()
          insertAtCursor(el, '  ')
          autoGrow(el, onResize)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          if (el.value !== '') {
            el.value = ''
            cursor.current.reset()
            autoGrow(el, onResize)
          }
          return
        }
      }}
    />
  )
}

/** 高度随内容增长，上限 40vh，超出后内部滚动。 */
function autoGrow(el: HTMLTextAreaElement, onResize?: () => void): void {
  const before = el.style.height
  el.style.height = 'auto'
  const max = Math.round(window.innerHeight * 0.4)
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
  if (el.style.height !== before) onResize?.()
}

function insertAtCursor(el: HTMLTextAreaElement, text: string): void {
  const { selectionStart: s, selectionEnd: e, value } = el
  el.value = value.slice(0, s) + text + value.slice(e)
  el.setSelectionRange(s + text.length, s + text.length)
}
