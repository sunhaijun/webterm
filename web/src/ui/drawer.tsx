/**
 * 浮层原语 —— 会话 / 历史 / 设置共用这一个壳（ADR-0018）。
 *
 * 触屏：贴底整宽 sheet（抓手 + 下滑关闭）；桌面：居中浮窗。四种关法完全一致：
 * 点遮罩 · `Esc` · ✕ ·（触屏）下滑。
 *
 * 【`position: fixed`，不参与 `.main` 的 flex 列】—— 开关浮层不改终端几何、
 * 不触发 fit / resize（设置横幅是这条老约束唯一的漏网之鱼，见 ADR-0018）。
 */
import type { ComponentChildren } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'

import { installSwipeDismiss } from './swipe'

export interface DrawerProps {
  title: string
  onClose(): void
  /** 遮罩的 testid：会话沿用 `scrim`，历史 `history-panel`。 */
  backdropTestid?: string
  /** sheet 本体的 testid。 */
  testid?: string
  /** 正文容器的 testid。 */
  bodyTestid?: string
  /** ✕ 的 testid，默认 `drawer-close`；历史沿用 `close-history`。 */
  closeTestid?: string
  /** 列表型浮层（历史）用定高，免得条目一多一少尺寸就跳。 */
  size?: 'auto' | 'wide'
  /** 标题右侧的附加控件。 */
  actions?: ComponentChildren
  /** 标题栏下面的工具行（搜索 / 过滤）。 */
  tools?: ComponentChildren
  /** 底部脚注（快捷键提示之类）。 */
  foot?: ComponentChildren
  children: ComponentChildren
}

export function Drawer({
  title,
  onClose,
  backdropTestid,
  testid,
  bodyTestid,
  closeTestid = 'drawer-close',
  size = 'auto',
  actions,
  tools,
  foot,
  children,
}: DrawerProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  // 【用 useLayoutEffect 而不是 useEffect】：Preact 的 useEffect 排在绘制之后
  // （rAF，最坏 100ms 后才跑），浮层已经能点了、手势与 Esc 还没挂上。
  useLayoutEffect(() => (sheetRef.current ? installSwipeDismiss(sheetRef.current, onClose) : undefined), [onClose])
  useLayoutEffect(() => {
    // 【焦点收进浮层】。它是模态：焦点留在外面的话，键盘 / 读屏用户还在背后那一层，
    // Esc 也没有明确的接收者 —— 触发它的那个按钮（⋯ 菜单项）已经随菜单卸载，
    // activeElement 退回 body，键事件全靠 window 上的兜底监听接。
    // preventScroll：别因为聚焦把背后的终端滚走。
    const el = sheetRef.current
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  }, [])
  useLayoutEffect(() => {
    // 捕获阶段兜底：焦点万一不在浮层里（比如刚打开就有别的东西抢了焦点），
    // Esc 仍归浮层，不落到终端 / Composer 里
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div class="drawer-backdrop" data-testid={backdropTestid} onClick={onClose}>
      <div
        class="drawer"
        data-size={size}
        data-testid={testid}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.preventDefault()
          onClose()
        }}
      >
        <div class="drawer-grab" />
        <div class="drawer-head">
          <h2 class="drawer-title">{title}</h2>
          {actions}
          <button class="drawer-close" data-testid={closeTestid} aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        {tools && <div class="drawer-tools">{tools}</div>}
        <div class="drawer-body" data-testid={bodyTestid}>
          {children}
        </div>
        {foot && <div class="drawer-foot">{foot}</div>}
      </div>
    </div>
  )
}
