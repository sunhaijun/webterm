/**
 * 写态 sheet 顶上那排 chips 的数据 —— ADR-0011 分片 ③。
 *
 * 输入框空着：快捷命令 + 同目录历史（"在这个目录里我通常干什么"）。
 * 输入框有内容：光标处 token 的路径补全 + 以整段输入为前缀的历史。
 */
import { useEffect, useRef, useState } from 'preact/hooks'

import { listCommands, type CommandRecord } from '../commands/api'
import {
  type Chip,
  completionText,
  fetchPaths,
  splitToken,
  tokenAt,
  unescapeToken,
  wantsPath,
} from './complete'
import { fetchHistory } from './history'

export interface ChipsInput {
  /** sheet 没开就不去拉数据。 */
  open: boolean
  /** 会话 CWD（OSC 7）；没有就不做路径补全、不做同目录过滤。 */
  cwd: string
  pinned: CommandRecord[]
  value: string
  cursor: number
  /** 命令跑完 +1，让同目录历史刷新。 */
  tick: number
}

export const MAX_PINS = 10
export const MAX_CMDS = 8
export const MAX_PATHS = 12

/** 计算一次 chips。抽出来是为了不起浏览器就能测。 */
export async function computeChips(i: ChipsInput, signal?: AbortSignal): Promise<Chip[]> {
  const out: Chip[] = []
  if (i.value.trim() === '') {
    for (const r of i.pinned.slice(0, MAX_PINS)) out.push({ kind: 'pin', text: r.text, label: r.label ?? undefined })
    const seen = new Set(out.map((c) => c.text))
    if (i.cwd) {
      const r = await listCommands({ cwd: i.cwd, limit: 40 })
      let n = 0
      for (const it of r.items) {
        if (seen.has(it.text) || it.pinned) continue
        seen.add(it.text)
        out.push({ kind: 'cmd', text: it.text })
        if (++n >= MAX_CMDS) break
      }
    }
    return out
  }
  const token = tokenAt(i.value, i.cursor)
  const [paths, hist] = await Promise.all([
    i.cwd && wantsPath(i.value, token)
      ? fetchPaths(i.cwd, unescapeToken(token.text), signal)
      : Promise.resolve({ items: [] }),
    fetchHistory(i.value, 20),
  ])
  const { dirPrefix } = splitToken(token.text)
  for (const it of paths.items.slice(0, MAX_PATHS)) {
    out.push({ kind: 'path', text: completionText(dirPrefix, it), dir: it.dir })
  }
  let n = 0
  for (const h of hist) {
    if (h === i.value) continue
    out.push({ kind: 'cmd', text: h })
    if (++n >= MAX_CMDS) break
  }
  return out
}

export function useChips(i: ChipsInput): Chip[] {
  const [chips, setChips] = useState<Chip[]>([])
  const gen = useRef(0)
  useEffect(() => {
    if (!i.open) {
      setChips([])
      return
    }
    const my = ++gen.current
    const ctl = new AbortController()
    // 120ms：敲字期间不刷；停一下才问
    const t = setTimeout(() => {
      computeChips(i, ctl.signal)
        .catch(() => [] as Chip[])
        .then((out) => {
          if (gen.current === my) setChips(out)
        })
    }, 120)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i.open, i.cwd, i.pinned, i.value, i.cursor, i.tick])
  return chips
}
