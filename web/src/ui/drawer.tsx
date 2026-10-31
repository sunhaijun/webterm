/**
 * 浮层原语 —— 手机上的会话抽屉（ADR-0018，layout.md §浮层）。
 *
 * 只有一种形态：贴底整宽 sheet（抓手 + 下滑关闭，ADR-0030 §2）。关法：
 * 点遮罩 · `Esc` · ✕ · 下滑。`backButton` 时另加系统返回键。
 *
 * 【`position: fixed`，不参与 `.app` 的网格】—— 开关浮层不改终端几何、不发 resize。
 */
import type { ComponentChildren } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'

import { installSwipeDismiss } from './swipe'

export interface DrawerProps {
  title: string
  onClose(): void
  /** sheet 本体的 testid。 */
  testid?: string
  /** 遮罩的 testid。 */
  backdropTestid?: string
  /** 正文容器的 testid。 */
  bodyTestid?: string
  /**
   * 系统返回键关闭（session-ux.md）：打开时 `history.pushState` 一条记录，`popstate`
   * 时关闭；用别的方式关闭时 `history.back()` 把那条记录消掉，不让记录越积越多 ——
   * 否则 Android 的 PWA 里按返回键会直接退出应用。
   */
  backButton?: boolean
  /** 底部固定的一行（会话抽屉的「+ 新会话」）。 */
  foot?: ComponentChildren
  children: ComponentChildren
}

export function Drawer({
  title,
  onClose,
  testid,
  backdropTestid = 'drawer-backdrop',
  bodyTestid,
  backButton = false,
  foot,
  children,
}: DrawerProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // 【useLayoutEffect 而不是 useEffect】：Preact 的 useEffect 排在绘制之后，
  // 浮层已经能点了、手势与 Esc 还没挂上。
  useLayoutEffect(() => (sheetRef.current ? installSwipeDismiss(sheetRef.current, () => closeRef.current()) : undefined), [])
  useLayoutEffect(() => {
    // 【焦点收进浮层】：它是模态，焦点留在外面的话 Esc 没有确定的接收者。
    // 打开会话抽屉时这一步也让软键盘收起，抽屉拿到完整高度。
    const el = sheetRef.current
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  }, [])
  useLayoutEffect(() => {
    // 捕获阶段兜底：焦点万一不在浮层里，Esc 仍归浮层，不落到终端里。
    // 例外是自己处理 Esc 的控件（改名输入框、会话菜单，标了 data-esc-local）：
    // Esc 是取消它们，不是关浮层
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if ((e.target as Element | null)?.closest?.('[data-esc-local]')) return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  useLayoutEffect(() => {
    if (!backButton) return
    let popped = false
    history.pushState({ webtermDrawer: true }, '')
    const onPop = () => {
      popped = true
      closeRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // 不是返回键关的：把自己压的那条记录消掉
      if (!popped) history.back()
    }
  }, [backButton])

  return (
    <div class="drawer-backdrop" data-testid={backdropTestid} onClick={() => closeRef.current()}>
      <div
        class="drawer"
        data-testid={testid}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="drawer-grab" />
        <div class="drawer-head">
          <h2 class="drawer-title">{title}</h2>
          <button class="drawer-close" data-testid="drawer-close" aria-label="关闭" onClick={() => closeRef.current()}>
            ✕
          </button>
        </div>
        <div class="drawer-body" data-testid={bodyTestid}>
          {children}
        </div>
        {foot && <div class="drawer-foot">{foot}</div>}
      </div>
    </div>
  )
}
