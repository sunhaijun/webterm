/**
 * Composer —— 独立的多行输入框。
 *
 * IME 组字完全发生在原生 textarea 里，所以候选框位置正确、可任意修改、
 * 可粘贴、可多行、有撤销。这【绕过了】IME 问题而不是修补它（ADR-0007）。
 *
 * 句柄上那一组编辑操作（insert / replace / move / deleteWord / history）
 * 给写态 sheet 的编辑键与 chips 用（ADR-0011 ③）—— 它们都要在【不失焦】
 * 的前提下改内容，所以做成方法而不是让外面直接碰 DOM。
 */
import { useEffect, useRef, useState } from 'preact/hooks'

import { HistoryCursor, atFirstLineStart, atLastLineEnd, fetchHistory } from './history'
import { chord } from './keymap'

export interface ComposerHandle {
  /** 把文本填进输入框并聚焦（历史/快捷命令点击时用）。 */
  fill(text: string): void
  focus(): void
  blur(): void
  value(): string
  cursor(): number
  /** 光标处插入（有选区就替换选区），保持焦点。 */
  insert(text: string): void
  /** 用 text 替换 [start, end)，光标落在替换文本之后。路径补全用。 */
  replace(start: number, end: number, text: string): void
  move(where: 'left' | 'right' | 'home' | 'end'): void
  /** 删掉光标左边一个词（连同它后面的空白）。 */
  deleteWord(): void
  history(dir: 'older' | 'newer'): void
  submit(): void
}

export interface ComposerProps {
  hidden: boolean
  onSubmit(text: string): void
  /** 直通 PTY 的字节（Ctrl+C 之类）。 */
  onRaw(bytes: string): void
  onHandle(h: ComposerHandle): void
  /** 高度变化时通知外层重新 fit 终端。 */
  onResize?(): void
  /** 内容或光标变了（写态的 chips 据此刷新）。 */
  onChange?(value: string, cursor: number): void
  onFocus?(): void
  /** 输入框已经空着时再按 Esc —— 写态用它收起 sheet。 */
  onEscapeEmpty?(): void
  placeholder?: string
}

export function Composer(props: ComposerProps) {
  const { hidden, onHandle, onResize, placeholder } = props
  const ref = useRef<HTMLTextAreaElement>(null)
  const cursor = useRef(new HistoryCursor())
  const [composing, setComposing] = useState(false)
  // 回调每次渲染都是新函数；handler 里走 ref 拿最新的，句柄本身就不用重建
  const cb = useRef(props)
  cb.current = props

  const notify = (el: HTMLTextAreaElement) => cb.current.onChange?.(el.value, el.selectionStart)
  const grow = (el: HTMLTextAreaElement) => autoGrow(el, cb.current.onResize)

  const submit = () => {
    const el = ref.current
    if (!el) return
    cb.current.onSubmit(el.value)
    el.value = ''
    cursor.current.reset()
    grow(el)
    notify(el)
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
    grow(el)
    notify(el)
  }

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
    const place = (p: number) => el.setSelectionRange(p, p)
    onHandle({
      fill(text) {
        el.value = text
        // 光标置于末尾，方便直接改后面几个字（AC-6.4）
        place(text.length)
        el.focus()
        grow(el)
        notify(el)
      },
      focus: () => el.focus(),
      blur: () => el.blur(),
      value: () => el.value,
      cursor: () => el.selectionStart,
      insert(text) {
        insertAtCursor(el, text)
        el.focus()
        grow(el)
        notify(el)
      },
      replace(start, end, text) {
        const v = el.value
        el.value = v.slice(0, start) + text + v.slice(end)
        place(start + text.length)
        el.focus()
        grow(el)
        notify(el)
      },
      move(where) {
        const v = el.value
        let p = el.selectionStart
        switch (where) {
          case 'left':
            p = Math.max(0, p - 1)
            break
          case 'right':
            p = Math.min(v.length, p + 1)
            break
          case 'home':
            p = v.lastIndexOf('\n', p - 1) + 1
            break
          case 'end': {
            const i = v.indexOf('\n', p)
            p = i < 0 ? v.length : i
          }
        }
        place(p)
        el.focus()
        notify(el)
      },
      deleteWord() {
        const v = el.value
        const left = v.slice(0, el.selectionStart).replace(/\S+\s*$/, '')
        el.value = left + v.slice(el.selectionEnd)
        place(left.length)
        el.focus()
        grow(el)
        notify(el)
      },
      history: (dir) => void browse(dir),
      submit,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onHandle, onResize])

  return (
    <textarea
      class="composer"
      ref={ref}
      data-testid="composer"
      data-composing={composing ? 'true' : 'false'}
      hidden={hidden}
      rows={1}
      placeholder={placeholder}
      // 这四个属性在上面的 effect 里用 setAttribute 设，原因见那里
      enterkeyhint="send"
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onFocus={() => cb.current.onFocus?.()}
      onInput={(e) => {
        grow(e.currentTarget)
        notify(e.currentTarget)
      }}
      onSelect={(e) => notify(e.currentTarget)}
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
          cb.current.onRaw(chord('c', { ctrl: true }))
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
          grow(el)
          notify(el)
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          if (el.value !== '') {
            el.value = ''
            cursor.current.reset()
            grow(el)
            notify(el)
          } else {
            cb.current.onEscapeEmpty?.()
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
