/**
 * 历史面板与快捷命令 —— docs/40-frontend/commands-ux.md。
 *
 * 只有一个概念：命令记录。它有一个 pinned 标记（ADR-0008）。
 * 一个列表两个视图：置顶的浮在顶部（就是「快捷命令」），下面是时间倒序的历史。
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import {
  clearHistory,
  deleteCommand,
  ellipsize,
  formatDuration,
  groupByDay,
  listCommands,
  patchCommand,
  reorderCommands,
  type CommandRecord,
} from './api'
import { installSwipeDismiss } from '../ui/swipe'

export interface HistoryPanelProps {
  /** 当前会话的 CWD，用于「仅当前目录」过滤。 */
  cwd: string
  onClose(): void
  onFill(text: string): void
  onRun(text: string): void
  /** 快捷命令有变动时通知外层刷新按钮条。 */
  onPinnedChanged(): void
}

export function HistoryPanel({ cwd, onClose, onFill, onRun, onPinnedChanged }: HistoryPanelProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => (sheetRef.current ? installSwipeDismiss(sheetRef.current, onClose) : undefined), [onClose])
  const [q, setQ] = useState('')
  const [onlyCwd, setOnlyCwd] = useState(false)
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [pinned, setPinned] = useState<CommandRecord[]>([])
  const [items, setItems] = useState<CommandRecord[]>([])
  const [undo, setUndo] = useState<CommandRecord | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout>>()

  const reload = useCallback(async () => {
    const [p, h] = await Promise.all([
      listCommands({ pinned: true, limit: 200 }),
      listCommands({ q, cwd: onlyCwd ? cwd : undefined, failed: onlyFailed, limit: 100 }),
    ])
    setPinned(p.items)
    setItems(h.items.filter((it) => !it.pinned))
  }, [q, onlyCwd, onlyFailed, cwd])

  useEffect(() => {
    void reload()
  }, [reload])

  const togglePin = async (r: CommandRecord) => {
    await patchCommand(r.id, { pinned: !r.pinned })
    await reload()
    onPinnedChanged()
  }

  const remove = async (r: CommandRecord) => {
    // 3 秒撤销：其实是延迟发请求，服务端没有回收站
    setUndo(r)
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => {
      void deleteCommand(r.id).then(reload)
      setUndo(null)
    }, 3000)
    setItems((cur) => cur.filter((x) => x.id !== r.id))
  }

  const cancelUndo = () => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndo(null)
    void reload()
  }

  const doClear = async () => {
    // 二次确认，并明确告知会保留多少条快捷命令
    if (!confirm(`将删除全部历史记录，保留 ${pinned.length} 条快捷命令。确定吗？`)) return
    const r = await clearHistory()
    alert(`已删除 ${r.deleted} 条历史，保留 ${r.kept_pinned} 条快捷命令。`)
    await reload()
  }

  return (
    <div class="panel-backdrop" data-testid="history-panel" onClick={onClose}>
      <div class="panel" ref={sheetRef} onClick={(e) => e.stopPropagation()}>
        <div class="panel-head">
          <input
            class="panel-search"
            data-testid="history-search"
            placeholder="搜索命令…"
            value={q}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
          <label>
            <input
              type="checkbox"
              data-testid="filter-cwd"
              checked={onlyCwd}
              onChange={(e) => setOnlyCwd(e.currentTarget.checked)}
            />
            仅当前目录
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="filter-failed"
              checked={onlyFailed}
              onChange={(e) => setOnlyFailed(e.currentTarget.checked)}
            />
            仅失败
          </label>
          <button data-testid="clear-history" onClick={() => void doClear()}>
            清空历史
          </button>
          <button data-testid="close-history" onClick={onClose}>
            关闭
          </button>
        </div>

        <div class="panel-body">
          {pinned.length > 0 && (
            <>
              <div class="panel-group">快捷命令</div>
              {pinned.map((r, i) => (
                <Row
                  key={r.id}
                  r={r}
                  index={i}
                  draggable
                  onFill={onFill}
                  onRun={onRun}
                  onTogglePin={() => void togglePin(r)}
                  onDelete={() => void remove(r)}
                  onLabel={async () => {
                    const label = prompt('给这条快捷命令起个短名：', r.label ?? '')
                    if (label === null) return
                    await patchCommand(r.id, { label: label || null })
                    await reload()
                    onPinnedChanged()
                  }}
                  onDropAt={async (from, to) => {
                    const next = [...pinned]
                    const [moved] = next.splice(from, 1)
                    if (!moved) return
                    next.splice(to, 0, moved)
                    // 一次提交所有受影响的项，避免中间态出现重复的 pin_order
                    await reorderCommands(next.map((x, idx) => ({ id: x.id, pin_order: idx + 1 })))
                    await reload()
                    onPinnedChanged()
                  }}
                />
              ))}
            </>
          )}

          {groupByDay(items).map(([day, group]) => (
            <div key={day}>
              <div class="panel-group">{day}</div>
              {group.map((r) => (
                <Row
                  key={r.id}
                  r={r}
                  onFill={onFill}
                  onRun={onRun}
                  onTogglePin={() => void togglePin(r)}
                  onDelete={() => void remove(r)}
                />
              ))}
            </div>
          ))}
          {items.length === 0 && pinned.length === 0 && (
            <div class="panel-empty">还没有命令记录。</div>
          )}
        </div>

        {undo && (
          <div class="toast" data-testid="undo-delete">
            已删除「{ellipsize(undo.text, 30)}」
            <button data-testid="undo-button" onClick={cancelUndo}>
              撤销
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({
  r,
  index,
  draggable,
  onFill,
  onRun,
  onTogglePin,
  onDelete,
  onLabel,
  onDropAt,
}: {
  r: CommandRecord
  index?: number
  draggable?: boolean
  onFill(text: string): void
  onRun(text: string): void
  onTogglePin(): void
  onDelete(): void
  onLabel?(): void
  onDropAt?(from: number, to: number): void
}) {
  return (
    <div
      class="cmd-row"
      data-testid={`cmd-${r.id}`}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer?.setData('text/plain', String(index))}
      onDragOver={(e) => draggable && e.preventDefault()}
      onDrop={(e) => {
        if (!draggable || index === undefined) return
        e.preventDefault()
        const from = Number(e.dataTransfer?.getData('text/plain'))
        if (Number.isFinite(from)) onDropAt?.(from, index)
      }}
      // 点击 = 填入 Composer；Shift+点击 = 直接执行。
      // 默认不执行是刻意的：历史里可能有 rm -rf
      onClick={(e) => (e.shiftKey ? onRun(r.text) : onFill(r.text))}
    >
      <button
        class="cmd-star"
        data-testid={`cmd-${r.id}-star`}
        data-on={r.pinned}
        title={r.pinned ? '取消置顶' : '置顶为快捷命令'}
        onClick={(e) => {
          e.stopPropagation()
          onTogglePin()
        }}
      >
        {r.pinned ? '★' : '☆'}
      </button>
      <span class="cmd-text">
        {r.label ? (
          <>
            <b>{r.label}</b> <span class="cmd-sub">{ellipsize(r.text, 40)}</span>
          </>
        ) : (
          ellipsize(r.text, 60)
        )}
      </span>
      <span class="cmd-exit" data-failed={r.exit_code !== null && r.exit_code !== 0}>
        {r.exit_code === null ? '—' : r.exit_code}
      </span>
      <span class="cmd-dur">{formatDuration(r.duration_ms)}</span>
      {onLabel && (
        <button
          class="cmd-more"
          data-testid={`cmd-${r.id}-label`}
          onClick={(e) => {
            e.stopPropagation()
            onLabel()
          }}
        >
          名
        </button>
      )}
      <button
        class="cmd-more"
        data-testid={`cmd-${r.id}-delete`}
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        ✕
      </button>
    </div>
  )
}

/**
 * 移动端快捷命令条 —— Composer 上方一行，横向滚动。
 *
 * 为空时【整条隐藏】，不占空间，也不显示"暂无快捷命令"这种废话。
 */
export function QuickBar({
  items,
  onFill,
  onRun,
}: {
  items: CommandRecord[]
  onFill(text: string): void
  onRun(text: string): void
}) {
  const timer = useRef<ReturnType<typeof setTimeout>>()
  if (items.length === 0) return null
  return (
    <div class="quickbar" data-testid="quickbar">
      {items.map((r) => (
        <button
          key={r.id}
          class="quick-key"
          data-testid={`quick-${r.id}`}
          // 点击 = 填入；长按 500ms = 直接执行
          onPointerDown={() => {
            timer.current = setTimeout(() => {
              timer.current = undefined
              navigator.vibrate?.(10)
              onRun(r.text)
            }, 500)
          }}
          onPointerUp={() => {
            if (timer.current) {
              clearTimeout(timer.current)
              timer.current = undefined
              onFill(r.text)
            }
          }}
          onPointerLeave={() => {
            if (timer.current) clearTimeout(timer.current)
            timer.current = undefined
          }}
        >
          {r.label ?? ellipsize(r.text, 20)}
        </button>
      ))}
    </div>
  )
}
