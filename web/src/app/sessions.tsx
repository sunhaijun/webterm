/**
 * 会话的列表与菜单（session-ux.md §切换会话）。
 *
 * - `SessionList`：compact 抽屉里的内容（一行一个会话，`[n] 名字  CWD / exit N`）；
 * - `SessionMenu`：长按 / 右键一个会话弹出的「改名 · 保持接收 · 关闭」，两种形态共用；
 * - `RenameInput`：改名时名字原地变成的输入框，`Enter` 确认、`Esc` 取消。
 */
import { useLayoutEffect, useRef } from 'preact/hooks'

import type { SessionView } from '../sessions/store'
import { shortCwd } from '../sessions/store'
import { PressTracker } from '../ui/longpress'
import { menuPosition } from '../ui/viewport'

export interface SessionListProps {
  sessions: SessionView[]
  /** agent 用户的家目录（welcome.home），CWD 里的它缩成 `~`。 */
  home: string | null
  renaming: number | null
  onSelect(sid: number): void
  onMenu(sid: number, x: number, y: number): void
  onRename(sid: number, name: string): void
  onCancelRename(): void
}

export function SessionList({ sessions, home, renaming, onSelect, onMenu, onRename, onCancelRename }: SessionListProps) {
  // 一次只会有一个按压：整张列表共用一个
  const press = useRef(new PressTracker()).current
  const listRef = useRef<HTMLUListElement>(null)
  const active = sessions.find((s) => s.active)?.sid ?? null

  useLayoutEffect(() => {
    // 选中项要在可视区里（AC-4.9）；整个已可见则不动
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sid="${active}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  return (
    <ul class="session-list" data-testid="session-list" ref={listRef}>
      {sessions.map((s) => (
        <li key={s.sid}>
          <div
            class="session-row"
            role="button"
            tabIndex={0}
            data-testid={`session-${s.sid}`}
            data-sid={s.sid}
            data-exited={s.status === 'exited' ? 'true' : 'false'}
            data-unread={s.unread ? 'true' : 'false'}
            aria-current={s.active ? 'true' : undefined}
            title={s.cwd}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              const { clientX: x, clientY: y } = e
              press.down(x, y, () => onMenu(s.sid, x, y))
            }}
            onPointerMove={(e) => press.move(e.clientX, e.clientY)}
            onPointerUp={() => press.up()}
            onPointerCancel={() => press.cancel()}
            onContextMenu={(e) => {
              e.preventDefault()
              onMenu(s.sid, e.clientX, e.clientY)
            }}
            onClick={() => {
              if (press.takeSwallowedClick() || renaming === s.sid) return
              onSelect(s.sid)
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(s.sid)
              }
            }}
          >
            <span class="sl-idx">[{s.index}]</span>
            <span class="sl-name">
              {s.pinned && <span class="pin-mark" aria-label="保持接收">⇵</span>}
              {renaming === s.sid ? (
                <RenameInput initial={s.name} onCommit={(n) => onRename(s.sid, n)} onCancel={onCancelRename} />
              ) : (
                <span class="sl-text">{s.name}</span>
              )}
            </span>
            {s.unread && <span class="unread-dot" aria-label="有新输出" />}
            <span class="sl-meta" data-failed={s.status === 'exited' && s.exitCode !== 0 ? 'true' : 'false'}>
              {s.status === 'exited' ? `exit ${s.exitCode ?? '?'}` : shortCwd(s.cwd, home)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export interface RenameInputProps {
  initial: string
  onCommit(name: string): void
  onCancel(): void
}

/** 改名输入框。空字符串 = 恢复跟随 CWD 自动命名。失焦 = 取消。 */
export function RenameInput({ initial, onCommit, onCancel }: RenameInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.value = initial
    el.focus({ preventScroll: true })
    el.select()
  }, [])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(ref.current?.value ?? '')
    else onCancel()
  }
  return (
    <input
      ref={ref}
      class="rename-input"
      data-testid="rename-input"
      data-esc-local
      type="text"
      placeholder="留空 = 跟随目录"
      aria-label="会话名（留空 = 跟随目录）"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(false)}
    />
  )
}

export interface SessionMenuProps {
  session: SessionView
  x: number
  y: number
  onRename(): void
  onTogglePin(): void
  onClose(): void
  onDismiss(): void
}

const MENU_SIZE = { width: 184, height: 152 }

/** 会话菜单：锚在触发点旁边，点外面或 Esc 关闭（不是浮层）。 */
export function SessionMenu({ session, x, y, onRename, onTogglePin, onClose, onDismiss }: SessionMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    return () => {
      // 焦点还在菜单里就还回去（抽屉里打开的菜单，焦点回抽屉）
      if (prev && prev.isConnected && el?.contains(document.activeElement)) prev.focus({ preventScroll: true })
    }
  }, [])
  // 【只认菜单出现之后才按下的指针】：打开菜单的那次长按，抬手时浏览器可能补一个 click
  // （E2E 实测：iPad 触屏模拟下长按标签，click 落在刚出现的遮罩上，菜单一闪就关了），
  // 落在菜单上则会误点第一项；长按到点时的 contextmenu 同理。键盘触发的 click（detail 0）不受影响。
  const pressed = useRef(false)
  const onPress = () => {
    pressed.current = true
  }
  const fresh = (e: MouseEvent) => e.detail === 0 || pressed.current
  const pos = menuPosition(x, y, MENU_SIZE, window.innerWidth, window.innerHeight)
  return (
    <>
      <div
        class="menu-scrim"
        data-testid="session-menu-scrim"
        onPointerDown={onPress}
        onClick={(e) => fresh(e) && onDismiss()}
        onContextMenu={(e) => {
          e.preventDefault()
          if (pressed.current) onDismiss()
        }}
      />
      <div
        class="session-menu"
        data-testid="session-menu"
        data-sid={session.sid}
        data-esc-local
        role="menu"
        aria-label={`会话 ${session.name}`}
        ref={ref}
        style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
        onPointerDown={onPress}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onDismiss()
          }
        }}
      >
        <button role="menuitem" data-testid="session-rename" onClick={(e) => fresh(e) && onRename()}>
          改名
        </button>
        <button
          role="menuitemcheckbox"
          aria-checked={session.pinned ? 'true' : 'false'}
          data-testid="session-pin"
          onClick={(e) => fresh(e) && onTogglePin()}
        >
          <span>保持接收</span>
          <span class="menu-check">{session.pinned ? '✓' : ''}</span>
        </button>
        <button role="menuitem" class="danger" data-testid="session-close" onClick={(e) => fresh(e) && onClose()}>
          关闭
        </button>
      </div>
    </>
  )
}
