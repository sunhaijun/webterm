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

与形态正交的是**触摸能力**，用 `matchMedia('(pointer: coarse)')` 判断。它只决定两件事：`wide` 上显示不显示附加键，以及浮层的形态（见 [§浮层](#浮层)）。

## 几何

```
compact（手机）                              wide（PC / Pad）
┌──────────────────────────────────┐        ┌ ● webterm ✕│○ api •│○ logs│ + ───── ● ⚙ ┐ 标签栏 36px（触屏 40px）
│                                  │        │                                          │
│               终端               │        │                  终端                    │
│                                  │        │                                          │
├────┬─────────────────────────────┤        ├────┬─────────────────────────────────────┤
│ ☰• │ ESC  /   -  HOME  ↑  END PGUP│        │    │ ESC   /    -   HOME   ↑   END  PGUP  │ 附加键 2 × 40px
│ ✎  │ TAB CTRL ALT  ←   ↓   →  PGDN│        │ ✎  │ TAB  CTRL ALT   ←    ↓    →   PGDN  │（wide 上仅触屏）
└────┴─────────────────────────────┘        └────┴─────────────────────────────────────┘
```

`.app` 是一列网格：

| 行 | compact | wide |
|---|---|---|
| 标签栏 | 无 | 36px；`pointer: coarse` 时 40px |
| 终端 | 剩余全部 | 剩余全部 |
| 附加键 | 80px，恒有 | 80px，`pointer: coarse` 时才有 |

- **没有标题栏、没有状态栏。** 连接状态、提示、浮层全部**盖在终端上**，不占网格行（见 [§盖在终端上的东西](#盖在终端上的东西)）。
- 附加键区是一个 80px 的定高槽。键位页和文本输入页都在这个槽里，切换时高度不变，终端不重排（[input.md](input.md)）。左侧固定列 44px：`compact` 是 ☰（上）与 ✎（下），`wide` 只有 ✎（跨两行）。
- **运行时会改终端几何的只有三件事**：可视视口变化（软键盘、旋转、窗口缩放）、改字号或字体、`pointer: coarse` 变化（给 Pad 接上或拔掉鼠标，附加键出现或消失）。切会话、开关浮层、断线重连都不改几何。

### 盖在终端上的东西

都用绝对定位或 `position: fixed`，不参与网格，开关时不改终端几何、不发 `resize`：

| 元素 | 位置 | 何时出现 |
|---|---|---|
| 连接横幅（`conn-text`） | 终端顶部，一行高 | 不在线时（[session-ux.md](session-ux.md)） |
| toast | 终端顶部居中 | 已恢复、错误 |
| 组字预览（`ime-preview`） | 终端光标处 | 终端直输组字期间 |
| 浮层（设置、手机会话抽屉）、会话菜单 | 见 [§浮层](#浮层) | 打开时 |

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

顺序：`visualViewport` 变化 → 重算容器 → 布局稳定 → `ResizeObserver` 通知终端 → `FitAddon.fit()` → 发 `resize` 控制消息（100ms 防抖）。

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

## 终端尺寸与字号（AC-5.3）

`FitAddon` 根据容器像素尺寸和 cell 尺寸算 cols/rows。

- 字号**按形态各存一份**：`localStorage['webterm.fontSize.compact' / '.wide']`，默认都是 14px，范围 8–32px。手机竖屏 14px 约 45 列，这是刻意的取舍：可读优先于宽输出。
- 在设置面板里改（`data-testid="font-size"`）。
- **改字号或字体之后**：所有 xterm 实例一起换 → 对挂着的那个 `fit()` → **补一条 `resize`**。cell 尺寸变了而容器没变，`ResizeObserver` 不会响，漏发就意味着客户端和 PTY 的 cols/rows 分家。
- **列数一变，agent 会重发一份快照**（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §4）：两边各自重排的结果不一致，以 agent 的为准。浏览器收到就 `reset` 后重画，回看位置回到底部。只改行数（软键盘）不会。

## 浮层

设置（两种形态）和手机上的会话抽屉共用一个 `Drawer` 原语（`web/src/ui/drawer.tsx`，[ADR-0018](../20-architecture/adr/0018-one-drawer-primitive.md)），形态只看触摸能力：

| | `pointer: coarse` | `pointer: fine` |
|---|---|---|
| 位置 | 贴底、整宽 | 居中浮窗 |
| 圆角 | 顶部 16px | 14px |
| 进场 | `sheet-up` 160–180ms（`prefers-reduced-motion` 下无） | 无 |
| 抓手 | 有（36×4） | 无 |
| 下滑关闭 | 有（内部滚动到顶再下拉，> 90px 松手即关） | — |

```
┌─────────────── ═══ ───────────────┐  抓手（仅触屏）
│ 设置                            ✕ │  标题栏：标题 · 可选工具 · 关闭
├───────────────────────────────────┤
│ …                                 │  正文：唯一的滚动区（.drawer-body）
├───────────────────────────────────┤
│ …                                 │  脚注（可选）
└───────────────────────────────────┘
```

- **关闭方式一致**：点遮罩、`Esc`、✕、（触屏）下滑。手机会话抽屉另加两种：选中一个会话、系统返回键（[session-ux.md](session-ux.md)）。
- **打开时焦点进浮层**（模态）：键盘与读屏用户不会被留在背后那一层，`Esc` 也才有确定的接收者。
- **浮层不改终端几何**：`position: fixed`，不发 `resize`。
- **`position: fixed` 的浮层自己吃 `env(safe-area-inset-bottom)`**（`.app` 的 padding 管不到它）。
- 高度 `max-height: 80vh`（触屏）/ `min(80vh, 720px)`（桌面），随内容长。

会话菜单（长按或右键会话弹出的「改名 · 保持接收 · 关闭」）不是浮层，是锚在触发点旁边的小菜单：点外面或 `Esc` 关闭。

## 主题

CSS 自定义属性 + `prefers-color-scheme`，支持三态：跟随系统 / 强制浅色 / 强制深色（存 `localStorage`）。

```css
:root { /* 浅色为基准，全部颜色在此定义 */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* 覆盖 */ } }
:root[data-theme="dark"] { /* 覆盖，让手动切换在两个方向都生效 */ }
```

xterm 的主题（前景 / 背景 / 16 色）从同一组 CSS 变量读取，并在切换时更新 `terminal.options.theme`。

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

### 终端字体可选（AC-5.13）

上面那串 `--font-mono` 是**没得选时**的默认。终端字体在设置里可换，规则见 [ADR-0023](../20-architecture/adr/0023-terminal-font-list.md)：**清单硬编码，本机装了才列**。

| 组 | 清单 |
|---|---|
| 系统默认 | 上面那串 `--font-mono`，永远在第一位、永远可选 |
| 编程字体 | JetBrains Mono · Fira Code · Iosevka · Hack · IBM Plex Mono · Source Code Pro · Cascadia Mono |
| 平台自带 | SF Mono · Menlo · Monaco（macOS）· Consolas（Windows）· Roboto Mono · DejaVu Sans Mono · Ubuntu Mono |
| 中英等宽 | Sarasa Mono SC · Noto Sans Mono CJK SC（汉字与西文严格 2:1，`tree` / 表格类输出对齐最稳） |

- **每一项都是一整段 stack，尾巴恒为 `"Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace`。** 编程字体基本不带汉字，少了这条尾巴汉字会掉进比例字体，中英混排的列宽当场歪掉。
- **探测**：canvas `measureText` 量同一段探针文本，把 `"X", <基线>` 和 `<基线>` 比宽度，三条基线（`monospace` / `serif` / `sans-serif`）里有一条不同就算装了。结果按页面缓存一次。拿不到 2d 上下文时清单退化成只有「系统默认」。
- **持久化**：`webterm.font.family`，存 id，**全局一份不按形态分**（字号才按形态分）。
- **改字体后**同改字号：所有实例一起换 → `fit()` → 补一条 `resize`。
- **连字（ligature）不生效**：xterm 的连字要额外加载 `addon-ligatures`，我们不加载。所以清单优先收不带连字的变体（Cascadia Mono 而非 Cascadia Code），带连字的字体也能选，只是显示成普通字形 —— 设置面板里明说这一条。
- 界面 chrome 的 `--font-ui` 不进这个设置。

## 渲染（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §7）

**先用原生，量了再优化。** 浏览器只做三件事：

```
每个会话: 一个 TextDecoder('utf-8')（stream 模式）
OUTPUT 帧   → term.write(decoder.decode(payload, {stream: true}))
SNAPSHOT 帧 → decoder = new TextDecoder(); term.write('\x1bc' + decode(快照))   // RIS 在流内复位
```

- **用写入流里的 RIS（`ESC c`）复位，不要调 `term.reset()`**：`reset()` 是同步的，不清写缓冲。列数一变 agent 立刻重发快照，此时还没解析完的旧输出会被画到复位之后、快照之前。RIS 和快照一起进写缓冲，顺序天然正确（xterm 自己在 `reset()` 的注释里也建议这种场合用 RIS）。
- **先解码成字符串再写**。直接写 `Uint8Array` 时，xterm.js（5.5 与 6.0）会在某些切法下丢字：第 2 字节是 `0x80` 的三字节字符（`。` `…` `—` `“` `”` `、` 等）被切在第 2 字节之后时整个丢掉。PTY 的读边界是任意的，中文输出就会偶尔吞标点。
- **渲染器用 xterm 默认的 DOM 渲染器**，不挂 WebGL。
- **触屏滚动用 xterm 自带的**，不另写每帧落地与惯性。
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
