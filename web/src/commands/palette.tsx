/**
 * 命令面板 —— docs/40-frontend/commands-ux.md §命令面板。
 *
 * 桌面端的【唯一主入口】：一个入口搞定会话、快捷命令、历史、动作，
 * 因此不需要一堆快捷键。
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'

import { installSwipeDismiss } from '../ui/swipe'
import { ellipsize, listCommands, type CommandRecord } from './api'
import { fuzzyMatch, rankScore } from './fuzzy'

export type PaletteItem =
  | { kind: 'command'; record: CommandRecord; score: number }
  | { kind: 'session'; sid: number; name: string; cwd: string; score: number }
  | { kind: 'action'; id: string; label: string; score: number }

export interface PaletteProps {
  sessions: { sid: number; name: string; cwd: string }[]
  actions: { id: string; label: string; run(): void }[]
  onClose(): void
  /** 默认动作：命令 → 填入 Composer。 */
  onFill(text: string): void
  /** Shift+Enter：直接执行。 */
  onRun(text: string): void
  onSelectSession(sid: number): void
}

export function CommandPalette({
  sessions,
  actions,
  onClose,
  onFill,
  onRun,
  onSelectSession,
}: PaletteProps) {
  const [query, setQuery] = useState('')
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => (sheetRef.current ? installSwipeDismiss(sheetRef.current, onClose) : undefined), [onClose])
  const [records, setRecords] = useState<CommandRecord[]>([])
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    // 一次拉够，本地做模糊匹配 —— SQL 只负责粗筛
    listCommands({ limit: 200 })
      .then((r) => setRecords(r.items))
      .catch(() => setRecords([]))
  }, [])

  const items = useMemo(() => {
    const now = Date.now()
    const out: PaletteItem[] = []

    // 同一命令文本只出现一次（取最近一次执行）
    const seen = new Set<string>()
    const pinned: PaletteItem[] = []
    const history: PaletteItem[] = []
    for (const r of records) {
      if (seen.has(r.text)) continue
      seen.add(r.text)
      const m = fuzzyMatch(query, r.label ?? r.text) ?? fuzzyMatch(query, r.text)
      if (!m) continue
      const item: PaletteItem = { kind: 'command', record: r, score: rankScore(m, r.started_at, now) }
      // 快捷命令【始终优先】
      if (r.pinned) pinned.push(item)
      else history.push(item)
    }
    pinned.sort((a, b) => b.score - a.score)
    history.sort((a, b) => b.score - a.score)
    out.push(...pinned, ...history.slice(0, 30))

    for (const s of sessions) {
      const m = fuzzyMatch(query, s.name) ?? fuzzyMatch(query, s.cwd)
      if (m) out.push({ kind: 'session', sid: s.sid, name: s.name, cwd: s.cwd, score: m.score })
    }
    for (const a of actions) {
      const m = fuzzyMatch(query, a.label)
      if (m) out.push({ kind: 'action', id: a.id, label: a.label, score: m.score })
    }
    return out
  }, [query, records, sessions, actions])

  useEffect(() => setCursor(0), [query])

  const activate = (item: PaletteItem | undefined, run: boolean) => {
    if (!item) return
    switch (item.kind) {
      case 'command':
        // 默认【不执行】—— 从历史里选一条通常是因为它"差不多对"
        if (run) onRun(item.record.text)
        else onFill(item.record.text)
        break
      case 'session':
        onSelectSession(item.sid)
        break
      case 'action':
        actions.find((a) => a.id === item.id)?.run()
        break
    }
    onClose()
  }

  return (
    <div class="palette-backdrop" data-testid="palette" onClick={onClose}>
      <div class="palette" ref={sheetRef} onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          class="palette-input"
          data-testid="palette-input"
          placeholder="搜索会话、快捷命令、历史…"
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setCursor((c) => Math.min(c + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setCursor((c) => Math.max(c - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              activate(items[cursor], e.shiftKey)
            }
          }}
        />
        <div class="palette-list" data-testid="palette-list">
          {items.length === 0 && <div class="palette-empty">没有匹配项</div>}
          {items.map((item, i) => (
            <div
              key={keyOf(item)}
              class="palette-item"
              data-testid={`palette-item-${i}`}
              data-kind={item.kind}
              data-active={i === cursor}
              onMouseEnter={() => setCursor(i)}
              onClick={(e) => activate(item, e.shiftKey)}
            >
              {item.kind === 'command' && (
                <>
                  <span class="palette-icon">{item.record.pinned ? '★' : ' '}</span>
                  <span class="palette-text">
                    {item.record.label ?? ellipsize(item.record.text, 60)}
                  </span>
                  <span class="palette-hint">
                    {item.record.exit_code !== null && item.record.exit_code !== 0
                      ? `exit ${item.record.exit_code}`
                      : item.record.cwd}
                  </span>
                </>
              )}
              {item.kind === 'session' && (
                <>
                  <span class="palette-icon">⧉</span>
                  <span class="palette-text">会话：{item.name}</span>
                  <span class="palette-hint">{item.cwd}</span>
                </>
              )}
              {item.kind === 'action' && (
                <>
                  <span class="palette-icon">⚙</span>
                  <span class="palette-text">{item.label}</span>
                </>
              )}
            </div>
          ))}
        </div>
        <div class="palette-foot">
          Enter 填入 Composer · Shift+Enter 直接执行 · Esc 关闭
        </div>
      </div>
    </div>
  )
}

function keyOf(item: PaletteItem): string {
  switch (item.kind) {
    case 'command':
      return `c${item.record.id}`
    case 'session':
      return `s${item.sid}`
    case 'action':
      return `a${item.id}`
  }
}
