/**
 * 侧栏几何 —— docs/40-frontend/layout-responsive.md §desktop「侧栏宽度可拖、可收起」（AC-5.12）。
 *
 * 夹紧 / 吸附 / 收起判定全是纯函数，不碰 DOM —— 拖动的手感就是这几个数，
 * 只有它们能单测，拖动本身不能。
 */
import { safeGet, safeSet } from './settings'

export const SIDEBAR_DEFAULT = 240
/** 最小宽。触屏下会话项右侧三个图标各 44px（style.css 的 pointer:coarse 一节），光按钮就吃掉 132px。 */
const MIN_FINE = 200
const MIN_COARSE = 260
const MAX_PX = 480
/** 上限再受窗口约束：侧栏不该吃掉窗口的四成以上。 */
const MAX_RATIO = 0.4
/** 离默认宽这么近就吸附回去。 */
const SNAP = 12
/** 拖到最小宽的六成以下，松手即收起 —— 同写态 sheet 的「拖到底收起」。 */
const COLLAPSE_RATIO = 0.6
/** 键盘步进：方向键 16px，Shift 加持 64px。 */
export const STEP = 16
export const STEP_BIG = 64

const W_KEY = 'webterm.sidebar.w'
const OPEN_KEY = 'webterm.sidebar.open'

export function sidebarMin(coarse: boolean): number {
  return coarse ? MIN_COARSE : MIN_FINE
}

/** 上限【永远不低于下限】—— 窄窗口上 40% 可能比最小宽还小，反过来夹紧会得到空区间。 */
export function sidebarMax(winW: number, coarse: boolean): number {
  return Math.max(sidebarMin(coarse), Math.min(MAX_PX, Math.round(winW * MAX_RATIO)))
}

export function clampSidebarWidth(px: number, winW: number, coarse: boolean): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT
  return Math.min(sidebarMax(winW, coarse), Math.max(sidebarMin(coarse), Math.round(px)))
}

export interface Settled {
  width: number
  open: boolean
}

/**
 * 松手时结算。`raw` 是指针位置算出来的原始宽度（可能越界甚至为负），
 * `start` 是这次拖动开始时的宽度 —— 收起时宽度保持 `start` 不动，
 * 下次展开才能回到收起前的样子。
 */
export function settleSidebarWidth(raw: number, start: number, winW: number, coarse: boolean): Settled {
  if (raw < sidebarMin(coarse) * COLLAPSE_RATIO) {
    return { width: clampSidebarWidth(start, winW, coarse), open: false }
  }
  const w = clampSidebarWidth(raw, winW, coarse)
  const snapped = Math.abs(w - SIDEBAR_DEFAULT) <= SNAP ? SIDEBAR_DEFAULT : w
  return { width: clampSidebarWidth(snapped, winW, coarse), open: true }
}

/**
 * 拖动中预览线的位置（距 `.app` 左缘的像素）—— 【就是松手的结果】，不是指针位置：
 * 夹紧、吸附回默认宽、拖过门槛收起，全部在拖动中就显形（ADR-0021）。
 * 收起意味着列宽 0，所以预览线落在左缘。
 */
export function previewEdge(raw: number, start: number, winW: number, coarse: boolean): number {
  const st = settleSidebarWidth(raw, start, winW, coarse)
  return st.open ? st.width : 0
}

/** 键盘步进后夹紧。 */
export function stepSidebarWidth(cur: number, delta: number, winW: number, coarse: boolean): number {
  return clampSidebarWidth(cur + delta, winW, coarse)
}

/** 存的是裸像素值；上下限随窗口和指针类型变，所以【读的时候再夹】，不在写的时候定死。 */
export function readSidebarWidth(): number {
  const n = Number(safeGet(W_KEY))
  return Number.isFinite(n) && n > 0 ? n : SIDEBAR_DEFAULT
}

export function writeSidebarWidth(px: number): void {
  safeSet(W_KEY, String(Math.round(px)))
}

/** 默认展开 —— 桌面本来就是常驻侧栏。 */
export function readSidebarOpen(): boolean {
  return safeGet(OPEN_KEY) !== '0'
}

export function writeSidebarOpen(open: boolean): void {
  safeSet(OPEN_KEY, open ? '1' : '0')
}
