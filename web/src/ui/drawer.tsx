/**
 * 浮层原语 —— 会话 / 历史 / 命令面板 / 设置共用这一个壳（ADR-0018）。
 *
 * 触屏：贴底整宽 sheet（抓手 + 下滑关闭）；桌面：居中浮窗。四种关法完全一致：
 * 点遮罩 · `Esc` · ✕ ·（触屏）下滑。
 *
 * 【`position: fixed`，不参与 `.main` 的 flex 列】—— 开关浮层不改终端几何、
 * 不触发 fit / resize（设置横幅是这条老约束唯一的漏网之鱼，见 ADR-0018）。
 */
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

import { installSwipeDismiss } from './swipe'

export interface DrawerProps {
  title: string
  onClose(): void
  /** 遮罩的 testid：会话沿用 `scrim`，历史 `history-panel`，命令面板 `palette`。 */
  backdropTestid?: string
  /** sheet 本体的 testid。 */
  testid?: string
  /** 正文容器的 testid：命令面板的列表沿用 `palette-list`。 */
  bodyTestid?: string
  /** ✕ 的 testid，默认 `drawer-close`；历史沿用 `close-history`。 */
  closeTestid?: string
  /** 列表型浮层（历史）用定高，免得条目一多一少尺寸就跳。 */
  size?: 'auto' | 'wide'
  /** 标题右侧的附加控件。 */
  actions?: ComponentChildren
  /** 标题栏下面的工具行（搜索 / 过滤 / 命令面板的输入框）。 */
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
  useEffect(() => (sheetRef.current ? installSwipeDismiss(sheetRef.current, onClose) : undefined), [onClose])
  useEffect(() => {
    // 捕获阶段：浮层开着的时候 Esc 归浮层，不落到终端 / Composer 里
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
        onClick={(e) => e.stopPropagation()}
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
