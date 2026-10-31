/**
 * wide（PC / Pad）的顶部标签栏（session-ux.md §wide，参照 Termius）。
 *
 * 从左到右：标签条（只装标签）、`+`、空白、连接状态点、设置（ADR-0037）。标签等宽（120–240px，纯 CSS，
 * ADR-0031）；放不下时标签条横向滚动，当前标签变化时把它滚进视野（整个已可见则不动，
 * 不用 smooth）。`+` 不在标签条里，放不下时也始终可见，前面隔开一段不可点的空白（ADR-0035）。
 * 切换标签不改终端几何。
 *
 * 拖动排序（ADR-0040）：鼠标按住标签横移 > 5px 开始拖；触屏长按后不松手移动开始拖，
 * 长按后原地松手是会话菜单。拖完的那次 click 吞掉；`Esc` 取消。
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { ConnState, StateInfo } from '../conn/connection'
import type { SessionView } from '../sessions/store'
import { GearIcon, PlusIcon } from '../ui/icons'
import { PressTracker } from '../ui/longpress'
import { DragReorder, beforeAt } from '../ui/reorder'
import { needsReveal } from '../ui/viewport'
import { connLabel } from './notices'
import { RenameInput } from './sessions'

export interface TopBarProps {
  sessions: SessionView[]
  conn: ConnState
  connInfo: StateInfo
  atLimit: boolean
  maxSessions: number
  renaming: number | null
  onSelect(sid: number): void
  onClose(sid: number): void
  onNew(): void
  onMenu(sid: number, x: number, y: number): void
  onRenameStart(sid: number): void
  onRename(sid: number, name: string): void
  onCancelRename(): void
  onSettings(): void
  /** 拖动排序松手：把 sid 挪到 before 前面（null = 最后）。 */
  onMove(sid: number, before: number | null): void
}

/** 鼠标按住横移超过这么多才算拖（再小就是点）。 */
const DRAG_START_PX = 5

interface TabPress {
  sid: number
  index: number
  x: number
  y: number
  touch: boolean
  /** 触屏：长按到点了，接下来一移动就是拖；原地松手是菜单。 */
  armed: boolean
  drag: DragReorder | null
}

/**
 * 按下顶栏的任何地方（标签、`+`、`+` 前的空白、⚙）都不抢焦点：焦点留在终端（或文本输入页）里，
 * 切过去接着打字。改名的输入框除外。挂在 `.topbar` 上，冒泡上来的一并处理。
 */
const keepFocus = (e: PointerEvent) => {
  if ((e.target as Element).closest('input')) return
  e.preventDefault()
}

export function TopBar(p: TopBarProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const press = useRef(new PressTracker()).current
  const active = p.sessions.find((s) => s.active)?.sid ?? null
  const tp = useRef<TabPress | null>(null)
  /** 拖完 / 长按出菜单之后的那次 click 吞掉。 */
  const swallow = useRef(false)
  const [armed, setArmed] = useState<number | null>(null)
  const latest = useRef(p)
  latest.current = p

  const endPress = (cancel: boolean) => {
    const t = tp.current
    tp.current = null
    setArmed(null)
    if (!t) return
    if (t.drag) {
      const to = t.drag.finish(cancel)
      swallow.current = true
      if (to !== t.index) latest.current.onMove(t.sid, beforeAt(latest.current.sessions.map((s) => s.sid), t.index, to))
    } else if (t.armed && !cancel) {
      swallow.current = true
      latest.current.onMenu(t.sid, t.x, t.y)
    }
  }

  const startDrag = (t: TabPress, pointerId: number, el: HTMLElement) => {
    const strip = stripRef.current
    if (!strip) return
    try {
      el.setPointerCapture(pointerId)
    } catch {
      /* 合成事件没有活动指针 */
    }
    const items = [...strip.querySelectorAll<HTMLElement>('.tab')]
    t.drag = new DragReorder({ axis: 'x', scroller: strip, items, from: t.index, start: t.x })
  }

  useLayoutEffect(() => {
    // 拖动中按 Esc：取消，回到原位
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !tp.current?.drag) return
      e.preventDefault()
      e.stopPropagation()
      endPress(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useLayoutEffect(() => {
    const strip = stripRef.current
    const el = strip?.querySelector<HTMLElement>(`[data-sid="${active}"]`)
    if (!strip || !el) return
    if (needsReveal(el.getBoundingClientRect(), strip.getBoundingClientRect())) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [active, p.sessions.length])

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    // 滚动条是隐藏的：鼠标滚轮纵向滚 = 横着滚标签条（ADR-0031 §3）。
    // 放得下、或者本来就是横向手势（触控板）时不拦
    const onWheel = (e: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1
      strip.scrollLeft += e.deltaY * unit
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    // 触屏长按之后：这次触摸归拖动，不让浏览器拿去横向滚标签条（之后的 pointer 事件才不会被 cancel）
    const onTouchMove = (e: TouchEvent) => {
      if (tp.current?.armed) e.preventDefault()
    }
    strip.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      strip.removeEventListener('wheel', onWheel)
      strip.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  const rtt = p.connInfo.rttMs
  const dotTitle = p.conn === 'online' && rtt !== undefined && rtt > 300 ? `在线 · ${rtt}ms` : connLabel(p.conn, p.connInfo)

  return (
    <div class="topbar" onPointerDown={keepFocus}>
      <div class="tabbar" data-testid="tabbar" role="tablist" aria-label="会话" ref={stripRef}>
        {p.sessions.map((s, index) => (
          <div
            key={s.sid}
            class="tab"
            data-armed={armed === s.sid ? 'true' : undefined}
            role="tab"
            tabIndex={0}
            data-testid={`tab-${s.sid}`}
            data-sid={s.sid}
            data-exited={s.status === 'exited' ? 'true' : 'false'}
            data-unread={s.unread ? 'true' : 'false'}
            aria-selected={s.active ? 'true' : 'false'}
            aria-current={s.active ? 'true' : undefined}
            title={s.cwd ? `${s.name}\n${s.cwd}` : s.name}
            onPointerDown={(e) => {
              if ((e.target as Element).closest('.tab-close, input')) return
              if (e.pointerType !== 'touch' && e.button !== 0) return
              const { clientX: x, clientY: y } = e
              const t: TabPress = { sid: s.sid, index, x, y, touch: e.pointerType === 'touch', armed: false, drag: null }
              tp.current = t
              swallow.current = false
              if (t.touch) {
                // 长按：先「拿起来」，松手时才知道是菜单（原地松手）还是拖（移动了）
                press.down(x, y, () => {
                  if (tp.current !== t) return
                  t.armed = true
                  setArmed(s.sid)
                })
              }
            }}
            onPointerMove={(e) => {
              const t = tp.current
              if (!t || t.sid !== s.sid) return
              if (t.touch && !t.armed) {
                press.move(e.clientX, e.clientY)
                return
              }
              if (!t.drag) {
                if (Math.abs(e.clientX - t.x) <= DRAG_START_PX && Math.abs(e.clientY - t.y) <= DRAG_START_PX) return
                startDrag(t, e.pointerId, e.currentTarget as HTMLElement)
              }
              t.drag?.move(e.clientX)
            }}
            onPointerUp={() => {
              press.up()
              if (tp.current?.sid === s.sid) endPress(false)
            }}
            onPointerCancel={() => {
              press.cancel()
              if (tp.current?.sid === s.sid) endPress(true)
            }}
            onClick={() => {
              if (press.takeSwallowedClick() || swallow.current) {
                swallow.current = false
                return
              }
              p.onSelect(s.sid)
            }}
            onAuxClick={(e) => {
              // 中键点标签 = 关闭
              if (e.button !== 1) return
              e.preventDefault()
              p.onClose(s.sid)
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault() // 别让中键进入自动滚动
            }}
            onDblClick={() => p.onRenameStart(s.sid)}
            onContextMenu={(e) => {
              e.preventDefault()
              p.onMenu(s.sid, e.clientX, e.clientY)
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                p.onSelect(s.sid)
              }
            }}
          >
            {s.pinned && (
              <span class="pin-mark" aria-label="保持接收">
                ⇵
              </span>
            )}
            {p.renaming === s.sid ? (
              <RenameInput initial={s.name} onCommit={(n) => p.onRename(s.sid, n)} onCancel={p.onCancelRename} />
            ) : (
              <span class="tab-name">{s.name}</span>
            )}
            {s.unread && <span class="unread-dot" data-testid={`tab-${s.sid}-unread`} aria-label="有新输出" />}
            <button
              class="tab-close"
              data-testid={`tab-${s.sid}-close`}
              tabIndex={-1}
              aria-label={`关闭 ${s.name}`}
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                p.onClose(s.sid)
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        class="tab-new"
        data-testid="new-session"
        disabled={p.atLimit}
        aria-label="新会话"
        title={p.atLimit ? `会话数已达上限 ${p.maxSessions}` : '新会话（Ctrl+Shift+Enter）'}
        onClick={p.onNew}
      >
        {/* 图标而不是 `+` 字符：字符的上下位置随字体度量变，和状态点对不齐（ADR-0035 §3） */}
        <PlusIcon />
      </button>
      <span class="conn-dot" data-testid="conn-dot" data-state={p.conn} title={dotTitle} aria-hidden="true" />
      <button class="topbar-btn" data-testid="open-settings" aria-label="设置" title="设置" onClick={p.onSettings}>
        <GearIcon />
      </button>
    </div>
  )
}
