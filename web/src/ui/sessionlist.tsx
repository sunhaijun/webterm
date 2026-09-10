/**
 * 会话列表 —— docs/40-frontend/session-ux.md。
 *
 * desktop 常驻侧栏 / tablet 覆盖式抽屉 / phone 底部 sheet，三档共用这一份
 * 列表，只是外层容器不同。
 */
import type { SessionView } from '../sessions/store'

export interface SessionListProps {
  sessions: SessionView[]
  active: number | null
  unread(sid: number): boolean
  onSelect(sid: number): void
  onClose(sid: number): void
  onRename(sid: number, current: string): void
  onTogglePinned(sid: number): void
  onNew(): void
  /** 会话数达上限时禁用新建按钮（US-7.3）。 */
  atLimit: boolean
  maxSessions: number
}

export function SessionList({
  sessions,
  active,
  unread,
  onSelect,
  onClose,
  onRename,
  onTogglePinned,
  onNew,
  atLimit,
  maxSessions,
}: SessionListProps) {
  return (
    <div class="sessionlist" data-testid="session-list">
      {sessions.map((s) => (
        <div
          key={s.sid}
          class="session-item"
          data-testid={`session-${s.sid}`}
          data-active={active === s.sid}
          data-status={s.status}
          onClick={() => onSelect(s.sid)}
        >
          <span class="session-dot" data-status={s.status} data-unread={unread(s.sid)} />
          <span class="session-name">{s.name}</span>
          {s.status === 'exited' ? (
            <span
              class="session-exit"
              data-testid={`session-${s.sid}-exit`}
              data-failed={s.exit_code !== 0}
            >
              exit {s.exit_code ?? '—'}
            </span>
          ) : (
            <span class="session-cwd">{s.cwd}</span>
          )}
          {unread(s.sid) && <span class="session-unread" data-testid={`session-${s.sid}-unread`} />}
          <button
            class="session-pin"
            data-testid={`session-${s.sid}-pin`}
            data-on={s.pinnedSubscription}
            title={
              s.pinnedSubscription
                ? '保持接收：切走也继续收输出（费流量）'
                : '默认只接收当前会话的输出'
            }
            onClick={(e) => {
              e.stopPropagation()
              onTogglePinned(s.sid)
            }}
          >
            ⇵
          </button>
          <button
            class="session-rename"
            data-testid={`session-${s.sid}-rename`}
            title="重命名"
            onClick={(e) => {
              e.stopPropagation()
              onRename(s.sid, s.name)
            }}
          >
            ✎
          </button>
          <button
            class="session-close"
            data-testid={`session-${s.sid}-close`}
            title="关闭会话"
            onClick={(e) => {
              e.stopPropagation()
              onClose(s.sid)
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button class="session-new" data-testid="new-session" disabled={atLimit} onClick={onNew}>
        {/* 达到上限时明确说出来，而不是点了没反应（US-7.3） */}
        {atLimit ? `会话数已达上限 ${maxSessions}` : '+ 新会话'}
      </button>
    </div>
  )
}

/** 已退出会话的提示带：内容保留可看，可以重开或关闭（AC-4.5）。 */
export function ExitedBar({
  session,
  onReopen,
  onClose,
}: {
  session: SessionView
  onReopen(): void
  onClose(): void
}) {
  return (
    <div class="banner exited" data-testid="exited-bar">
      会话已结束（exit {session.exit_code ?? '—'}）
      {/* 「重开」= 在同一个 cwd 新建会话，不是复活旧的 —— 那不可能 */}
      <button data-testid="reopen-session" onClick={onReopen}>
        重开
      </button>
      <button data-testid="close-exited" onClick={onClose}>
        关闭
      </button>
    </div>
  )
}
