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

触摸能力单独判断：`@media (pointer: coarse)` 决定是否显示功能键条、命中区尺寸（最小 44×44 px）。

## 三种布局

### desktop（`≥ 1024px`）

```
┌────────────┬──────────────────────────────────────┐
│ 侧栏 240px │ 状态条 (会话名 · CWD · 连接状态)     │
│            ├──────────────────────────────────────┤
│ 会话列表   │                                       │
│  ● webterm │           终端 (xterm)                │
│  ○ api     │                                       │
│  ○ logs    │                                       │
│            ├──────────────────────────────────────┤
│ ─────────  │ 快捷命令条（横滑）                    │
│ 快捷命令   ├──────────────────────────────────────┤
│ 历史       │ Composer                              │
│ 设置       │                                       │
└────────────┴──────────────────────────────────────┘
```

侧栏可折叠（`Ctrl+Shift+B`），折叠后只留 48px 图标条。

### tablet（`640–1023px`）

同 desktop 但侧栏改为**覆盖式抽屉**：从左边缘手势拉出或点按钮打开，**打开时终端不重排**（覆盖在上层 + 半透明遮罩）。

不重排很重要 —— 否则每次开关抽屉都会触发 `resize`，终端内容重排，正在看的位置就跑了。

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
│ ( 输入命令…            ) [终端] [⋯] │ 停在 prompt：一行输入 +「终端」+ ⋯ 菜单（56px）
│ 直发 ▸ ___________________  [终端]   │ 命令在跑：直发输入行，功能键条挂在它下面
└──────────────────────────────────────┘

碰输入框，底栏升起成写态 sheet（分片 ③）—— 盖在块流上，画布不动：

┌──────────────────────────────────────┐
│ ✓ git status -sb            118ms    │ 块流：上一个块仍在视野里
│ ⟳ npm run build            运行中    │
├────────────── ═══ ──────────── 收起 ─┤ 把手：点一下半屏 ⇄ 全屏，拖到底收起
│ [★构建] [git status] [src/] [docs/]  │ chips：快捷命令 / 同目录历史 / 路径补全
│ ┌──────────────────────────────────┐ │
│ │ cd src/▍                         │ │ 输入框吃掉剩余高度
│ └──────────────────────────────────┘ │
│ Tab ↑ ↓ ← → ⌫词 | ~ / - _ → [发送]  │ 编辑键条 44px
└──────────────────────────────────────┘
```

- **xterm 仍在，只是不可见**：`.term[data-hidden="true"]` 绝对定位铺满主区、`visibility: hidden`。它必须保持真实尺寸 —— `FitAddon` 据此算 cols/rows 发给 PTY，shell 按它折行。**不能 `display: none`**（尺寸归零，cols/rows 会算错）
- 点「终端」切到终端视图：xterm 铺满画布，底栏仍是那 56px 的槽（停在 prompt 一行输入 +「读」+ ⋯；命令在跑时键条独占，「读」与 ⋯ 是键条的前导键）—— **两种视图画布几何完全一致，切换不 resize**。点「读」切回。选择记在 `localStorage['webterm.view']`。桌面（`≥ 1024px`）两种视图都用经典底栏（模式条 + 输入框 + 快捷条 + 键条）
- **控（分片 ②）**：程序切到备用屏幕缓冲（vim / top / less）时自动切到终端视图，退出后自动回读。自动切换**不写偏好**；用户手动切过之后就不再自动回。键条按前台程序换内容（见 [input-modes.md](input-modes.md#上下文键条adr-0011-分片-②)）
- **写（分片 ③）**：底栏是三档 sheet（收起 / 半屏 / 全屏），绝对定位在 56px 定高的槽里往上长 —— 盖住块流、不挤画布，三档之间 xterm 尺寸不变、PTY 不收 SIGWINCH；块流按 `--sheet-inset` 让位。详见 [input-modes.md](input-modes.md#写态-sheet-的三档)
- **块动作（分片 ④）**：展开的块底部有 重跑 / 填入命令 / 复制输出 / 在终端里看。「在终端里看」切到终端视图并**滚到该块输出的第一行**、高亮 1.6s —— client 在写入 xterm 时按 `out_seq` 把帧切开、切口处登记 marker（agent 保证 `command.*` 先于对应帧到达，见 [websocket-protocol.md](../30-protocol/websocket-protocol.md)）
- 没有 OSC 133 标记时（ssh 出去、集成不可用），最后一个块之后的输出作为一个**尾块** live-tail —— 降级就是块数变少，不是另一种界面
- **没有标题栏**。会话名、CWD、连接状态挤在 28px 细条里，点击展开会话切换 sheet
- `env(safe-area-inset-*)` 用于刘海与 Home 指示条

tablet（`640–1023px`）同样默认读视图；desktop 默认终端视图。

### short 叠加（`height < 480px`，手机横屏）

- 功能键条压到 32px，单行
- 快捷命令条隐藏（挤不下，改从 sheet 里访问）
- Composer 收起为单行；聚焦展开时**覆盖终端**而不是挤压它
- 会话细条隐藏，连接状态只用一个 8px 圆点（右上角）

---

## 高度计算

**唯一真相来源是 `visualViewport.height`**，不是 `100vh`（iOS Safari 上 `100vh` 不随键盘变化）。

```
应用容器高度 = visualViewport.height
终端高度     = 容器高度 - 细条 - 横幅 - 底栏 - safe-area
               底栏：手机 / 平板恒为 56px 的槽（sheet、键条都往上盖，不挤画布）；
                     桌面 = 快捷条 + 功能键条 + Composer（经典布局）
```

顺序：`visualViewport` 变化 → 重算容器 → 布局稳定 → `ResizeObserver` 通知终端 → `FitAddon.fit()` → 发 `resize` 控制消息（100ms 防抖）。

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

```css
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
