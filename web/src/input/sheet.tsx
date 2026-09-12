/**
 * 编辑面板 sheet —— ADR-0011 分片 ③，形态按 ADR-0014 / ADR-0015。
 *
 * 点互切键升起：上面一条 16px 抓手（拖动按位置吸附，点一下半屏 ⇄ 全屏，拖到底
 * 收起），可选一排 chips（快捷命令 / 同目录历史 / 路径补全），中间输入框吃掉剩余
 * 高度，底部一条键行：行首互切键（切回终端输入）· 命令在跑时的程序键 Esc ^C ·
 * 面向"写"的编辑键（横滚）· 行尾「发送」。没有「收起」—— 拖到底、空输入再按 Esc、
 * 互切键都能收。
 *
 * 【sheet 是盖在终端上的，不挤它】：.bottom 绝对定位在一个定高的 .bottom-slot
 * 里，往上长只会盖住终端，画布 .canvas 的几何完全不变 —— xterm 不会因此
 * resize，PTY 不会收到 SIGWINCH。
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { Chip } from './complete'
import { EDIT_KEYS, type KeyDef, bytesOf } from './keymap'

export type SheetSize = 'closed' | 'half' | 'full'

/** 槽位的默认高度；实际以 .bottom-slot 量出来的为准（short 布局是 40px）。 */
export const SLOT_HEIGHT = 56

/** 槽位的实际高度 —— 拖动的下限、全屏高度的下限都以它为准。 */
function slotHeightOf(el: HTMLElement | null): number {
  const slot = el?.closest('.bottom-slot') as HTMLElement | null
  const h = slot?.getBoundingClientRect().height
  return h && h > 0 ? Math.round(h) : SLOT_HEIGHT
}

export interface WriteSheetProps {
  size: SheetSize
  onSize(next: SheetSize): void
  /** .bottom 的实际高度变了（盖住终端多少）。 */
  onHeight(h: number): void
  chips: Chip[]
  onChip(c: Chip): void
  /** 触摸设备才显示编辑键；接了键盘的平板只剩互切键与发送。 */
  editKeys: boolean
  onEditKey(key: string): void
  onSend(): void
  /** 长按发送：只粘贴不回车（命令在跑时）。 */
  onSendHold?(): void
  /** 输入框：Composer（命令在跑时也是它，整段粘贴发送）。 */
  children: ComponentChildren
  /** 键行行首的互切键（切回终端输入）。class 要带 keybar-key。 */
  lead?: ComponentChildren
  /** 并入键行的程序键（命令在跑时的 Esc ^C），直发 PTY。 */
  programKeys?: readonly KeyDef[]
  onRaw?(bytes: string): void
}

/** 让按钮不抢输入框的焦点 —— 软键盘一收一弹是最糟的体验。 */
const keepFocus = (e: Event) => e.preventDefault()

export function WriteSheet(p: WriteSheetProps) {
  // 长按「发送」= 只粘贴不回车
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const held = useRef(false)
  const cancelHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current)
    holdTimer.current = undefined
  }
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ y0: number; h0: number; moved: boolean } | null>(null)
  /** 半屏 / 全屏时的像素高度；收起时 null（由内容决定）。 */
  const [px, setPx] = useState<number | null>(null)
  const sizeRef = useRef(p.size)
  sizeRef.current = p.size
  const onHeightRef = useRef(p.onHeight)
  onHeightRef.current = p.onHeight

  // 半屏 / 全屏的像素高度取自 .main 的实际高度：键盘弹出 .main 变矮，sheet 跟着矮。
  // 半屏至少 190px —— 抓手 + 一行输入 + 键行，再少就摆不下了。
  const targets = () => {
    const main = ref.current?.closest('.main') as HTMLElement | null
    const canvas = main?.querySelector('.canvas') as HTMLElement | null
    if (!main) return { half: 260, full: 400 }
    const m = main.getBoundingClientRect()
    const top = canvas ? canvas.getBoundingClientRect().top : m.top + 28
    const full = Math.max(slotHeightOf(ref.current), Math.round(m.bottom - top))
    const half = Math.min(full, Math.max(190, Math.round(m.height * 0.46)))
    return { half, full }
  }
  const apply = (size: SheetSize) => {
    if (size === 'closed') {
      setPx(null)
      return
    }
    const t = targets()
    setPx(size === 'half' ? t.half : t.full)
  }
  useLayoutEffect(() => {
    apply(p.size)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.size])

  useEffect(() => {
    const el = ref.current
    const main = el?.closest('.main')
    if (!el || !main) return
    // .main 变矮 / 变高（键盘、旋转）→ 重算目标高度；自己多高就告诉外面
    const roMain = new ResizeObserver(() => {
      if (!drag.current) apply(sizeRef.current)
    })
    roMain.observe(main)
    const roSelf = new ResizeObserver(() => onHeightRef.current(el.getBoundingClientRect().height))
    roSelf.observe(el)
    return () => {
      roMain.disconnect()
      roSelf.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onDown = (e: PointerEvent) => {
    const el = ref.current
    if (!el) return
    drag.current = { y0: e.clientY, h0: el.getBoundingClientRect().height, moved: false }
    setDragging(true)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dy = d.y0 - e.clientY
    if (Math.abs(dy) > 6) d.moved = true
    if (!d.moved) return
    const t = targets()
    setPx(Math.min(t.full, Math.max(slotHeightOf(ref.current), Math.round(d.h0 + dy))))
  }
  const onUp = () => {
    const d = drag.current
    const el = ref.current
    drag.current = null
    setDragging(false)
    if (!d || !el) return
    if (!d.moved) {
      // 点一下：半屏 ⇄ 全屏
      p.onSize(p.size === 'full' ? 'half' : 'full')
      return
    }
    // 拖完按位置吸附：不到半屏的一半多 → 收起；半屏与全屏之间取近的
    const h = el.getBoundingClientRect().height
    const t = targets()
    const next: SheetSize = h < t.half * 0.55 ? 'closed' : h < (t.half + t.full) / 2 ? 'half' : 'full'
    apply(next)
    if (next !== p.size) p.onSize(next)
  }

  const open = p.size !== 'closed'
  const programKeys = p.programKeys ?? []
  return (
    <div class="bottom-slot">
      <div
        class="bottom"
        data-testid="bottom"
        data-sheet={p.size}
        data-dragging={dragging}
        ref={ref}
        style={open && px !== null ? { height: `${px}px` } : undefined}
      >
        <div class="sheet-head">
          <div
            class="handle"
            data-testid="sheet-handle"
            role="separator"
            aria-label="拖动调整高度；点一下在半屏与全屏之间切换"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <span />
          </div>
        </div>
        {open && p.chips.length > 0 && (
          // 为空就不渲染 —— 空条也占高度（ADR-0015）
          <div class="chips" data-testid="chips" role="listbox" aria-label="建议">
            {p.chips.map((c) => (
              <button
                key={`${c.kind}:${c.text}`}
                class="chip"
                role="option"
                data-kind={c.kind}
                data-testid="chip"
                title={
                  c.kind === 'path' ? '目录里真实存在的路径，点一下补进去' : c.kind === 'pin' ? '快捷命令' : '这个目录里跑过的命令'
                }
                onPointerDown={keepFocus}
                onClick={() => p.onChip(c)}
              >
                {c.kind === 'pin' && c.label ? c.label : c.text}
              </button>
            ))}
          </div>
        )}
        <div class="bar">{p.children}</div>
        {open && (
          // 键行：行首互切键 · 程序键 · 编辑键（横滚）· 行尾发送 —— 与终端态同一副骨架（ADR-0015）
          <div class="editkeys" data-testid="editkeys" role="toolbar" aria-label="编辑键">
            {p.lead}
            {programKeys.length > 0 && (
              <>
                {programKeys.map((k) => (
                  <button
                    key={k.key}
                    class="keybar-key"
                    data-testid={`key-${k.key}`}
                    onPointerDown={keepFocus}
                    onClick={() => {
                      const b = bytesOf(k)
                      if (b !== undefined) p.onRaw?.(b)
                    }}
                  >
                    {k.label}
                  </button>
                ))}
                <span class="keyrow-div" aria-hidden="true" />
              </>
            )}
            {p.editKeys && (
              <div class="editkeys-scroll">
                {EDIT_KEYS.map((k) => (
                  <button
                    key={k.key}
                    class="editkey"
                    data-testid={`edit-${k.key}`}
                    onPointerDown={keepFocus}
                    onClick={() => p.onEditKey(k.key)}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            )}
            <button
              class="editkey-send"
              data-testid="send"
              title="发送 = 粘贴 + 回车；长按 = 只粘贴不回车"
              onPointerDown={(e) => {
                keepFocus(e)
                held.current = false
                if (p.onSendHold) holdTimer.current = setTimeout(() => {
                  held.current = true
                  p.onSendHold?.()
                }, 450)
              }}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              onPointerCancel={cancelHold}
              onClick={() => {
                if (held.current) {
                  held.current = false
                  return
                }
                p.onSend()
              }}
            >
              发送
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
