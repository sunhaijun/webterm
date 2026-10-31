/**
 * 终端字体：硬编码优选清单 + 本机探测（AC-5.13）。
 *
 * 为什么不打包 webfont、不让用户自己填字体名，见
 * docs/20-architecture/adr/0023-terminal-font-list.md。
 */
import { safeGet, safeSet } from './prefs'

export type FontGroup = 'default' | 'coding' | 'platform' | 'cjk'

export interface FontChoice {
  id: string
  /** 显示名。除"系统默认"外，它【同时就是】CSS 里的 family 名，探测拿的也是它。 */
  label: string
  group: FontGroup
  /** 真正塞给 xterm 的一整段 stack。 */
  stack: string
}

/**
 * 每段 stack 的尾巴。编程字体基本不带汉字，少了这条尾巴汉字会掉进比例字体，
 * 中英混排的列宽当场歪掉（layout.md §字体）。
 */
export const CJK_TAIL = '"Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace'

/** 没得选时的默认 —— 和 CSS 里的 `--font-mono` 是同一串。 */
export const SYSTEM_STACK = `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", ${CJK_TAIL}`

const pick = (id: string, label: string, group: FontGroup): FontChoice => ({
  id,
  label,
  group,
  stack: `"${label}", ${CJK_TAIL}`,
})

/**
 * 清单。顺序就是设置里的顺序，**加字体就是加一行**。
 *
 * 带连字的字体（Fira Code / JetBrains Mono）也能选，只是连字不会生效 ——
 * xterm 的连字要额外加载 addon-ligatures，我们不加载（layout.md §终端字体可选）。
 * 所以同一族里优先收不带连字的变体（Cascadia Mono 而不是 Cascadia Code）。
 */
export const FONT_CHOICES: readonly FontChoice[] = [
  { id: 'system', label: '系统默认', group: 'default', stack: SYSTEM_STACK },
  pick('jetbrains', 'JetBrains Mono', 'coding'),
  pick('firacode', 'Fira Code', 'coding'),
  pick('iosevka', 'Iosevka', 'coding'),
  pick('hack', 'Hack', 'coding'),
  pick('plex', 'IBM Plex Mono', 'coding'),
  pick('sourcecodepro', 'Source Code Pro', 'coding'),
  pick('cascadia', 'Cascadia Mono', 'coding'),
  pick('sfmono', 'SF Mono', 'platform'),
  pick('menlo', 'Menlo', 'platform'),
  pick('monaco', 'Monaco', 'platform'),
  pick('consolas', 'Consolas', 'platform'),
  pick('robotomono', 'Roboto Mono', 'platform'),
  pick('dejavu', 'DejaVu Sans Mono', 'platform'),
  pick('ubuntu', 'Ubuntu Mono', 'platform'),
  pick('sarasa', 'Sarasa Mono SC', 'cjk'),
  pick('notocjk', 'Noto Sans Mono CJK SC', 'cjk'),
]

export const GROUP_LABEL: Record<FontGroup, string> = {
  default: '',
  coding: '编程字体',
  platform: '平台自带',
  cjk: '中英等宽',
}

const FAMILY_KEY = 'webterm.font.family'

/** 量一段文本在某个 family 下有多宽。 */
export type Measure = (family: string) => number

// 宽窄字形混着放，再加两个汉字 —— 差别越大越不容易撞上"碰巧一样宽"
const PROBE = 'mmmmmmmmmmlliWWWWWW0O中文'
const BASES = ['monospace', 'serif', 'sans-serif']

export function canvasMeasure(): Measure | null {
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    return (family) => {
      ctx.font = `72px ${family}`
      return ctx.measureText(PROBE).width
    }
  } catch {
    return null
  }
}

let cache: FontChoice[] | null = null

/**
 * 清单里本机真的装了的那些。第一项永远是"系统默认"。
 *
 * 判据：`"X", <基线>` 和 `<基线>` 一样宽，说明 X 被整个忽略了。三条基线**全都**
 * 一样才算没装 —— 只比 `monospace` 的话，本机默认等宽字体（常常就是 Menlo /
 * Consolas）会被误判成没装。
 *
 * 结果按页面缓存一次：它不会中途变，而设置面板可能被开关很多次。
 */
export function availableFonts(measure?: Measure | null): FontChoice[] {
  if (cache) return cache
  const m = measure === undefined ? canvasMeasure() : measure
  if (!m) return (cache = [FONT_CHOICES[0]!])

  const memo = new Map<string, number>()
  const width = (family: string): number => {
    let v = memo.get(family)
    if (v === undefined) {
      v = m(family)
      memo.set(family, v)
    }
    return v
  }
  cache = FONT_CHOICES.filter(
    (c) => c.group === 'default' || BASES.some((b) => width(`"${c.label}", ${b}`) !== width(b)),
  )
  return cache
}

/** 只有测试和"清单变了"用得上。 */
export function resetFontProbe(): void {
  cache = null
}

/** id → 一整段 stack。不认得的 id 回落系统默认（清单改过之后老配置不能把终端搞没）。 */
export function fontStack(id: string): string {
  return FONT_CHOICES.find((c) => c.id === id)?.stack ?? SYSTEM_STACK
}

/**
 * 存的是 id，**全局一份不按形态分** —— 字号跟"这块屏幕多大"有关，
 * 字体跟"这台设备装了什么"有关（ADR-0023）。
 */
export function readFontFamily(): string {
  const v = safeGet(FAMILY_KEY)
  return v && FONT_CHOICES.some((c) => c.id === v) ? v : 'system'
}

export function writeFontFamily(id: string): void {
  safeSet(FAMILY_KEY, id)
}
