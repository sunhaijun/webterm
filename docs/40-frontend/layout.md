# 布局

> 状态：Accepted。决策见 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md)（Termux 式界面）与 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)（输出链路）。
>
> 支持范围与各设备的目标见 [`../10-requirements/devices-and-layout.md`](../10-requirements/devices-and-layout.md)。这篇定义实现。

## 形态（AC-5.18）

整个界面只有两种**形态**，写在 `.app[data-form]` 上：

| 形态 | 设备 | 判据 |
|---|---|---|
| `compact` | 手机（竖屏、横屏都算） | `min(screen.width, screen.height) < 600` |
| `wide` | PC、Pad | 其余 |

- **判据是屏幕短边，不是视口。** 屏幕尺寸不随软键盘、旋转、地址栏、分屏变化，所以形态在一台设备上**永远不变**。按视口判定的话，弹键盘时连布局视口一起缩的浏览器（`resizes-content`）里，平板横屏一弹键盘就会翻成 `compact`，标签栏一消失一出现，终端就重排一次、PTY 就收一次 SIGWINCH。
- 手机短边最大约 440px，平板最小约 600px（iPad mini 744px），600 落在中间的空档里。
- 形态**只在页面加载时算一次**，之后不重算。窗口挪到另一块显示器这种极少见的情况，刷新一下即可；换来的是任何视口变化（软键盘、旋转、分屏，以及 Playwright 改视口时连带改 `screen`）都不可能让形态翻转。
- 两种形态**只有会话怎么切换不同**（[session-ux.md](session-ux.md)）。终端、附加键、文本输入页、手势完全一样。

与形态正交的是**触摸能力**，用 `matchMedia('(pointer: coarse)')` 判断。它决定 `wide` 上显示不显示附加键，以及触摸目标的尺寸（标签栏 40px、`+` 前的间隔 16px 等）。浮层的形态**不看**它，看形态（见 [§浮层](#浮层)）。

## 几何

```
compact（手机）                              wide（PC / Pad）
┌──────────────────────────────────┐        ┌ ● webterm ✕│○ api •│○ logs│ + ───── ● ⚙ ┐ 标签栏 36px（触屏 40px）
│                                  │        │                                          │
│               终端               │        │                  终端                    │
│                                  │        │                                          │
├────┬─────────────────────────────┤        ├────┬─────────────────────────────────────┤
│ [3]│ ESC  /   -  HOME  ↑  END PGUP│        │    │ ESC   /    -   HOME   ↑   END  PGUP  │ 附加键 2 × 40px
│ ✎  │ TAB CTRL ALT  ←   ↓   →  PGDN│        │ ✎  │ TAB  CTRL ALT   ←    ↓    →   PGDN  │（wide 上仅触屏）
└────┴─────────────────────────────┘        └────┴─────────────────────────────────────┘
```

`[3]` 是会话按钮：圆角方框里写着会话数（[session-ux.md](session-ux.md#compact手机会话按钮--底部抽屉)）。

`.app` 是一列网格：

| 行 | compact | wide |
|---|---|---|
| 标签栏 | 无 | 36px；`pointer: coarse` 时 40px |
| 终端 | 剩余全部 | 剩余全部 |
| 附加键 | 80px，恒有 | 80px，`pointer: coarse` 时才有 |

- **没有标题栏、没有状态栏。** 连接状态、提示、浮层全部**盖在终端上**，不占网格行（见 [§盖在终端上的东西](#盖在终端上的东西)）。
- 附加键区是一个 80px 的定高槽。键位页和文本输入页都在这个槽里，切换时高度不变，终端不重排（[input.md](input.md)）。左侧固定列 44px：`compact` 是会话按钮（上）与 ✎（下），`wide` 只有 ✎（跨两行）。
- **运行时会改终端几何的只有三件事**：可视视口变化（软键盘、旋转、窗口缩放）、改字号（[§终端尺寸](#终端尺寸ac-53)）、`pointer: coarse` 变化（给 Pad 接上或拔掉鼠标，附加键出现或消失）。切会话、开关浮层、改主题、断线重连都不改几何。

### 盖在终端上的东西

都用绝对定位或 `position: fixed`，不参与网格，开关时不改终端几何、不发 `resize`：

| 元素 | 位置 | 何时出现 |
|---|---|---|
| 连接横幅（`conn-text`） | 终端顶部，一行高 | 不在线时（[session-ux.md](session-ux.md)） |
| toast | 终端顶部居中 | 已恢复、错误 |
| 组字预览（`ime-preview`） | 终端光标处 | 终端直输组字期间 |
| 手机会话抽屉、设置、会话菜单 | 见 [§浮层](#浮层) | 打开时 |

### 安全区

`index.html` 用 `viewport-fit=cover` + `black-translucent`，PWA 全屏时内容延伸到刘海与 Home 指示条底下。四边的 `env(safe-area-inset-*)` **由 `.app` 的 padding 吃掉**（`box-sizing: border-box`，JS 写的高度就是整个可视视口，内容区自然变小）。

- 写成自定义属性 `--sa-top/right/bottom/left`：一是让 E2E 能在没有真刘海的 Chromium 里覆盖它们验证几何，二是软键盘弹起时 JS 把 `--sa-bottom` 置 0 —— 键盘已经盖住 Home 指示条，再留 34px 就是白白浪费。
- 盖在 `.app` 里的东西**不要再自己加一次** `env()`，否则双倍；`position: fixed` 的（浮层、toast）才自己加。

## 高度计算（AC-3.8）

**唯一真相来源是 `visualViewport.height`**，不是 `100vh`（iOS Safari 上 `100vh` 不随键盘变化）。

```
应用容器高度 = visualViewport.height
终端高度     = 容器高度 − safe-area 上下（键盘弹起时下边按 0 算）− 标签栏（wide）− 附加键（显示时）
```

顺序：`visualViewport` 变化 → 重算容器 → 布局稳定 → `ResizeObserver` 通知终端 → 重算行列（`fit()`，见 [§终端尺寸](#终端尺寸ac-53)）→ 发 `resize` 控制消息（100ms 防抖）。

**不要在 `visualViewport` 事件里直接调 `fit()`** —— 布局还没稳定，会算出错误的行列数。必须让 `ResizeObserver` 观察终端容器，由它触发。

附加键在网格的最后一行，容器高度跟着可视视口缩，所以软键盘弹起时附加键**自然贴在键盘上方**，终端收缩而不是被遮挡。

### 键盘弹起时的 `translateY` 补偿

iOS Safari（以及 Chrome ≥108 的 `resizes-visual`）弹键盘只缩【可视视口】、不缩布局视口，并把可视区**上推**（`visualViewport.offsetTop` > 0）去露出输入框；`.app` 要 `translateY(offsetTop)` 跟过去，否则整个应用留在布局顶部、被推出可视区。闸门只看两个数，参照必须是布局视口：

```
键盘弹起 := visualViewport.height < documentElement.clientHeight − 80
```

- **参照是 `documentElement.clientHeight`，不能是 `window.innerHeight`**：Safari 的 `innerHeight` 报的是可视视口高度（随捏合缩放、随键盘一起变矮），拿它当参照，iPhone 上键盘一弹闸门就永远关着 → 不补偿 → 一点输入，输入控件就没影了。`clientHeight` 在所有浏览器里都是布局视口高度。
- **闸门关着时不追 `offsetTop`**：地址栏滑入滑出（可视与布局同步变）、边缘回弹（`offsetTop` 变、高度不变）都不该动 `.app`，否则拖一下抖一会儿（反馈环）。
- 布局视口一起缩的浏览器（`resizes-content`）：两个高度同步变、`offsetTop` 为 0，闸门自然关着，`.app` 跟着 `visualViewport.height` 缩即可。
- 页面和容器都 `overscroll-behavior: none` 并禁止滚动，免得输入控件聚焦时 iOS 自己去滚页面。
- 触屏上会拿焦点的控件（文本输入页的 `textarea`、xterm 的隐藏 textarea）**字号 ≥ 16px**：iOS 对 <16px 的输入框会在聚焦时自动放大页面并左右平移，`translateY` 管不了横向。

## 终端尺寸（AC-5.3）

行列由 `term/terminal.ts` 自己算（[ADR-0033](../20-architecture/adr/0033-own-fit.md)，不用 `FitAddon`）：可用尺寸（父元素宽高 − `.xterm` 内边距，宽度再减滚动条）÷ 字符格尺寸，向下取整，最少 2 列 1 行。**字符格尺寸取 `dimensions.device.cell / dpr`**，不取 `css.cell`：后者是「整行宽取整 ÷ 当前列数」，随当前列数变，拿它去除，某些宽度上每次都在 N 和 N−1 之间翻（只改高度也会改列数，agent 就重发一次快照）。

- 字号默认 **14px**，两种形态一样。手机竖屏 14px 约 45 列，这是刻意的取舍：可读优先于宽输出。设置里可调 10–24px，存 `localStorage['webterm.fontSize']`，**只存一份、不按形态分**（形态在一台设备上不变，[ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md) §1）。
- 容器尺寸变了（`ResizeObserver`）→ `fit()` → 防抖发 `resize`。
- **改字号之后**：所有 xterm 实例一起换 → 对挂着的那个 `fit()` → **补一条 `resize`**。字符格变了而容器没变，`ResizeObserver` 不会响，容器尺寸去重也会把这次量算吞掉；漏发就是客户端和 PTY 的 cols/rows 分家。没挂着的实例在切过去时照常 `fit()`。
- **列数一变，agent 会重发一份快照**（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §4）：两边各自重排的结果不一致，以 agent 的为准。浏览器收到就 `reset` 后重画，回看位置回到底部。只改行数（软键盘）不会。

## 浮层

浮层有四个：手机上的会话抽屉、设置、关闭确认（[ADR-0038](../20-architecture/adr/0038-close-confirm-sheet.md)）、手机上的改名（[ADR-0039](../20-architecture/adr/0039-drawer-row-swipe-actions.md)）。它们共用 `Drawer` 原语（`web/src/ui/drawer.tsx`，[ADR-0018](../20-architecture/adr/0018-one-drawer-primitive.md)），**形态看 `compact` / `wide`**，不看 `pointer`（[ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md) §4）：

| | `compact`（手机） | `wide`（PC / Pad） |
|---|---|---|
| 位置 | 贴底、整宽 | 居中浮窗，宽 `min(420px, 100vw − 32px)` |
| 圆角 | 顶部 16px | 14px |
| 进场 | `sheet-up` 约 170ms（`prefers-reduced-motion` 下无） | 无 |
| 抓手 | 有（36×4） | 无 |
| 下滑关闭 | 有（内部滚动到顶再下拉，> 90px 松手即关） | — |
| 使用者 | 会话抽屉、设置、关闭确认、改名 | 设置、关闭确认 |

```
┌─────────────── ═══ ───────────────┐  抓手（仅 sheet）
│ 会话                            ✕ │  标题栏：标题 · 关闭
├───────────────────────────────────┤
│ …                                 │  正文：唯一的滚动区（.drawer-body）
│                                   │  会话抽屉：多出来的高度都给它
├───────────────────────────────────┤
│  ┌──────────────────────┐ ┌────┐  │  底部一行（可选）：上 12 · 左右 16
│  │      + 新会话        │ │ ⚙  │  │  按钮 48px 高、圆角 12、间隔 12
│  └──────────────────────┘ └────┘  │
│                                   │  下 max(16px, 安全区)
└───────────────────────────────────┘
```

- **跟着可视区走**（[ADR-0039](../20-architecture/adr/0039-drawer-row-swipe-actions.md) §3）：`.app` 设 `contain: layout`，成为 `position: fixed` 后代的包含块。`.app` 本来就跟着 `visualViewport`（高度 + 键盘弹起时的 `translateY`），所以遮罩盖住的就是可见区，sheet 的底边就是键盘的上沿。不这样的话，Android 弹键盘只缩可视视口，贴着布局视口底边的 sheet 整个在键盘后面。
- **高度**：按遮罩（可见区）的百分比算，不用 `vh`：最大 80%，随内容长。**会话抽屉最小 50%**（iOS sheet 的「中等」档）：会话少的时候不至于只剩一条，多出来的高度给列表，底部一行始终贴着 sheet 底部。设置的内容只有两行，不设最小高度。
- **底部留出呼吸空间**：底部一行的内边距是上 12px、左右 16px、下 `max(16px, var(--sa-bottom))`；没有底部一行的 sheet 在正文下面留同样的 `max(16px, var(--sa-bottom))`。`--sa-bottom` 是 `.app` 上的安全区变量，键盘弹起时被置 0（键盘盖住了 Home 指示条，不用再空一截）。按钮不贴边铺满，是 `--surface` 底色、`--line` 细边、圆角 12px 的块。
- **关闭方式**：点遮罩、`Esc`、✕、（sheet）下滑。会话抽屉另加两种：选中一个会话、系统返回键（[session-ux.md](session-ux.md)）。设置不接系统返回键（ADR-0037 §4）。
- **打开时焦点进浮层**（模态）：键盘与读屏用户不会被留在背后那一层，`Esc` 也才有确定的接收者。
- **可以叠**：关闭确认、改名能叠在会话抽屉上。`Esc` 只关最上面一层（DOM 里最后一个 `.drawer`），点遮罩也只点得到最上面那层。
- **浮层不改终端几何**：`position: fixed`，不发 `resize`。
- **`position: fixed` 的浮层自己吃底部安全区**（`.app` 的 padding 管不到它），见上面的底部留白。

## 设置（AC-5.3）

只有两项（[ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)）。改了立刻生效，没有「保存」，不写说明文字。

```
┌─────────────── ═══ ───────────────┐
│ 设置                            ✕ │
├───────────────────────────────────┤
│ 主题     ┌────────┬──────┬──────┐ │  分段按钮，选中的用强调色
│          │跟随系统│ 浅色 │ 深色 │ │
│          └────────┴──────┴──────┘ │
│ 终端字号          ( − )  14  ( + ) │  10–24，到头的那一侧变灰
│                                   │  下 max(16px, 安全区)
└───────────────────────────────────┘
```

| 元素 | testid | 说明 |
|---|---|---|
| 浮层 | `settings` | `compact` 是 sheet，`wide` 是居中浮窗 |
| 主题 | `theme-system` / `theme-light` / `theme-dark` | `role="radio"`，选中的 `aria-checked="true"` |
| 字号 | `font-dec` / `font-size` / `font-inc` | `font-size` 是当前值；到 10 / 24 时对应的按钮 `disabled` |

- 入口：`wide` 是标签栏最右的 ⚙，`compact` 是会话抽屉底部的 ⚙，testid 都是 `open-settings`。没有快捷键（`Ctrl+Shift+,` 交给终端）。
- 字号不用数字输入框：手机上一点就弹数字键盘。
- 关掉设置后：打开之前焦点在终端（或文本输入页）里的，或者是非触摸设备，焦点还回去；否则不动，免得触屏上弹出软键盘。

`wide` 的会话菜单（右键或长按标签弹出的「改名 · 保持接收 · 关闭」）不是浮层，是锚在触发点旁边的小菜单：点外面或 `Esc` 关闭。

## 主题

CSS 自定义属性 + `prefers-color-scheme`，三态：跟随系统（默认）/ 浅色 / 深色，在设置里选，存 `localStorage['webterm.theme']`（[ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)）。

```css
:root { /* 浅色为基准，全部颜色在此定义 */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* 覆盖 */ } }
:root[data-theme="dark"] { /* 同一份覆盖，让手动选择在两个方向都生效 */ }
:root[data-theme="light"] { color-scheme: light }   /* 滚动条、原生控件跟着走 */
:root[data-theme="dark"]  { color-scheme: dark }
```

- 选浅色 / 深色：`<html data-theme="light|dark">`；选跟随系统：去掉这个属性。
- **首次渲染之前就打上**（`main.tsx` 里，先于 `render`），配对页、闸门页也一样，没有先亮后暗的闪烁。
- xterm 的主题（前景 / 背景 / 16 色）从同一组 CSS 变量读取。改主题时、以及系统切换深浅色时（`matchMedia('(prefers-color-scheme: dark)')` 的 `change`）重新读一遍，更新所有实例的 `terminal.options.theme`，不用刷新。

强调色是 `--accent`（`:root` 上写成 `var(--link)`，跟着主题一起变）。**它专门用来表达「选中的是这个」**：当前标签、抽屉里的当前会话（AC-4.9）。中性灰（`--fg` 的低透明度混色）留给 hover：选中和 hover 必须靠**色相**分开，靠深浅分不开。CTRL / ALT 的激活与锁定态也用 `--accent`。

## 字体

**界面 chrome 用比例字体，终端与输入用等宽。** `body` 默认 `--font-ui`；文本输入页、附加键、抽屉里的 CWD 显式回到 `--font-mono`。xterm 自己用等宽（`term/terminal.ts`）。

```css
--font-ui:
  -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
  Arial, "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono:
  ui-monospace, "SF Mono", "Cascadia Mono", "Menlo", "Consolas",
  "Liberation Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace;
```

不打包 webfont（体积 + 首屏闪烁）。必须含中文等宽回退以保证 CJK 对齐。启用 xterm 的 `unicode11` addon 正确计算 CJK 与 emoji 宽度。

终端就用 `--font-mono` 这一串（`term/terminal.ts` 里有一份同样的字符串给 xterm），不可设置；字号默认 14px，见 [§终端尺寸](#终端尺寸ac-53)。

## 图标

界面上自己画的图标都是同一种画法（[ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md) §3）：**内联 SVG，只描边不填充，`stroke="currentColor"`，线宽 1.75px，端点与拐角都是圆的**，颜色跟着按钮走（平时 `--muted`，悬停 `--fg`）。用到的地方：标签栏与会话抽屉底部的 `+` 和 ⚙（六齿齿轮 + 中间圆孔），设置里字号的 `−` / `+`。不用 Unicode 符号当图标：`⚙` 之类在不同平台上字形不同，有的会渲染成彩色 emoji，上下位置也随字体度量变。

## 渲染（ADR-0026 §7）

**先用原生，量了再优化**（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §7）。浏览器只做三件事：

```
每个会话: 一个 TextDecoder('utf-8')（stream 模式）
OUTPUT 帧   → term.write(decoder.decode(payload, {stream: true}))
SNAPSHOT 帧 → decoder = new TextDecoder(); term.write('\x1bc' + decode(快照))   // RIS 在流内复位
```

- **用写入流里的 RIS（`ESC c`）复位，不要调 `term.reset()`**：`reset()` 是同步的，不清写缓冲。列数一变 agent 立刻重发快照，此时还没解析完的旧输出会被画到复位之后、快照之前。RIS 和快照一起进写缓冲，顺序天然正确（xterm 自己在 `reset()` 的注释里也建议这种场合用 RIS）。
- **先解码成字符串再写**。直接写 `Uint8Array` 时，xterm.js（5.5 与 6.0）会在某些切法下丢字：第 2 字节是 `0x80` 的三字节字符（`。` `…` `—` `“` `”` `、` 等）被切在第 2 字节之后时整个丢掉。PTY 的读边界是任意的，中文输出就会偶尔吞标点。
- **渲染器用 xterm 默认的 DOM 渲染器**，不挂 WebGL。
- **触屏滚动用 xterm 自带的**，不另写每帧落地与惯性。例外：前台程序开了鼠标跟踪时 xterm 不处理触摸，纵向拖由 webterm 转成滚轮交给程序（[input.md](input.md#纵向拖ac-321)，ADR-0029）。
- **不做回看暂停、不做按帧合并、不做写入预算。** xterm 自己的写缓冲按约 12ms 一片解析并让出主线程，渲染每帧至多一次。
- `scrollback: 5000`（AC-5.1）。刷新、重连太久、切回太久之后能翻多远，由 agent 的快照决定（2000 行，AC-5.14）。
- 选中文本时新输出不破坏选区（AC-5.4）：xterm 的选区按缓冲区坐标记，输出滚动不影响它。

这些「不做」都是有意的。将来要加回任何一项，得先用 E2E-37 的基线场景量出主线程长任务的差别（这台开发机没有 GPU，只看主线程毫秒数），带着数据写进 ADR。

## PWA

- `display: standalone`，`theme_color` 随主题切换。
- Service Worker **只缓存静态壳**（HTML/JS/CSS），策略 `stale-while-revalidate`；**绝不缓存任何终端数据或 API 响应**。
- 离线时展示"无法连接到 agent"的明确状态页，不假装能用。
- 新版本可用时提示"有更新 · 刷新"，不自动刷新（会打断正在进行的会话）。

## 无障碍

- 可点区域在 `pointer: coarse` 下最小 44×44px。**附加键是明确的例外**：行高 40px（参照 Termux 的 37.5dp），宽度 ≥ 48px 补足。
- 连接状态变化用 `aria-live="polite"` 播报；在线时 `conn-text` 只是视觉隐藏，读屏仍然读得到。
- 当前会话（标签、抽屉列表项）带 `aria-current="true"`。
- 支持系统 `prefers-reduced-motion`：关闭浮层的过渡动画与滚动惯性。
