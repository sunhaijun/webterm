# 响应式布局

> 状态：Accepted
>
> 支持范围与各档目标见 [`../10-requirements/devices-and-layout.md`](../10-requirements/devices-and-layout.md)。这篇定义实现。

## 断点

只依据视口宽度，**不做 UA 嗅探**。

```css
:root { --bp-tablet: 640px; --bp-desktop: 1024px; }
```

| 名字 | 条件 |
|---|---|
| `phone` | `< 640px` |
| `tablet` | `640px – 1023px` |
| `desktop` | `≥ 1024px` |
| `short` | `height < 480px`（叠加规则，主要针对手机横屏） |

触摸能力单独判断：`@media (pointer: coarse)` 决定**输入层**（ADR-0015）—— 触屏一律是键行 + 编辑面板，**包括 ≥ 1024px 的 iPad 横屏**；宽度只决定栅格（侧栏常驻还是抽屉）。`pointer: coarse` 还决定是否显示功能键、命中区尺寸（最小 44×44 px）。接了外接键盘的平板（`pointer: fine`）在 ≥ 1024px 走经典底栏。

## 三种布局

### desktop（`≥ 1024px`）

```
┌────────────╥──────────────────────────────────────┐
│ 侧栏 240px ║ 状态条 (会话名 · CWD · 连接状态)     │
│            ╟──────────────────────────────────────┤
│ 会话列表   ║                                       │
│  ● webterm ║           终端 (xterm)                │
│  ○ api     ║                                       │
│  ○ logs    ║                                       │
│            ╟──────────────────────────────────────┤
│ ─────────  ║ 快捷命令条（横滑）                    │
│ 快捷命令   ╟──────────────────────────────────────┤
│ 历史       ║ Composer                              │
│ 设置       ║                                       │
└────────────╨──────────────────────────────────────┘
             ↑ 分隔条：拖 = 改宽，点 = 收起/展开
```

#### 侧栏宽度可拖、可收起

侧栏是主栅格的第一列，宽度记在 `--sidebar-w` 上，右缘有一条**分隔条**（`.sidebar-resizer`，视觉 1px，命中区 11px；`pointer: coarse` 下 24px）：

| 操作 | 结果 |
|---|---|
| 拖 | 实时改宽。范围 `200px – min(480px, 窗口宽 × 40%)`；`pointer: coarse` 下最小值抬到 `260px`（会话项右侧三个图标各 44px，光按钮就吃掉 132px） |
| 点一下（没拖动就抬起） | 收起 / 展开。与写态 sheet 的抓手「点一下半屏 ⇄ 全屏」同构，不多一条约定 |
| `Ctrl+Shift+B` | 同上 |
| 聚焦后 `←` / `→` | 步进 16px；`Shift` 加持 64px；`Home` / `End` 到最小 / 最大 |
| 拖到离 240 只差 ≤ 12px | 吸附回默认宽 |
| 拖到小于最小宽的 60% | 松手即收起（同 sheet 的「拖到底收起」） |

**收起 = 宽度 0**，不是图标条 —— 终端拿满整屏，分隔条留在左缘当拉出把手（触屏下距屏幕左缘留 8px，避开 Safari / PWA 的边缘返回手势）。代价是收起时看不到其他会话的未读点，用状态条和 ⋯ 菜单兜底。

宽度与收起状态存 `localStorage['webterm.sidebar.w' / '.open']`，**只在 desktop 读**：`sidebarOpen` 在 phone / tablet 兼作浮层开关，不隔离的话手机一进来会自己弹出会话浮层。宽度在读取时与窗口尺寸变化时按上下限夹紧，只有用户拖动才写回。

**改侧栏宽度 = 改终端几何**，这是它和浮层（ADR-0018 §4）的根本区别，所以有两条硬约束：

- **拖动期间不 `fit()`**。`.app[data-sidebar-drag='true']` 时 `ResizeObserver` 的回调直接返回：布局跟着手指走，但不重算 cols/rows、不发 `resize`；松手清标志再补一次。否则拖 600ms 就是六七条 `resize`，vim / claude 每条都整屏重绘 —— 就是 `app.tsx` 里记着的那个「拖动抖动」。拖动过程中 xterm 画布被裁 / 留白是预期的，松手才重排。
- **收起 / 展开不加 CSS 过渡**。给 `grid-template-columns` 加 transition 会让 `ResizeObserver` 每帧都响，比拖动更糟。要动效只动侧栏内容的 `opacity`，不动列宽。

**触屏到了这个宽度（iPad mini 横屏 1133×744）**：侧栏照样常驻，但底栏不是上图的经典底栏，而是与手机相同的键行（`⌨ 编辑` · 键区 · `⋯`）/ 编辑面板；⋯ 是锚在键行右上方的 280px 弹出菜单。键盘弹出后高度 344px 落入 `short`，键行压到 40px、状态栏隐藏。

### tablet（`640–1023px`）

同 desktop 但侧栏不常驻：会话收进**底部浮层**（`Drawer`，与历史 / 设置同一个壳，见下面 §浮层 与 [ADR-0018](../20-architecture/adr/0018-one-drawer-primitive.md)），点状态条或 ⋯ → 会话打开，**打开时终端不重排**（`position: fixed` 覆盖在上层 + 半透明遮罩）。

不重排很重要 —— 否则每次开关抽屉都会触发 `resize`，终端内容重排，正在看的位置就跑了。

底栏与手机相同（键行 / 编辑面板）。两处平板专有的调整（ADR-0015）：⋯ 是锚在键行右上方的 280px 弹出菜单，不是整宽底部表单；编辑面板半屏上限 420px（744×1133 上 46% 是 521px，输入框用不了那么多）。提示符键集 12 个键在 744px 宽下全部免滚。

### phone（`< 640px`）—— 读态优先（ADR-0011）

手机默认进入**读视图**：主体是命令块流，不是终端网格。

```
┌──────────────────────────────────────┐
│ ● webterm  ~/github/webterm      ⋯  │ 28px 细条
├──────────────────────────────────────┤
│ ✓ git status -sb            118ms    │
│ ✗ npm test        exit 1     32s     │ ← 失败：红边、默认展开
│    …                                 │
│ ⟳ npm run build            运行中    │ ← 在跑：live-tail
│                                      │   块流（DOM，原生滚动，最新在下）
├──────────────────────────────────────┤
│ [⌨ 编辑] Tab ↑ ↓ ^C ^L | ~ / …  [⋯] │ 停在 prompt：一条键行（56px）—— 行首互切键 · 键区横滚 · 行尾 ⋯
│ [⌨ 编辑] claude Esc ^C Enter ⇧… [⋯] │ 命令在跑 / 占屏：只换键区内容，高度不变、不盖终端（ADR-0015）
└──────────────────────────────────────┘

读视图的画布有两种：默认是**块流**；前台是 claude / codex 时换成**转录视图**（对话卡片 + 终端尾巴，[ADR-0012](../20-architecture/adr/0012-ai-cli-conversation-first.md) γ，见 [`input-modes.md`](input-modes.md)）。两者都绝对铺满 `.canvas`，切换不动 xterm 尺寸。

碰输入框，底栏升起成写态 sheet（分片 ③）—— 盖在块流上，画布不动：

┌──────────────────────────────────────┐
│ ✓ git status -sb            118ms    │ 块流：上一个块仍在视野里
│ ⟳ npm run build            运行中    │
├───────────────── ═══ ────────────────┤ 抓手 16px：点一下半屏 ⇄ 全屏，拖到底收起
│ [★构建] [git status] [src/] [docs/]  │ chips：快捷命令 / 同目录历史 / 路径补全（为空不占高度）
│ ┌──────────────────────────────────┐ │
│ │ cd src/▍                         │ │ 输入框吃掉剩余高度（全屏时也填满）
│ └──────────────────────────────────┘ │
│ [✎ 终端] Esc ^C│Tab ↑ ↓ ← → … [发送] │ 键行 56px：行首互切键，命令在跑时多 Esc ^C，行尾发送（ADR-0015）
└──────────────────────────────────────┘
```

- **xterm 仍在，只是不可见**：`.term[data-hidden="true"]` 绝对定位铺满主区、`visibility: hidden`。它必须保持真实尺寸 —— `FitAddon` 据此算 cols/rows 发给 PTY，shell 按它折行。**不能 `display: none`**（尺寸归零，cols/rows 会算错）
- 点「终端」切到终端视图：xterm 铺满画布，底栏仍是那 56px 的槽（停在 prompt 一行输入 +「读」+ ⋯；命令在跑时键条独占，「读」与 ⋯ 是键条的前导键）—— **两种视图画布几何完全一致，切换不 resize**。点「读」切回。选择记在 `localStorage['webterm.view']`。桌面（`≥ 1024px`）两种视图都用经典底栏（模式条 + 输入框 + 快捷条 + 键条）
- **控（分片 ②）**：有程序占屏时自动切到终端视图，退出后自动回读。占屏 = 备用屏幕缓冲（vim / top / less），**或主屏就地重绘**（claude / codex 这类不切备用缓冲、靠光标寻址重画的 CLI —— 否则它们会停在读视图被 `plainText` 拍扁）。自动切换**不写偏好**；用户手动切过之后就不再自动回。键条按前台程序换内容（见 [input-modes.md](input-modes.md#上下文键条adr-0011-分片-②)）
- **写（分片 ③）**：底栏是三档 sheet（收起 / 半屏 / 全屏），绝对定位在 56px 定高的槽里往上长 —— 盖住块流、不挤画布，三档之间 xterm 尺寸不变、PTY 不收 SIGWINCH；块流按 `--sheet-inset` 让位。详见 [input-modes.md](input-modes.md#编辑面板-sheet-的档位adr-0015)
- **块动作（分片 ④）**：展开的块底部有 重跑 / 填入命令 / 复制输出 / 在终端里看。「在终端里看」切到终端视图并**滚到该块输出的第一行**、高亮 1.6s；「最大化」把块铺满整屏细看、可滚动，「恢复」回内联。**最新一条命令的块自动展开**（只留最新一条，失败的与手动展开的不被自动收起） —— client 在写入 xterm 时按 `out_seq` 把帧切开、切口处登记 marker（agent 保证 `command.*` 先于对应帧到达，见 [websocket-protocol.md](../30-protocol/websocket-protocol.md)）
- 没有 OSC 133 标记时（ssh 出去、集成不可用），最后一个块之后的输出作为一个**尾块** live-tail —— 降级就是块数变少，不是另一种界面
- **没有标题栏**。会话名、CWD、连接状态挤在 28px 细条里，点击展开会话切换 sheet
- **安全区**：`index.html` 用 `viewport-fit=cover` + `black-translucent`，PWA 全屏时内容延伸到刘海与 Home 指示条底下，所以四边的 `env(safe-area-inset-*)` 必须**由 `.app` 的 padding 吃掉**（`box-sizing: border-box`，JS 写的高度就是整个可视视口，内容区自然变小）。写成自定义属性 `--sa-top/right/bottom/left`：一是让 E2E 能在没有真刘海的 Chromium 里覆盖它们验证几何（E2E-10 ⑦），二是软键盘弹起时 JS 把 `--sa-bottom` 置 0 —— 键盘已经盖住 Home 指示条，再留 34px 就是白白浪费输入区。盖在 `.app` 里的东西（底部抽屉、⋯ 菜单、面板）**不要再自己加一次** `env()`，否则双倍；`position: fixed` 的（toast）才自己加

tablet（`640–1023px`）同样默认读视图；desktop 默认终端视图。

### short 叠加（`height < 480px`，手机横屏）

- 底栏键行压到 40px（键 32px），槽位 `--slot-h` 同步 40px，终端多拿 16px
- 快捷命令条隐藏（挤不下，改从 sheet 里访问）
- Composer 收起为单行；聚焦展开时**覆盖终端**而不是挤压它
- 会话细条隐藏，连接状态只用一个 8px 圆点（右上角）

---

## 浮层（ADR-0018）

会话、历史、设置是三个**次要界面**，共用一个 `Drawer` 原语（`web/src/ui/drawer.tsx`），形态只看触摸能力：（原本还有第四个「命令面板」，已随 [ADR-0021](../20-architecture/adr/0021-drop-command-palette.md) 删除）

| | `pointer: coarse`（手机 / 平板 / 触屏桌面宽） | `pointer: fine`（鼠标键盘） |
|---|---|---|
| 位置 | 贴底、整宽 | 居中浮窗 |
| 圆角 | 顶部 16px | 14px |
| 进场 | `sheet-up` 160–180ms（`prefers-reduced-motion` 下无） | 无 |
| 抓手 | 有（36×4） | 无 |
| 下滑关闭 | 有（内部滚动到顶再下拉，> 90px 松手即关） | — |

```
┌─────────────── ═══ ───────────────┐  抓手（仅触屏）
│ 会话                            ✕ │  标题栏：标题 · 可选工具 · 关闭
├───────────────────────────────────┤
│ ● webterm   ~/github/webterm      │  正文：唯一的滚动区（.drawer-body）
│ ○ api       ~/srv/api             │
│ ─────────────────────────────     │
│ + 新会话                          │
├───────────────────────────────────┤
│ Enter 填入 · Esc 关闭             │  脚注（可选）
└───────────────────────────────────┘
```

- **关闭方式三个浮层完全一致**：点遮罩、`Esc`、✕、（触屏）下滑
- **打开时焦点进浮层**（模态，焦点进 sheet 本体）：键盘与读屏用户不会被留在背后那一层，`Esc` 也才有确定的接收者 —— 触发它的 ⋯ 菜单项已经随菜单卸载了
- **浮层不挤布局**：`position: fixed`，不参与 `.main` 的 flex 列 —— 开关浮层不改终端几何、不发 `resize`
- **`position: fixed` 的浮层自己吃 `env(safe-area-inset-bottom)`**（`.app` 的 padding 管不到它，见 §安全区）
- **desktop 的会话侧栏不是浮层**：它是主栅格的一栏，常驻、宽度可拖、`Ctrl+Shift+B` 折叠（见上面 §desktop）。它改宽就改终端几何 —— 这正是浮层不做的事
- **⋯ 菜单不是浮层**：它是跳板，tablet / desktop 上锚在键行行尾（[ADR-0015](../20-architecture/adr/0015-bottom-keyrow.md) ⑦）

高度：默认 `max-height: 80vh`（触屏）/ `min(80vh, 720px)`（桌面）随内容长；历史这种列表型标 `data-size="wide"`，取 86vh / `min(76vh, 640px)` 的定高，免得条目一多一少就换尺寸。

## 高度计算

**唯一真相来源是 `visualViewport.height`**，不是 `100vh`（iOS Safari 上 `100vh` 不随键盘变化）。

```
应用容器高度 = visualViewport.height
终端高度     = 容器高度 - safe-area 上下 - 细条 - 横幅 - 底栏
               safe-area 由 .app 的 padding 承担（--sa-*），键盘弹起时下边按 0 算
               底栏：手机 / 平板恒为一个定高的槽（--slot-h：56px；short 40px）。
                     终端态的键行正好填满槽位、不盖终端；编辑面板往上长盖住终端、不挤画布（ADR-0015）；
                     桌面 = 快捷条 + 功能键条 + Composer（经典布局）
```

顺序：`visualViewport` 变化 → 重算容器 → 布局稳定 → `ResizeObserver` 通知终端 → `FitAddon.fit()` → 发 `resize` 控制消息（100ms 防抖）。

**键盘弹起时的 `translateY` 补偿只看两个数，参照必须是布局视口。** iOS Safari（以及 Chrome ≥108 的 `resizes-visual`）弹键盘只缩【可视视口】、不缩布局视口，并把可视区**上推**（`visualViewport.offsetTop` > 0）去露出输入框；`.app` 要 `translateY(offsetTop)` 跟过去，否则整个应用留在布局顶部、被推出可视区。闸门：

```
键盘弹起 := visualViewport.height < documentElement.clientHeight − 80
```

- **参照是 `documentElement.clientHeight`，不能是 `window.innerHeight`**：Safari 的 `innerHeight` 报的是可视视口高度（随捏合缩放、随键盘一起变矮），拿它当参照，iPhone 上键盘一弹闸门就永远关着 → 不补偿 → "一点输入，输入框就没影了"。`clientHeight` 在所有浏览器里都是布局视口高度。
- **闸门关着时不追 `offsetTop`**：地址栏滑入滑出（可视与布局同步变）、边缘回弹（`offsetTop` 变、高度不变）都不该动 `.app`，否则拖一下抖一会儿（反馈环）。
- 布局视口一起缩的浏览器（老 Android Chrome 的 `resizes-content`）：两个高度同步变、`offsetTop` 为 0，闸门自然关着，`.app` 跟着 `visualViewport.height` 缩即可。
- 触屏上会拿焦点的控件（Composer、xterm 的隐藏 textarea）字号 ≥ 16px：iOS 对 <16px 的输入框会在聚焦时自动放大页面并左右平移，`translateY` 管不了横向。

**不要在 `visualViewport` 事件里直接调 `fit()`** —— 布局还没稳定，会算出错误的行列数。必须让 `ResizeObserver` 观察终端容器，由它触发。

## 终端尺寸

`FitAddon` 根据容器像素尺寸和 cell 尺寸算 cols/rows。各档默认字号：

| 断点 | 默认字号 | 典型列数 |
|---|---|---|
| phone 竖屏 | 14px | 40–46 |
| phone 横屏 | 12px | 70–80 |
| tablet | 14px | 75–85 |
| desktop | 14px | 100+ |

**phone 竖屏刻意选择较大字号**（可读 > 兼容宽输出），见 [`../10-requirements/devices-and-layout.md`](../10-requirements/devices-and-layout.md)。用户可调，设置持久化到 `localStorage`（按断点分别记）。

## 主题

CSS 自定义属性 + `prefers-color-scheme`，支持三态：跟随系统 / 强制浅色 / 强制深色（存 `localStorage`）。

```css
:root { /* 浅色为基准，全部颜色在此定义 */ }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* 覆盖 */ } }
:root[data-theme="dark"] { /* 覆盖，让手动切换在两个方向都生效 */ }
```

xterm 的主题（前景/背景/16 色）从同一组 CSS 变量读取并在切换时更新 `terminal.options.theme`。

## 字体

**界面 chrome 用比例字体，命令 / 输出用等宽**（精致终端区分 chrome 与内容的做法）。`body` 默认 `--font-ui`；命令原文（`.block-cmd` / 历史 / 快捷命令）、命令输出（`.block-out`）、Composer 与直发输入行、CWD、chips 显式回到 `--font-mono`。xterm 自己用等宽（`term/terminal.ts`）。

```css
--font-ui:
  -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
  Arial, "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
--font-mono:
  ui-monospace, "SF Mono", "Cascadia Mono", "Menlo", "Consolas",
  "Liberation Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace;
```

不打包 webfont（体积 + 首屏闪烁）。必须含中文等宽回退以保证 CJK 对齐。启用 xterm 的 `unicode11` addon 正确计算 CJK 与 emoji 宽度。

## 渲染

- **只有当前可见的终端挂 `WebglAddon`**，切走时 `dispose()`。浏览器的 WebGL 上下文数有上限（Chrome 约 16 个，超了会静默丢弃最老的），而会话上限是 20 且切走的 xterm 实例不销毁（[`session-ux.md`](session-ux.md#会话在-client-侧的表示)）—— 全挂上必然撞线，症状是别的终端莫名变黑
- `webgl2` 上下文创建失败或 addon 抛异常时**静默回退**到默认 canvas renderer（AC-5.5）
- 监听 `webglcontextlost`，丢失时也回退，不要留一个黑屏
- `scrollback: 5000`（AC-5.1）
- 选中文本时暂停自动滚动（`terminal.onSelectionChange` → 有选区则不 `scrollToBottom`）（AC-5.4）

## PWA

- `display: standalone`，`theme_color` 随主题切换
- Service Worker **只缓存静态壳**（HTML/JS/CSS），策略 `stale-while-revalidate`
- **绝不缓存任何终端数据或 API 响应**
- 离线时展示"无法连接到 agent"的明确状态页，不假装能用
- 新版本可用时顶部提示"有更新 · 刷新"，不自动刷新（会打断正在进行的会话）

## 无障碍

- 所有可点区域最小 44×44 px（`pointer: coarse` 下）
- 状态变化用 `aria-live="polite"` 播报（连接断开/恢复）
- 支持系统 `prefers-reduced-motion`：关闭抽屉/sheet 的过渡动画
