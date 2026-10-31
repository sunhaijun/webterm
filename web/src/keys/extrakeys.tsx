/**
 * 附加键区（AC-3.18 / AC-3.19，input.md）：80px 的定高槽，两页 ——
 * 键位页（Termux 默认 14 键）和文本输入页（一个两行的 textarea）。左边 44px 的固定列：
 * compact 是 ☰（上）与 ✎（下），wide 只有 ✎。两页高度相同，切换不改终端几何。
 *
 * 所有键在 pointerdown 时 preventDefault：按附加键不让软键盘收起或弹出，焦点不动。
 * 字节在 pointerup 的派发里发（`term.input()`，走 onData 出口），这样在键区上横滑
 * 可以切页而不误按键；CTRL / ALT 长按锁定也要等抬起才知道是点还是按。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { Form } from '../app/form'
import { PressTracker } from '../ui/longpress'
import { EXTRA_KEYS, appAction, isModifierKey, type ExtraKeyId, type Sticky } from './keymap'
import { isPageSwipe, textEnter, type TextSend } from './textpage'

export type KeyPage = 'keys' | 'text'

export interface ExtraKeysProps {
  form: Form
  /** 任一非当前会话有未读：☰ 上的小红点。 */
  unread: boolean
  sticky: Sticky
  onOpenSessions(): void
  /** 一个非修饰键被按下（在 pointerup 的派发里调用）。 */
  onKey(id: ExtraKeyId): void
  /** 文本页回车（在 keydown 的派发里调用）。 */
  onSend(send: TextSend): void
  /** 从文本页切回键位页、且焦点在文本框里时，把焦点还给终端。 */
  focusTerm(): void
  textRef(el: HTMLTextAreaElement | null): void
}

const noFocus = (e: Event) => e.preventDefault()

export function ExtraKeys(p: ExtraKeysProps) {
  const [page, setPage] = useState<KeyPage>('keys')
  const slotRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const press = useRef(new PressTracker()).current
  const gesture = useRef<{ x: number; y: number; key: ExtraKeyId | null } | null>(null)
  const [, setTick] = useState(0)
  const rerender = () => setTick((n) => n + 1)

  useEffect(() => p.sticky.subscribe(rerender), [p.sticky])

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    // 【必须 setAttribute】（AC-3.10）：Chrome 把 autocorrect 实现成 boolean IDL 属性，
    // 写在 JSX 里框架会去赋属性，"off" 是真值，反射出来的 attribute 变成 autocorrect="on"
    ta.setAttribute('autocorrect', 'off')
    ta.setAttribute('autocapitalize', 'off')
    ta.setAttribute('spellcheck', 'false')
    ta.setAttribute('autocomplete', 'off')
    ta.setAttribute('enterkeyhint', 'send')
    p.textRef(ta)
    return () => p.textRef(null)
  }, [])

  const switchPage = (next: KeyPage) => {
    // 同步翻 DOM 上的页：下一行的 focus() 要求 textarea 此刻已经可见。
    // 必须在这次点击 / 抬起的处理函数里聚焦，iOS 才会弹键盘
    if (slotRef.current) slotRef.current.dataset.page = next
    setPage(next)
    const ta = taRef.current
    if (next === 'text') ta?.focus({ preventScroll: true })
    else if (ta && document.activeElement === ta) p.focusTerm()
  }

  const onDown = (e: PointerEvent) => {
    const keyEl = (e.target as Element).closest<HTMLElement>('[data-key]')
    const key = (keyEl?.dataset.key as ExtraKeyId | undefined) ?? null
    if (page === 'keys') {
      e.preventDefault() // 不抢焦点
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* 合成事件没有活动指针，拿不到捕获也无妨 */
      }
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
      switchPage(page === 'keys' ? 'text' : 'keys')
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
            aria-label={p.unread ? '会话（有新输出）' : '会话'}
            onPointerDown={noFocus}
            onClick={p.onOpenSessions}
          >
            ☰
          </button>
        )}
        <button
          type="button"
          class="ek-side-btn"
          data-testid="toggle-text"
          aria-pressed={page === 'text' ? 'true' : 'false'}
          aria-label={page === 'text' ? '切回附加键' : '文本输入'}
          onPointerDown={noFocus}
          onClick={() => switchPage(page === 'keys' ? 'text' : 'keys')}
        >
          ✎
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
