/**
 * wide（PC / Pad）的顶部标签栏（session-ux.md §wide，参照 Termius）。
 *
 * 从左到右：标签条（只装标签）、`+`、空白、连接状态点。标签等宽（120–240px，纯 CSS，
 * ADR-0031）；放不下时标签条横向滚动，当前标签变化时把它滚进视野（整个已可见则不动，
 * 不用 smooth）。`+` 不在标签条里，放不下时也始终可见，前面隔开一段不可点的空白（ADR-0035）。
 * 切换标签不改终端几何。
 */
import { useLayoutEffect, useRef } from 'preact/hooks'

import type { ConnState, StateInfo } from '../conn/connection'
import type { SessionView } from '../sessions/store'
import { PressTracker } from '../ui/longpress'
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
}

/**
 * 按下顶栏的任何地方（标签、`+`、`+` 前的空白）都不抢焦点：焦点留在终端（或文本输入页）里，
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
    return () => strip.removeEventListener('wheel', onWheel)
  }, [])

  const rtt = p.connInfo.rttMs
  const dotTitle = p.conn === 'online' && rtt !== undefined && rtt > 300 ? `在线 · ${rtt}ms` : connLabel(p.conn, p.connInfo)

  return (
    <div class="topbar" onPointerDown={keepFocus}>
      <div class="tabbar" data-testid="tabbar" role="tablist" aria-label="会话" ref={stripRef}>
        {p.sessions.map((s) => (
          <div
            key={s.sid}
            class="tab"
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
              if (e.pointerType === 'touch') {
                const { clientX: x, clientY: y } = e
                press.down(x, y, () => p.onMenu(s.sid, x, y))
              }
            }}
            onPointerMove={(e) => press.move(e.clientX, e.clientY)}
            onPointerUp={() => press.up()}
            onPointerCancel={() => press.cancel()}
            onClick={() => {
              if (press.takeSwallowedClick()) return
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
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M7 1.5v11M1.5 7h11" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" fill="none" />
        </svg>
      </button>
      <span class="conn-dot" data-testid="conn-dot" data-state={p.conn} title={dotTitle} aria-hidden="true" />
    </div>
  )
}
