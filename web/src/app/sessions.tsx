/**
 * 会话的列表、行操作与菜单（session-ux.md §切换会话）。
 *
 * - `SessionList`：compact 抽屉里的内容（一行一个会话，`[n] 名字  CWD / exit N  ≡`）。
 *   一行左滑或长按露出「保持接收 / 改名 / 关闭」（ADR-0039）；右端的 ≡ 拖动排序（ADR-0040）；
 * - `RenameSheet`：compact 上的改名，一张叠在抽屉上的小 sheet（ADR-0039 §2）；
 * - `SessionMenu`：wide 上右键 / 长按标签弹出的「改名 · 保持接收 · 关闭」；
 * - `RenameInput`：wide 上改名时标签名原地变成的输入框，`Enter` 确认、`Esc` 取消。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { SessionView } from '../sessions/store'
import { shortCwd } from '../sessions/store'
import { Drawer } from '../ui/drawer'
import { GripIcon } from '../ui/icons'
import { PressTracker } from '../ui/longpress'
import { DragReorder, beforeAt } from '../ui/reorder'
import { RowSwipe } from '../ui/rowswipe'
import { menuPosition } from '../ui/viewport'

export interface SessionListProps {
  sessions: SessionView[]
  /** agent 用户的家目录（welcome.home），CWD 里的它缩成 `~`。 */
  home: string | null
  onSelect(sid: number): void
  onTogglePin(sid: number): void
  onRename(sid: number): void
  onClose(sid: number): void
  /** 拖动排序松手：把 sid 挪到 before 前面（null = 最后）。 */
  onMove(sid: number, before: number | null): void
}

interface RowGesture {
  sid: number
  row: HTMLElement
  /** 这次手势之后的 click 要吞掉（左滑过、长按过）。 */
  swallow: boolean
}

interface GripDrag {
  sid: number
  from: number
  drag: DragReorder
}

export function SessionList({ sessions, home, onSelect, onTogglePin, onRename, onClose, onMove }: SessionListProps) {
  // 一次只会有一个按压：整张列表共用一个
  const press = useRef(new PressTracker()).current
  const swipe = useRef(new RowSwipe()).current
  const gesture = useRef<RowGesture | null>(null)
  const swallowClick = useRef(false)
  const grip = useRef<GripDrag | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  /** 同一时间只开一行（ADR-0039 §1）。 */
  const [openSid, setOpenSid] = useState<number | null>(null)
  const active = sessions.find((s) => s.active)?.sid ?? null

  useLayoutEffect(() => {
    // 选中项要在可视区里（AC-4.9）；整个已可见则不动
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sid="${active}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  // 开着的那行被关掉了（别处关的）：忘掉
  useEffect(() => {
    if (openSid !== null && !sessions.some((s) => s.sid === openSid)) setOpenSid(null)
  }, [sessions, openSid])

  // 拖到一半列表没了（抽屉被关）：清掉位移
  useEffect(() => () => grip.current?.drag.finish(true), [])

  /**
   * 这次手势（左滑、长按）之后浏览器补发的那个 click 吞掉。【长按尤其要紧】：行被推开之后，
   * 手指下面已经是按钮了，抬手补发的 click 会落在「改名」甚至「关闭」上（E2E 实测）。
   * 标记在下一次按下时清掉，免得没有补发 click 时吞掉下一次真点击。
   */
  const takeSwallow = () => {
    const s = swallowClick.current
    swallowClick.current = false
    return s
  }

  const act = (fn: (sid: number) => void, sid: number) => (e: MouseEvent) => {
    e.stopPropagation()
    if (takeSwallow()) return
    setOpenSid(null)
    fn(sid)
  }

  const onRowDown = (e: PointerEvent, s: SessionView) => {
    if (e.button !== 0 || (e.target as Element).closest('.row-grip')) return
    const row = e.currentTarget as HTMLElement
    swipe.start(e.clientX, e.clientY, openSid === s.sid)
    gesture.current = { sid: s.sid, row, swallow: false }
    const { clientX: x, clientY: y } = e
    press.down(x, y, () => {
      // 长按 = 打开这一行（和左滑一样，ADR-0039 §1）
      if (gesture.current) gesture.current.swallow = true
      setOpenSid(s.sid)
    })
  }

  const onRowMove = (e: PointerEvent) => {
    press.move(e.clientX, e.clientY)
    const g = gesture.current
    if (!g) return
    const off = swipe.move(e.clientX, e.clientY)
    if (off === null) return
    if (!g.swallow) {
      g.swallow = true
      press.cancel()
      try {
        g.row.setPointerCapture(e.pointerId)
      } catch {
        /* 合成事件没有活动指针 */
      }
      if (openSid !== null && openSid !== g.sid) setOpenSid(null)
    }
    g.row.style.transition = 'none'
    g.row.style.transform = `translateX(${off}px)`
  }

  const onRowUp = () => {
    press.up()
    const g = gesture.current
    gesture.current = null
    const res = swipe.end()
    if (!g) return
    g.row.style.transition = ''
    g.row.style.transform = '' // 停在哪由 data-open 决定（CSS），带过渡
    if (res) setOpenSid(res === 'open' ? g.sid : openSid === g.sid ? null : openSid)
    if (g.swallow) swallowClick.current = true
  }

  const onRowCancel = () => {
    press.cancel()
    swipe.end()
    const g = gesture.current
    gesture.current = null
    if (g) {
      g.row.style.transition = ''
      g.row.style.transform = ''
    }
  }

  const onRowClick = (s: SessionView) => {
    if (takeSwallow()) return
    // 有一行开着：点哪儿都只是把它关上，不切换
    if (openSid !== null) {
      setOpenSid(null)
      return
    }
    onSelect(s.sid)
  }

  const onGripDown = (e: PointerEvent, index: number, sid: number) => {
    e.preventDefault()
    e.stopPropagation()
    const list = listRef.current
    if (!list || grip.current) return
    setOpenSid(null)
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件没有活动指针 */
    }
    const scroller = list.closest<HTMLElement>('.drawer-body') ?? list
    const items = [...list.children] as HTMLElement[]
    grip.current = { sid, from: index, drag: new DragReorder({ axis: 'y', scroller, items, from: index, start: e.clientY }) }
  }

  const onGripUp = (cancel: boolean) => {
    const g = grip.current
    grip.current = null
    if (!g) return
    const to = g.drag.finish(cancel)
    if (to !== g.from) onMove(g.sid, beforeAt(sessions.map((s) => s.sid), g.from, to))
  }

  return (
    <ul
      class="session-list"
      data-testid="session-list"
      ref={listRef}
      onPointerDownCapture={() => {
        swallowClick.current = false
      }}
    >
      {sessions.map((s, i) => {
        const open = openSid === s.sid
        return (
          <li key={s.sid} class="sl-item" data-open={open ? 'true' : 'false'}>
            <div class="row-actions" aria-hidden={open ? undefined : 'true'}>
              <button
                type="button"
                class="row-act"
                data-act="pin"
                data-testid="row-pin"
                tabIndex={open ? 0 : -1}
                aria-pressed={s.pinned ? 'true' : 'false'}
                onClick={act(onTogglePin, s.sid)}
              >
                {s.pinned ? '取消保持' : '保持接收'}
              </button>
              <button type="button" class="row-act" data-act="rename" data-testid="row-rename" tabIndex={open ? 0 : -1} onClick={act(onRename, s.sid)}>
                改名
              </button>
              <button type="button" class="row-act" data-act="close" data-testid="row-close" tabIndex={open ? 0 : -1} onClick={act(onClose, s.sid)}>
                关闭
              </button>
            </div>
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
              onPointerDown={(e) => onRowDown(e, s)}
              onPointerMove={onRowMove}
              onPointerUp={onRowUp}
              onPointerCancel={onRowCancel}
              onContextMenu={(e) => {
                e.preventDefault()
                setOpenSid(s.sid)
              }}
              onClick={() => onRowClick(s)}
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
                <span class="sl-text">{s.name}</span>
              </span>
              {s.unread && <span class="unread-dot" aria-label="有新输出" />}
              <span class="sl-meta" data-failed={s.status === 'exited' && s.exitCode !== 0 ? 'true' : 'false'}>
                {s.status === 'exited' ? `exit ${s.exitCode ?? '?'}` : shortCwd(s.cwd, home)}
              </span>
              <span
                class="row-grip"
                data-testid={`session-${s.sid}-grip`}
                aria-label="拖动排序"
                onPointerDown={(e) => onGripDown(e, i, s.sid)}
                onPointerMove={(e) => grip.current?.drag.move(e.clientY)}
                onPointerUp={() => onGripUp(false)}
                onPointerCancel={() => onGripUp(true)}
                onClick={(e) => e.stopPropagation()}
              >
                <GripIcon />
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export interface RenameSheetProps {
  name: string
  onCommit(name: string): void
  onCancel(): void
}

/**
 * compact 上的改名（ADR-0039 §2）：叠在抽屉上的小 sheet，一个整行宽的输入框。
 * sheet 贴着键盘上沿（.app 是浮层的包含块），输入框在它最上面，不会被挡。失焦不算取消。
 */
export function RenameSheet({ name, onCommit, onCancel }: RenameSheetProps) {
  const ref = useRef<HTMLInputElement>(null)
  // Drawer 自己的 layout effect 先跑（子先于父），已经把焦点收进浮层；这里再落到输入框上
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // 【必须 setAttribute】：autocorrect 在 Chrome 是 boolean IDL 属性（AC-3.10 同理）
    el.setAttribute('autocorrect', 'off')
    el.setAttribute('autocapitalize', 'off')
    el.setAttribute('spellcheck', 'false')
    el.setAttribute('enterkeyhint', 'done')
    el.value = name
    el.focus({ preventScroll: true })
    el.select()
  }, [])
  const commit = () => onCommit(ref.current?.value ?? '')
  return (
    <Drawer
      title="改名"
      testid="rename-sheet"
      backdropTestid="rename-backdrop"
      variant="rename"
      onClose={onCancel}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="rename-cancel" onClick={onCancel}>
            取消
          </button>
          <button type="button" class="drawer-btn primary" data-testid="rename-ok" onClick={commit}>
            保存
          </button>
        </div>
      }
    >
      <div class="rename-field">
        <input
          ref={ref}
          class="rename-sheet-input"
          data-testid="rename-input"
          type="text"
          autocomplete="off"
          placeholder="留空 = 跟随目录"
          aria-label="会话名（留空 = 跟随目录）"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
            e.preventDefault()
            commit()
          }}
        />
      </div>
    </Drawer>
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
