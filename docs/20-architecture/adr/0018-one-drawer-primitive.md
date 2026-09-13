# ADR-0018 次要界面共用一个浮层原语：触屏底部 sheet，桌面居中浮窗

> **其中「命令面板」已随 [ADR-0021](0021-drop-command-palette.md) 删除**（`Drawer` 原语与其余三个使用者 —— 会话 / 历史 / 设置 —— 不变）。下文提到命令面板的部分保留作历史记录。

状态：已接受（2026-09-12）。**收口 [ADR-0013](0013-terminal-only.md) §5「移动端 chrome 走原生模式」**：把会话、历史、命令面板、设置四个次要界面收进同一个 `Drawer` 原语。终端唯一显示面、互切模型（[ADR-0014](0014-input-toggle.md)）、底栏单行键行（[ADR-0015](0015-bottom-keyrow.md)）都不变。

## 背景

⋯ 菜单里并排的四项，点开之后是三种完全不同的东西：

| 入口 | 触屏形态 | 遮罩 | 抓手 | 标题栏 / 关闭 | 下滑关闭 | 圆角 |
|---|---|---|---|---|---|---|
| 历史 | 底部 sheet（`.panel`，86vh） | 45% | 有（`::before`） | 只有一排工具按钮 | 有 | 16px |
| 命令面板 | 底部 sheet（`.palette`，80vh） | 45% | 有（`::before`） | 无 | 有 | 16px |
| 会话 | phone 底部 sheet（`.sidebar`，70%）；**tablet 是左侧抽屉** | 40% | 无 | 无 | 有 | 12px |
| 设置 | **不是浮层**：`.banner`，插在 `.main` 里把终端往上挤 | 无 | 无 | 无 | 无 | 0 |

成因是时间差，不是设计：`b60d98c` 那轮「统一成原生底部 sheet」只收编了**浮层**，而设置从桌面模式条时代起就是一条 12px 的横幅，不在名单里；会话抽屉那轮只补了下滑关闭，形态（圆角、抓手、遮罩、tablet 左出）没有跟齐。

结果是同一个菜单里点四下，得到四种交互约定：设置没法点外面关、没有关闭按钮、还会把终端顶上去（正在看的位置就跑了）；会话在平板上从左边出来，而它上一行的「历史」从底部出来。

## 决定

1. **一个浮层原语 `Drawer`**（`web/src/ui/drawer.tsx`），会话 / 历史 / 命令面板 / 设置**全部**走它。结构固定：
   ```
   遮罩（点击关闭）
     └ sheet：抓手 · 标题栏（标题 + 可选工具 + ✕） · 可滚正文 · 可选脚注
   ```
2. **形态只看触摸能力，不看宽度**：`pointer: coarse` → 贴底、整宽、圆角顶 16px、`sheet-up` 动画、抓手、下滑关闭；`pointer: fine` → 居中浮窗、圆角 14px、无抓手。**tablet 的会话不再从左边出来**，和历史 / 命令面板一样贴底。
3. **关闭方式对四个浮层完全一致**：点遮罩、按 `Esc`、点 ✕、（触屏）下滑。
4. **浮层一律不挤布局**：`position: fixed`，`.main` 的 flex 列里不再出现设置横幅。终端几何不因浮层开关而变，PTY 不收 `SIGWINCH`（[ADR-0011](0011-read-first-layout.md) 的老约束，设置横幅是它唯一的漏网之鱼）。
5. **desktop（`≥ 1024px`）的会话侧栏仍是常驻的一栏**，不是浮层 —— 它是主栅格的一部分（`Ctrl+Shift+B` 折叠）。浮层化只作用于 phone / tablet 的抽屉形态。
6. **唯一的例外是 ⋯ 菜单**：它在 tablet / desktop 是锚在键行行尾上方的 280px 弹出菜单（[ADR-0015](0015-bottom-keyrow.md) ⑦）。菜单是「选一项然后开浮层」的跳板，不是浮层本身，这条不变。

## 代价与取舍

- **平板用户的肌肉记忆会变一次**：会话从左侧抽屉改为底部 sheet。换来的是「⋯ 里四项都从底部出来」这一条能记住的规则，且 744px 宽下贴底 sheet 的列表比 280px 的左抽屉更好点。左边缘手势本来也没实现，损失的只是位置。
- **命令面板在桌面从「顶部 12vh」改为居中**。顶部锚定是命令面板的传统，但它的高度是固定的（max-height 60vh，列表内部滚动），居中不会因条目数跳动；换一条统一规则更值。
- **多了一层组件**。四处的头部 / 遮罩 / 手势 / Esc 各写一遍才是真正的代价来源 —— `installSwipeDismiss` 已经被贴了三次。
- **设置从横幅变浮层后不能边看终端边调字号了**。但字号改动实时作用在 xterm 上，浮层遮住的是终端下半部分，改完点一下遮罩就看得见；横幅的做法是把终端整个顶上去，更差。

## 影响

- 文档：[layout-responsive.md](../../40-frontend/layout-responsive.md) 新增 §浮层；[session-ux.md](../../40-frontend/session-ux.md) tablet 一节改为底部 sheet；[input-modes.md](../../40-frontend/input-modes.md) §⋯ 菜单补一句「四项打开的是同一种浮层」；[e2e-scenarios.md](../../70-testing/e2e-scenarios.md) 新增 E2E-28。
- 前端：新增 `web/src/ui/drawer.tsx`；`web/src/ui/app.tsx`（设置改浮层、非 desktop 的会话改浮层、去掉 `sidebarRef` 上的手势挂载）、`web/src/commands/history.tsx` 与 `web/src/commands/palette.tsx`（改用 `Drawer`）、`web/src/ui/swipe.ts`（默认滚动区改 `.drawer-body`）、`web/src/style.css`（`.drawer-*` 一族；删 `.scrim`、`.sidebar` 的抽屉 / sheet 形态、`.palette-backdrop` / `.panel-backdrop` 的浮层壳）。
- testid 全部保留：`sidebar` / `scrim` / `settings` / `history-panel` / `close-history` / `palette` / `palette-list` / `renderer` / `privacy-note` / `theme-select` / `font-size`；新增 `drawer-close`（各浮层的 ✕，历史仍叫 `close-history`）。
- 不触及协议、重连、连接层、会话状态。
