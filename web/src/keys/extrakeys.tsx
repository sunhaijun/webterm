/**
 * 附加键区（AC-3.18 / AC-3.19，input.md）：80px 的定高槽，两页 ——
 * 键位页（Termux 默认 14 键）和文本输入页（一个两行的 textarea）。左边 44px 的固定列：
 * compact 是会话按钮（上，方框里写会话数）与 ✎（下），wide 只有 ✎。两页高度相同，切换不改终端几何。
 *
 * 停在哪一页、文本框里的草稿是**每个会话各一份**（AC-3.22，ADR-0036），由装配层记着：
 * 这里只显示当前会话的那一页，翻页交给 `onTogglePage`，文本框的 DOM 交给 `register`。
 *
 * 所有键在 pointerdown 时 preventDefault：按附加键不让软键盘收起或弹出，焦点不动。
 * 字节在 pointerup 的派发里发（`term.input()`，走 onData 出口），这样在键区上横滑
 * 可以切页而不误按键；CTRL / ALT 长按锁定也要等抬起才知道是点还是按。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { Form } from '../app/form'
import { EditIcon } from '../ui/icons'
import { PressTracker } from '../ui/longpress'
import { capturePointer } from '../ui/pointer'
import { EXTRA_KEYS, appAction, isModifierKey, type ExtraKeyId, type Sticky } from './keymap'
import { isPageSwipe, textEnter, type KeyPage, type TextPageEls, type TextSend } from './textpage'

export interface ExtraKeysProps {
  form: Form
  /** 会话数：写在会话按钮的方框里。 */
  count: number
  /** 任一非当前会话有未读：会话按钮上的小红点。 */
  unread: boolean
  sticky: Sticky
  /** 当前会话停在哪一页。 */
  page: KeyPage
  onOpenSessions(): void
  /** ✎ 或键区横滑：翻当前会话的页（装配层同步翻 DOM 并处理焦点）。 */
  onTogglePage(): void
  /** 一个非修饰键被按下（在 pointerup 的派发里调用）。 */
  onKey(id: ExtraKeyId): void
  /** 文本页回车（在 keydown 的派发里调用）。 */
  onSend(send: TextSend): void
  register(els: TextPageEls | null): void
}

const noFocus = (e: Event) => e.preventDefault()

export function ExtraKeys(p: ExtraKeysProps) {
  const page = p.page
  const slotRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const press = useRef(new PressTracker()).current
  const gesture = useRef<{ x: number; y: number; key: ExtraKeyId | null } | null>(null)
  const [, setTick] = useState(0)
  const rerender = () => setTick((n) => n + 1)

  useEffect(() => p.sticky.subscribe(rerender), [p.sticky])

  useLayoutEffect(() => {
    const ta = taRef.current
    const slot = slotRef.current
    if (!ta || !slot) return
    // 【必须 setAttribute】（AC-3.10）：Chrome 把 autocorrect 实现成 boolean IDL 属性，
    // 写在 JSX 里框架会去赋属性，"off" 是真值，反射出来的 attribute 变成 autocorrect="on"
    ta.setAttribute('autocorrect', 'off')
    ta.setAttribute('autocapitalize', 'off')
    ta.setAttribute('spellcheck', 'false')
    ta.setAttribute('autocomplete', 'off')
    ta.setAttribute('enterkeyhint', 'send')
    p.register({ slot, text: ta })
    return () => p.register(null)
  }, [])

  const onDown = (e: PointerEvent) => {
    const keyEl = (e.target as Element).closest<HTMLElement>('[data-key]')
    const key = (keyEl?.dataset.key as ExtraKeyId | undefined) ?? null
    if (page === 'keys') {
      e.preventDefault() // 不抢焦点
      capturePointer(e.currentTarget as Element, e.pointerId)
    }
    gesture.current = { x: e.clientX, y: e.clientY, key: page === 'keys' ? key : null }
    if (key && isModifierKey(key) && page === 'keys') {
      const mod = key === 'Ctrl' ? 'ctrl' : 'alt'
      press.down(e.clientX, e.clientY, () => p.sticky.hold(mod))
    }
  }

  const onUp = (e: PointerEvent) => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    if (isPageSwipe(e.clientX - g.x, e.clientY - g.y)) {
      press.cancel()
      p.onTogglePage()
      return
    }
    if (!g.key) {
      press.cancel()
      return
    }
    if (isModifierKey(g.key)) {
      if (press.up() === 'tap') p.sticky.tap(g.key === 'Ctrl' ? 'ctrl' : 'alt')
      return
    }
    p.onKey(g.key)
  }

  const onTextKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return
    if (appAction(e) !== null) return // Ctrl+Shift+Enter 是新建会话，交给全局快捷键
    const ta = e.currentTarget as HTMLTextAreaElement
    const send = textEnter(ta.value, e)
    if (send.kind === 'none') return // 组字中：交给输入法选词
    e.preventDefault() // 回车永远不在文本框里插入换行
    ta.value = ''
    p.onSend(send) // 发完留在文本页、焦点不动
  }

  return (
    <div class="extrakeys" data-testid="extrakeys" data-page={page} ref={slotRef}>
      <div class="ek-side">
        {p.form === 'compact' && (
          <button
            type="button"
            class="ek-side-btn"
            data-testid="open-sessions"
            data-unread={p.unread ? 'true' : 'false'}
            aria-label={p.unread ? `${p.count} 个会话（有新输出）` : `${p.count} 个会话`}
            onPointerDown={noFocus}
            onClick={p.onOpenSessions}
          >
            {/* 手机浏览器「标签页」按钮的样子：圆角方框里写会话数（ADR-0030 §3） */}
            <span class="ek-count" aria-hidden="true">
              {p.count}
            </span>
          </button>
        )}
        <button
          type="button"
          class="ek-side-btn"
          data-testid="toggle-text"
          aria-pressed={page === 'text' ? 'true' : 'false'}
          aria-label={page === 'text' ? '切回附加键' : '文本输入'}
          onPointerDown={noFocus}
          onClick={p.onTogglePage}
        >
          <EditIcon />
        </button>
      </div>
      <div
        class="ek-main"
        onPointerDown={onDown}
        onPointerMove={(e) => press.move(e.clientX, e.clientY)}
        onPointerUp={onUp}
        onPointerCancel={() => {
          gesture.current = null
          press.cancel()
        }}
      >
        <div class="ek-keys" role="group" aria-label="附加键">
          {EXTRA_KEYS.flat().map((k) => {
            const mod = k.id === 'Ctrl' ? 'ctrl' : k.id === 'Alt' ? 'alt' : null
            const sticky = mod ? p.sticky.state(mod) : undefined
            return (
              <button
                type="button"
                key={k.id}
                tabIndex={-1}
                class="ek-key"
                data-key={k.id}
                data-testid={`key-${k.id}`}
                data-sticky={sticky}
                aria-pressed={sticky === undefined ? undefined : sticky === 'off' ? 'false' : 'true'}
              >
                {k.label}
              </button>
            )
          })}
        </div>
        <textarea ref={taRef} class="ek-text" data-testid="textinput" rows={2} aria-label="文本输入" onKeyDown={onTextKey} />
      </div>
    </div>
  )
}
