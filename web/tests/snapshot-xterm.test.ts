/**
 * UT-snapshot-xterm：快照屏幕级一致（AC-2.21，ADR-0026 §10）。
 *
 * 拿 xterm.js（@xterm/headless 5.5 + unicode11）当裁判：
 *
 *   参照：一个 xterm 直接吃整段录制字节，在每个截断点 k 拍一张「格子」；
 *   对照：新的 xterm 照浏览器的路径先吃 agent 在 k 处生成的快照（RIS + 流式解码），
 *         拍一张，与参照在 k 处比（接上那一刻）；再吃 k 之后的字节，与参照在末尾比。
 *
 * 逐格比字符、宽度、颜色、属性，外加光标、光标隐藏、终端模式、当前是不是备用屏。
 * 主屏从底往上对齐比（快照只带至多 2000 行历史，参照顶上多出来的不算错）。
 *
 * 只允许 ADR-0026 列出的已知差异：
 *   - 软换行标记（xterm 记在下一行，tuios 记在上一行；只在重排时才显出来）；
 *   - 行末最后一格：程序写满整行后 EL，xterm.js 不擦最后一格（top 表头少了反白）；
 *   - SGR 53（上划线）被快照丢掉；
 *   - 关闭自动换行时光标停在最后一列的记法（x = cols 对 cols-1）。
 *
 * 录制夹具在 internal/vterm/testdata/rec/<name>.bin|json，金样（各截断点的快照）由 Go 侧
 * 生成到 internal/vterm/testdata/snap/<name>.<k>.snap 与 snap/cuts.json。
 * 环境变量 WEBTERM_SNAP_DIR 可以把金样目录指到别处（离线试验用）。
 *
 * **金样缺了是失败，不是跳过** —— 那样会假绿。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import headless from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { describe, expect, it } from 'vitest'

import { RIS } from '../src/term/terminal'

const { Terminal } = headless
type HTerm = InstanceType<typeof Terminal>

const REC_DIR = resolve(process.cwd(), '../internal/vterm/testdata/rec')
const SNAP_DIR = process.env.WEBTERM_SNAP_DIR
  ? resolve(process.env.WEBTERM_SNAP_DIR)
  : resolve(process.cwd(), '../internal/vterm/testdata/snap')
const CUTS = join(SNAP_DIR, 'cuts.json')

interface Meta {
  name: string
  cols: number
  rows: number
}

/** 和浏览器一样：每个终端一个流式 UTF-8 解码器，先解码成字符串再写。 */
interface Judge {
  t: HTerm
  dec: TextDecoder
}

function mk(cols: number, rows: number): Judge {
  const t = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true })
  t.loadAddon(new Unicode11Addon() as unknown as Parameters<HTerm['loadAddon']>[0])
  t.unicode.activeVersion = '11'
  return { t, dec: new TextDecoder('utf-8') }
}

const write = (j: Judge, s: string) => new Promise<void>((r) => j.t.write(s, () => r()))
const feed = (j: Judge, b: Uint8Array) => write(j, j.dec.decode(b, { stream: true }))
/** 浏览器收到快照：RIS（在流内复位）→ 换新解码器 → 写快照。 */
const feedSnapshot = (j: Judge, b: Uint8Array) => {
  j.dec = new TextDecoder('utf-8')
  return write(j, RIS + j.dec.decode(b, { stream: true }))
}

// ---------- 格子 ----------

/** 调色板色：31m（P16）与 38;5;1m（P256）看起来一样，归成同一种。 */
const colorMode = (mode: number) => (mode === 0 ? 'd' : mode === 0x3000000 ? 'r' : 'p')

type Cell = NonNullable<ReturnType<NonNullable<ReturnType<HTerm['buffer']['active']['getLine']>>['getCell']>>

/** 一格 = 字符 | 宽度 | 前景 | 背景 | 9 个属性位（粗 斜 暗 下划线 闪 反白 隐藏 删除线 上划线）。 */
function cellKey(c: Cell): string {
  const ch = c.getChars() || ' '
  const flags = [c.isBold(), c.isItalic(), c.isDim(), c.isUnderline(), c.isBlink(), c.isInverse(), c.isInvisible(), c.isStrikethrough(), c.isOverline()]
    .map((v) => (v ? 1 : 0))
    .join('')
  // 空格（且没有反白 / 下划线 / 删除线 / 上划线）的前景色画不出来，归一掉
  const blankInk = ch === ' ' && !c.isInverse() && !c.isUnderline() && !c.isStrikethrough() && !c.isOverline()
  const fg = blankInk || c.isFgDefault() ? 'd' : colorMode(c.getFgColorMode()) + c.getFgColor()
  const bg = c.isBgDefault() ? 'd' : colorMode(c.getBgColorMode()) + c.getBgColor()
  return `${ch}|${c.getWidth()}|${fg}|${bg}|${flags}`
}

interface Line {
  wrapped: boolean
  cells: string[]
  text: string
}

interface Grid {
  type: string
  cx: number
  cy: number
  hidden: boolean | null
  modes: Record<string, unknown>
  normal: Line[]
  alt: Line[]
}

function lineOf(buf: HTerm['buffer']['normal'], y: number, cols: number): Line {
  const line = buf.getLine(y)!
  const cells: string[] = []
  for (let x = 0; x < cols; x++) cells.push(cellKey(line.getCell(x)!))
  return { wrapped: line.isWrapped, cells, text: line.translateToString(true) }
}

function grid(t: HTerm): Grid {
  const a = t.buffer.active
  const modes: Record<string, unknown> = {}
  const m = t.modes as unknown as Record<string, unknown>
  for (const k of Object.keys(m)) modes[k] = m[k]
  const g: Grid = {
    type: a.type,
    cx: a.cursorX,
    cy: a.cursorY,
    hidden: (t as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core?.coreService?.isCursorHidden ?? null,
    modes,
    normal: [],
    alt: [],
  }
  const n = t.buffer.normal
  for (let y = 0; y < n.length; y++) g.normal.push(lineOf(n, y, t.cols))
  if (a.type === 'alternate') {
    const al = t.buffer.alternate
    for (let y = 0; y < al.length; y++) g.alt.push(lineOf(al, y, t.cols))
  }
  return g
}

// ---------- 比较 ----------

interface Diff {
  what: string
  /** null = 解释不了的差异；否则是允许的已知差异的名字。 */
  allowed: string | null
  detail: string
}

/** 只差上划线那一位。 */
function overlineOnly(r: string, c: string): boolean {
  const a = r.split('|')
  const b = c.split('|')
  if (a.slice(0, 4).join('|') !== b.slice(0, 4).join('|')) return false
  const fa = a[4]!
  const fb = b[4]!
  return fa.slice(0, 8) === fb.slice(0, 8) && fa[8] !== fb[8]
}

/** 字符与宽度相同（只差颜色或属性）。 */
function sameGlyph(r: string, c: string): boolean {
  const a = r.split('|')
  const b = c.split('|')
  return a[0] === b[0] && a[1] === b[1]
}

function compare(ref: Grid, cli: Grid, cols: number): Diff[] {
  const out: Diff[] = []
  if (ref.type !== cli.type) out.push({ what: 'buffer', allowed: null, detail: `${ref.type} / ${cli.type}` })
  if (ref.cx !== cli.cx || ref.cy !== cli.cy) {
    const xs = [ref.cx, cli.cx].sort((x, y) => x - y)
    const autowrapOff = ref.modes.wraparoundMode === false
    const allowed = ref.cy === cli.cy && autowrapOff && xs[0] === cols - 1 && xs[1] === cols ? '关自动换行时光标 x 的记法' : null
    out.push({ what: 'cursor', allowed, detail: `参照 (${ref.cx},${ref.cy}) / 快照 (${cli.cx},${cli.cy})` })
  }
  if (ref.hidden !== cli.hidden) out.push({ what: 'cursor-hidden', allowed: null, detail: `${ref.hidden} / ${cli.hidden}` })
  for (const k of Object.keys(ref.modes)) {
    if (ref.modes[k] !== cli.modes[k]) out.push({ what: `mode:${k}`, allowed: null, detail: `${String(ref.modes[k])} / ${String(cli.modes[k])}` })
  }
  for (const which of ref.type === 'alternate' ? (['normal', 'alt'] as const) : (['normal'] as const)) {
    const R = ref[which]
    const C = cli[which]
    const n = Math.min(R.length, C.length)
    for (let i = 1; i <= n; i++) {
      const r = R[R.length - i]!
      const c = C[C.length - i]!
      // 最顶上那一行的软换行标记取决于它上面有没有被截掉的历史，不比
      if (i < n && r.wrapped !== c.wrapped) {
        out.push({ what: `${which}:wrap`, allowed: '软换行标记', detail: `倒数第 ${i} 行「${r.text}」` })
      }
      for (let x = 0; x < cols; x++) {
        const rc = r.cells[x]!
        const cc = c.cells[x]!
        if (rc === cc) continue
        const allowed = overlineOnly(rc, cc)
          ? 'SGR 53 上划线'
          : x === cols - 1 && sameGlyph(rc, cc)
            ? '行末最后一格（EL 不擦）'
            : null
        out.push({
          what: `${which}:cell`,
          allowed,
          detail: `倒数第 ${i} 行 x=${x}：参照 ${rc} / 快照 ${cc}\n    参照「${r.text}」\n    快照「${c.text}」`,
        })
      }
    }
  }
  return out
}

// ---------- 金样 ----------

function recordings(): Meta[] {
  if (!existsSync(REC_DIR)) return []
  return readdirSync(REC_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(REC_DIR, f), 'utf8')) as Meta)
}

/** cuts.json：`{ <name>: [{ k, ... }] }`（也接受 `{ <name>: [k, ...] }`）。 */
function cutsOf(all: Record<string, unknown>, name: string): number[] | null {
  const v = all[name]
  if (!Array.isArray(v)) return null
  return v.map((x) => (typeof x === 'number' ? x : (x as { k: number }).k)).sort((a, b) => a - b)
}

const recs = recordings()
const golden = existsSync(CUTS)
const allCuts: Record<string, unknown> = golden ? JSON.parse(readFileSync(CUTS, 'utf8')) : {}

describe('UT-snapshot-xterm 快照屏幕级一致（AC-2.21）', () => {
  it('录制夹具与金样都在', () => {
    expect(recs.length, `缺录制夹具：${REC_DIR} 里没有 *.json`).toBeGreaterThan(0)
    expect(
      golden,
      `缺金样：${CUTS} 不存在 —— 先跑 Go 侧生成各截断点的快照（internal/vterm 的 UT-vterm-golden）`,
    ).toBe(true)
  })

  for (const m of recs) {
    it(
      m.name,
      async () => {
        expect(golden, `缺金样：${CUTS} 不存在`).toBe(true)
        const cuts = cutsOf(allCuts, m.name)
        expect(cuts, `缺金样：cuts.json 里没有 ${m.name}`).not.toBeNull()
        const missing = cuts!.map((k) => join(SNAP_DIR, `${m.name}.${k}.snap`)).filter((f) => !existsSync(f))
        expect(missing, `缺金样：${missing.slice(0, 3).join(', ')}`).toEqual([])

        const bytes = new Uint8Array(readFileSync(join(REC_DIR, `${m.name}.bin`)))
        // 参照：顺着吃，在每个截断点拍照
        const ref = mk(m.cols, m.rows)
        const refAt = new Map<number, Grid>()
        let prev = 0
        for (const k of cuts!) {
          await feed(ref, bytes.subarray(prev, k))
          prev = k
          refAt.set(k, grid(ref.t))
        }
        await feed(ref, bytes.subarray(prev))
        const refEnd = grid(ref.t)
        ref.t.dispose()

        const bad: string[] = []
        const allowed: Record<string, number> = {}
        const tally = (k: number, phase: string, diffs: Diff[]) => {
          for (const d of diffs) {
            if (d.allowed) allowed[d.allowed] = (allowed[d.allowed] ?? 0) + 1
            else if (bad.length < 8) bad.push(`k=${k}（${phase}）${d.what}: ${d.detail}`)
            else bad.push('…')
          }
        }
        for (const k of cuts!) {
          const snap = new Uint8Array(readFileSync(join(SNAP_DIR, `${m.name}.${k}.snap`)))
          const cli = mk(m.cols, m.rows)
          await feedSnapshot(cli, snap)
          tally(k, '接上那一刻', compare(refAt.get(k)!, grid(cli.t), m.cols))
          if (k < bytes.length) {
            await feed(cli, bytes.subarray(k))
            tally(k, '跑到结束', compare(refEnd, grid(cli.t), m.cols))
          }
          cli.t.dispose()
        }
        if (Object.keys(allowed).length) console.info(`${m.name}: 已知差异 ${JSON.stringify(allowed)}`)
        expect(bad, `${m.name} 有解释不了的差异：\n${bad.join('\n')}`).toEqual([])
      },
      120_000,
    )
  }
})
