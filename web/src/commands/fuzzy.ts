/**
 * 子序列模糊匹配 —— docs/40-frontend/commands-ux.md §命令面板。
 *
 * 【不用正则】。连续匹配加权、词首匹配加权，让 "gtr" 能打中
 * "go test -run" 而不是随便一个含 g/t/r 的东西。
 */

export interface FuzzyResult {
  score: number
  /** 命中的字符下标，用于高亮。 */
  positions: number[]
}

// 连续匹配的权重【必须高于】词首匹配：否则 "t-e-s-t" 会因为攒了一堆
// 词首奖励而排到精确的 "test" 前面 —— 那明显不是用户想要的。
const CONSECUTIVE_BONUS = 12
const WORD_START_BONUS = 10
const LEADING_PENALTY = 1
const MAX_LEADING_PENALTY = 9

/** 匹配 query 到 text。不匹配返回 null。空 query 视为匹配，得分 0。 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (query === '') return { score: 0, positions: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  const positions: number[] = []
  let score = 0
  let ti = 0
  let prevMatch = -2

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!
    let found = -1
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti
        break
      }
      ti++
    }
    if (found < 0) return null

    if (found === prevMatch + 1) score += CONSECUTIVE_BONUS
    if (isWordStart(t, found)) score += WORD_START_BONUS
    if (qi === 0) {
      // 越靠后开始匹配，越不像用户想要的
      score -= Math.min(found * LEADING_PENALTY, MAX_LEADING_PENALTY)
    }

    positions.push(found)
    prevMatch = found
    ti++
  }
  // 短文本更可能是用户想找的那条
  score += Math.max(0, 20 - text.length / 4)
  return { score, positions }
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]!
  return prev === ' ' || prev === '-' || prev === '_' || prev === '/' || prev === '.'
}

/**
 * 时间衰减：越久没跑过的命令排得越后。
 *
 * 半衰期 7 天 —— 一周前跑过的命令权重减半。
 */
export function recencyWeight(startedAt: number, now = Date.now()): number {
    const days = Math.max(0, (now - startedAt) / 86_400_000)
  return 2 ** (-days / 7)
}

/** 命令面板的最终排序分：模糊匹配得分 × 时间衰减。 */
export function rankScore(match: FuzzyResult, startedAt: number, now = Date.now()): number {
  // 得分可能是负的，先平移到正区间再乘衰减，否则越旧反而越靠前
  return (match.score + 40) * recencyWeight(startedAt, now)
}
