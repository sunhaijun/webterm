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

### phone（`< 640px`）

```
┌──────────────────────────────────────┐
│ ● webterm  ~/github/webterm      ⋯  │ 28px 细条
├──────────────────────────────────────┤
│                                       │
│           终端 (xterm)                │
│                                       │
├──────────────────────────────────────┤
│ [重启服务][go test][docker ps] →     │ 快捷命令条 40px
├──────────────────────────────────────┤
│ Esc Tab Ctrl Alt ↑↓←→ | ~ / →        │ 功能键条 44px
├──────────────────────────────────────┤
│ Composer                          ↑  │ 自适应 40–40vh
└──────────────────────────────────────┘
    ↑ safe-area-inset-bottom
```

- **没有标题栏**。会话名、CWD、连接状态挤在 28px 细条里，点击展开会话切换 sheet
- 会话切换：底部上拉 sheet（卡片式，带最后 3 行输出预览 + 未读标记），或在终端区左右滑动
- `env(safe-area-inset-*)` 用于刘海与 Home 指示条

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
终端高度     = 容器高度 - 细条 - 快捷条 - 功能键条 - Composer - safe-area
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

- 优先 `WebglAddon`；`webgl2` 上下文创建失败或 addon 抛异常时**静默回退**到默认 canvas renderer（AC-5.5）
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
