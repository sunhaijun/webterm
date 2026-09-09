/**
 * 移动端功能键条 —— docs/40-frontend/input-modes.md §移动端功能键条。
 *
 * 软键盘上没有 Esc / Tab / Ctrl / 方向键，这一排补上它们（AC-3.9）。
 */
import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'

import { CTRL_KEYS, KEY_BYTES, chord, keyBarFor } from './keymap'
import type { KeyAction } from './keymap'
import type { Mode } from './modes'

/** 粘滞修饰键的三个状态。 */
type Sticky = 'off' | 'armed' | 'locked'

export interface KeyBarProps {
  mode: Mode
  /** 直通 PTY。 */
  onRaw(bytes: string): void
  /** Composer 模式下的语义动作（翻历史、移动光标等）。 */
  onComposerKey(key: string, mods: { ctrl: boolean; alt: boolean }): void
  /** 谁在占屏：备用缓冲是否激活 + 前台程序名。决定键条内容（ADR-0011 ②）。 */
  context?: { altScreen: boolean; program: string | null }
  /** 排在最前面的前导键（终端视图里回「读」与 ⋯）。 */
  leading?: ComponentChildren
  /** 本地动作键（翻页 / 跳底）：不发 PTY。 */
  onAction?(action: KeyAction): void
}

export function KeyBar({ mode, onRaw, onComposerKey, context, leading, onAction }: KeyBarProps) {
  const ctx = context ?? { altScreen: false, program: null }
  const keys = keyBarFor(ctx)
  const [ctrl, setCtrl] = useState<Sticky>('off')
  const [alt, setAlt] = useState<Sticky>('off')

  const cycle = (s: Sticky): Sticky => (s === 'off' ? 'armed' : 'off')

  const consume = () => {
    // 用掉一次之后自动取消激活；锁定态要连续多次组合（Ctrl+C 之后接 Ctrl+D）
    if (ctrl === 'armed') setCtrl('off')
    if (alt === 'armed') setAlt('off')
  }

  const press = (key: string, bytes?: string, action?: KeyAction) => {
    // 本地动作：只动 xterm 视口，不发 PTY
    if (action !== undefined) {
      onAction?.(action)
      return
    }
    // 上下文键（vim 的 :q、less 的 q…）带着要发的字节，直接送 PTY
    if (bytes !== undefined) {
      onRaw(bytes)
      consume()
      return
    }
    // 控制码【两种模式下都直接发】。^C 的意义就是打断正在跑的东西，
    // 停在 Composer 里等用户再按一次回车是没有意义的。
    const ctl = CTRL_KEYS[key]
    if (ctl !== undefined) {
      onRaw(ctl)
      consume()
      return
    }
    const mods = { ctrl: ctrl !== 'off', alt: alt !== 'off' }
    if (mode === 'raw') {
      const bytes = KEY_BYTES[key]
      onRaw(bytes !== undefined ? withMods(bytes, mods) : chord(key, mods))
    } else {
      onComposerKey(key, mods)
    }
    consume()
  }

  return (
    <div class="keybar" data-testid="keybar" role="toolbar" aria-label="功能键" data-context={ctx.altScreen ? (ctx.program ?? 'tui') : 'shell'}>
      {leading}
      {ctx.altScreen && (
        <span class="keybar-ctx" data-testid="keybar-context" title="正在占屏的程序，键条按它换了内容">
          {ctx.program ?? 'TUI'}
        </span>
      )}
      {keys.map((k) => {
        if (k.key === 'Ctrl' || k.key === 'Alt') {
          const [state, set] = k.key === 'Ctrl' ? [ctrl, setCtrl] : [alt, setAlt]
          return (
            <button
              key={k.key}
              class="keybar-key"
              data-testid={`key-${k.key}`}
              data-sticky={state}
              aria-pressed={state !== 'off'}
              onClick={() => set(cycle(state))}
              // 长按 → 锁定态，连续多次组合都带这个修饰键
              onContextMenu={(e) => {
                e.preventDefault()
                set(state === 'locked' ? 'off' : 'locked')
              }}
            >
              {k.label}
            </button>
          )
        }
        return (
          <button
            key={k.key}
            class="keybar-key"
            data-testid={`key-${k.key}`}
            onClick={() => press(k.key, k.bytes, k.action)}
          >
            {k.label}
          </button>
        )
      })}
    </div>
  )
}

/** 给一段已经映射好的字节加上修饰键。 */
function withMods(bytes: string, mods: { ctrl: boolean; alt: boolean }): string {
  if (!mods.ctrl && !mods.alt) return bytes
  // 单字符的键才谈得上 Ctrl 组合；转义序列（方向键之类）只加 Alt 前缀
  if (bytes.length === 1) return chord(bytes, mods)
  return mods.alt ? `\x1b${bytes}` : bytes
}
