# ADR-0025 Termux 式界面：全屏终端 + 两行附加键，会话按设备分两种切换

> **§3 的「回车做什么」「怎么发」被 [ADR-0027](0027-text-page-enter-submits.md) 修订**：有内容回车 = 发内容**并回车**（`term.paste()` 再键入 `\r`）。下文保留原决定作历史记录。

> **§5 手势表里「纵向拖」一行被 [ADR-0029](0029-touch-drag-to-wheel.md) 修订**：xterm 在程序开了鼠标跟踪时并不处理触摸拖动，改由 webterm 把纵向拖转成滚轮（手指每移动一行高一次）。

> **设置被 [ADR-0030](0030-no-settings.md) 整体删除**：§4 的 ☰ 换成显示会话数的会话按钮，抽屉底部和标签栏里的 ⚙ 删除；§5「m10 之前改字号走设置面板」改为 m10 之前字号固定 14px；§7 的 `Ctrl+Shift+,` 删除；§8「配置文件」一行改为不提供配置；§2 m9 的「键位可配」取消。

> **设置随 [ADR-0037](0037-settings-theme-and-font-size.md) 回来，只有主题与终端字号两项**：标签栏最右和会话抽屉底部重新有 ⚙（线条图标），`Ctrl+Shift+,` 仍不拦截。

> **§4 `wide` 标签栏的标签宽度被 [ADR-0031](0031-tabs-equal-width.md) 修订**：标签按可用宽度等分（120–240px），放不下时照旧横向滚动；鼠标滚轮在标签条上横着滚。

> **§4 `wide` 标签栏的 `+` 被 [ADR-0035](0035-tabbar-new-button-pinned.md) 移出滚动的标签条**：放不下时也常驻可见，前面留出不可点的间隔，画成与状态点对齐的图标。

> **§3 文本页被 [ADR-0036](0036-text-page-per-session.md) 改为跟着会话走**：每个会话各记自己停在哪一页、文本框里的草稿，切换会话时一起换；焦点落到新会话的输入处。

状态：已接受（2026-10-30）· **待落地**（四步，见[§分步](#分步)）

**取代**：

- [ADR-0007](0007-dual-mode-input.md)（双模输入）全部 —— 内部的 composer/raw 状态机也一起删，它在新界面里没有消费者；
- [ADR-0013](0013-terminal-only.md) §2–§5（输入条、占屏换键条、视觉缩放 + PTY 固定 43 列、移动端 chrome）。**§1「终端是唯一显示面」由本 ADR 继承**；
- [ADR-0014](0014-input-toggle.md)（互切键）、[ADR-0015](0015-bottom-keyrow.md)（底栏单行键行）全部；
- [ADR-0018](0018-one-drawer-primitive.md) 里的 ⋯ 菜单、历史浮层、平板上的会话浮层。**`Drawer` 原语本身保留**，继续给设置和手机上的会话列表用；
- [ADR-0021](0021-drag-preview-not-live-relayout.md) 的适用对象（桌面侧栏）。**它的原则「跟手只做预览，松手才改布局」由本 ADR 的捏合改字号继承**；
- [ADR-0008](0008-pinned-history-as-snippets.md)（快捷命令 = 置顶历史）全部。[ADR-0006](0006-agent-side-osc-parsing.md) / [ADR-0010](0010-bash-rcfile-injection.md)（shell 集成）由 [ADR-0026](0026-agent-holds-terminal-state.md) 整体取代，见 [§10](#10-随之变成死代码的后端与协议)。

**被 [ADR-0026](0026-agent-holds-terminal-state.md) 修订的地方**：输出链路（回看提示条、写入器、WebGL、自写触屏滚动、客户端快照）改为原生，shell 集成整体删除（§10），原第 1、2 步合成一个 PR（§分步）。下文已按修订后的结论改写。

**不变**：续传与字节级连续性（AC-2.1 ★）、[ADR-0020](0020-input-never-silently-dropped.md)（输入不静默丢弃，含回放门、组字兜底、`inputStats`）、[ADR-0023](0023-terminal-font-list.md)（终端字体清单）、[ADR-0024](0024-scrollback-layered-model.md) §1（把 claude 拉回主屏）。协议的改动全部来自 [ADR-0026](0026-agent-holds-terminal-state.md)。

## 背景

### 老界面是八轮迭代叠出来的

从 ADR-0007 到 ADR-0022，输入区和会话入口改了八轮。每一轮都有实测依据，但叠在一起，用户要学的概念是这些：

| 概念 | 出处 |
|---|---|
| 互切键（终端输入 ⇄ 编辑面板） | ADR-0014 |
| 编辑面板三档（收起 / 半屏 / 全屏）、抓手、chips（同目录历史 / 路径补全 / 快捷命令）、编辑键行、长按发送 = 不回车 | ADR-0011 ③、ADR-0015 |
| 按「谁在占屏」换内容的键区：提示符键集、通用键集，less / top / vim / nano / AI / 通用 TUI 各一套 | ADR-0011 ②、ADR-0015 |
| 内部 composer/raw 模式（用户看不见，只驱动键区） | ADR-0007 |
| ⋯ 操作面板 → 会话 / 历史 / 设置三个浮层 | ADR-0013 §5、ADR-0018 |
| phone / tablet / desktop / short 四档布局；桌面侧栏拖宽、吸附、收起 | layout-responsive.md、ADR-0021 |
| 横滑切会话、双指视觉缩放、双击放大、PTY 固定 43 列 | AC-4.7、ADR-0013 §4 |

这些概念最后都汇到 `web/src/ui/app.tsx`，它有 1271 行。前端共 7761 行，其中约 4.5k 行是这一层 UI。

### Termux 为什么好用

用户点名要 Termux 的体验：「简洁且方便」。拆开看，Termux 的概念少，而且几乎全是静态的：

- 一块全屏终端，没有标题栏，没有状态栏；
- 两行固定的附加键（`ESC / - HOME ↑ END PGUP` / `TAB CTRL ALT ← ↓ → PGDN`），不随前台程序变，按了几次就记住位置；
- 会话在一个抽屉里，点一下就切；
- 双指捏合就是改字号，长按就是选文字；
- 中文这类需要输入法的长文本，把附加键行左滑出一个原生输入框来打。

「方便」主要来自**位置固定、行为可预期**。老界面按上下文变来变去的键区和面板，恰恰与此相反。

### 浏览器与 Termux 的差别

Termux 是原生 App，有些事网页做不到，有些事 webterm 在这之前已经有更稳的决定，逐条见 [§8](#8-不照抄-termux-的地方)。

## 决定

### 1. 一块终端，两种设备形态

终端铺满可用区域，没有标题栏和状态栏。设备分两种**形态**，写在 `.app[data-form]` 上：

| 形态 | 设备 | 判据 |
|---|---|---|
| `compact` | 手机（含横屏） | `min(screen.width, screen.height) < 600` |
| `wide` | PC、Pad | 其余 |

**判据用屏幕短边，不用视口宽度。** 理由有三条：

- 用户的划分本来就是按设备（「手机上…」「PC 或 Pad 上…」），不是按窗口宽度；
- 屏幕尺寸不随软键盘、旋转、地址栏变化。形态在使用过程中**永远不会翻转**，就不会因为形态切换去重排终端、给 PTY 发 SIGWINCH。视口判据做不到这一点：弹键盘时连布局视口一起缩的浏览器（`resizes-content` 行为）里，平板横屏一弹键盘高度就掉到 480 以下，形态会来回翻；
- 手机短边最大约 440px，平板最小约 600px（iPad mini 是 744px），中间留了足够的间隔。

这条判据取代 phone / tablet / desktop / short 四档断点，也取代「断点只依据视口宽度」那条规则。屏幕尺寸不是 UA 嗅探，「不做 UA 嗅探」这一条仍然成立。

两种形态**只有会话怎么切换不同**（§4）。终端、附加键、文本输入页、手势完全一样。

```
compact（手机）                          wide（PC / Pad）
┌──────────────────────────────┐        ┌ ● webterm ✕│○ api •│○ logs│ + ──── ● ⚙ ┐ 标签栏
│                              │        │                                         │
│            终端              │        │                 终端                    │
│                              │        │                                         │
├────┬─────────────────────────┤        ├────┬────────────────────────────────────┤
│ ☰• │ ESC  /   -  HOME ↑ END PGUP│      │    │ ESC   /    -   HOME   ↑   END  PGUP │ 附加键
│ ✎  │ TAB CTRL ALT ←   ↓  →  PGDN│      │ ✎  │ TAB  CTRL ALT   ←    ↓    →   PGDN │（仅触屏）
└────┴─────────────────────────┘        └────┴────────────────────────────────────┘
```

### 2. 附加键：两行，静态，用 Termux 的默认键位

- **什么时候显示**：`compact`，或者 `pointer: coarse`。也就是手机永远显示，触屏 Pad 显示，鼠标键盘设备不显示。
- **默认键位就是 Termux 的默认键位**，共 14 个键：
  ```
  ESC  /    -    HOME  ↑  END  PGUP
  TAB  CTRL ALT  ←     ↓  →    PGDN
  ```
- **静态**：键位不随前台程序、提示符状态、shell 集成状态变。老界面里的提示符键集、通用键集和六套程序键全部删除。退出 less 的 `q`、vim 的 `:wq` 由软键盘输入，附加键负责软键盘上没有的那几个键。
- **几何**：两行，每行 40px，共 80px，同一行的键等宽，不横向滚动。左侧有一列 44px 宽的固定列：`compact` 上是 ☰（上）和 ✎（下），触屏 `wide` 上只有 ✎（跨两行）。393px 宽时每个键约 50px 宽。40px 的行高低于「命中区 44×44」的要求，这里算作明确的例外：参照 Termux 的 37.5dp，宽度上已经补足。
- **不抢焦点**：所有键在 `pointerdown` 时 `preventDefault`，按附加键不会让软键盘收起或弹出。
- **编码与实体键盘一致**：字节映射见 [`keymap.md`](../../40-frontend/keymap.md)。方向键、`HOME`、`END` 要跟随应用光标键模式（DECCKM，`term.modes.applicationCursorKeysMode`），开着时发 `ESC O A` 而不是 `ESC [ A`。
- **CTRL / ALT 粘滞**：点一下，只对下一个键生效；长按，锁定；再点一下，解除。软键盘打出来的下一个键也算。激活与锁定状态必须看得出来。
- **m9再加的**：
  - 上划副键：在键上往上划，发它的副键。默认 `-` 上划是 `|`，`/` 上划是 `~`，这两个是老界面实测下来软键盘最缺的。
  - 长按连发：`↑ ↓ ← → PGUP PGDN` 长按 400ms 后，每 60ms 发一次。
  - 键位可配：设置里用 Termux 的 `extra-keys` 语法编辑，存在 `localStorage['webterm.extraKeys']`。解析失败时退回默认键位，并显示错误信息，不静默。

### 3. 文本输入页：取代 Composer

附加键区有两页，**键位页**和**文本页**，高度相同（80px），所以切换时终端几何不变。

- **怎么切换**：点 ✎（这是可见入口），或者在键区上左右滑动（这只是加速路径，不是唯一入口）。
- **文本页**：一个两行高的 `textarea`，占满键区（左侧固定列除外）。
  - 字号 ≥ 16px，避免 iOS 聚焦时放大页面；
  - `enterkeyhint="send"`；
  - `autocorrect` / `autocapitalize` / `spellcheck` 必须用 `setAttribute` 关掉（原因见 input-modes.md：Chrome 把 `autocorrect` 当布尔属性，写在 JSX 里会被反射成 `on`）。
- **回车做什么**（照 Termux）：
  - 正在组字（`isComposing`）：不做任何事；
  - 有内容：把内容发出去，**不追加回车**；
  - 没有内容：发一个 `\r`；
  - 回车**永远不在文本框里插入换行**。

  这样在 claude 里可以先把一段中文送进它的输入框，在那边改完，再空按一次回车提交。老界面的「长按发送 = 不回车」这条隐藏手势随之消失。
- **怎么发**：内容里没有换行，就等同于逐字键入，走与按键相同的 `onData` 路径：`inputStats` 照常计数，回放门照常按事件判定（ADR-0020）。内容里有换行（只可能来自粘贴），走 `term.paste()`，括号粘贴由 xterm 按对端模式包裹。
- 发完后清空文本框，**留在文本页并保持焦点**，可以接着发下一段。
- 鼠标键盘设备没有附加键，也就没有文本页。实体键盘上的输入法直接进终端，靠 `RawIme` 的组字处理和直接插入处理（AC-3.3 / AC-3.14），这两条照旧保留。

随 Composer 一起删除的：chips、`↑ ↓` 翻历史、路径补全、编辑键行、多行编辑、半屏 / 全屏档位。

### 4. 会话切换

**`compact`（手机）：☰ → 底部抽屉**

- ☰ 在附加键左列的上格。任一非当前会话有未读（`head_seq > out_seq`）时，☰ 上显示一个小红点。
- 点 ☰ 打开 `Drawer`：贴底、整宽，形态沿用 [ADR-0018](0018-one-drawer-primitive.md)。抽屉里从上到下是：
  - 会话列表：编号固定，形如 `[1] webterm  ~/github/webterm`，带未读点，已退出的会话变灰；
  - 底部固定一行：「+ 新会话 · ⚙ 设置」。
- 长按一条会话，弹出会话菜单：「改名 · 保持接收 · 关闭」。「保持接收」就是现有的 pin 订阅（切走也继续收输出，见 session-ux.md），老界面里它是列表行上的 ⇵ 图标。
- 关闭抽屉：点遮罩、选中一个会话、按 `Esc`、系统返回键。下滑也能关，只作加速。
- **软键盘**：打开抽屉时焦点进抽屉，键盘收起，让抽屉拿到完整高度。选中会话后，如果**打开抽屉之前**焦点在终端里，就在这次点击的处理函数里聚焦新会话的终端，键盘重新弹出（iOS 只允许在用户手势里弹键盘）。这是 ADR-0020「焦点跟着会话走」在抽屉上的具体做法。
- **系统返回键**：打开抽屉时 `history.pushState` 一条记录，`popstate` 时关闭抽屉。用别的方式关闭抽屉时，调用 `history.back()` 把那条记录消掉，不让记录越积越多。否则在 Android 的 PWA 里，按返回键会直接退出应用。
- `Ctrl+Shift+B`：打开或关闭抽屉。

**`wide`（PC / Pad）：顶部标签栏**（参照 Termius）

- 高 36px，触屏 40px。从左到右：会话标签、`+`、空白、连接状态点、⚙。
- 一个标签显示会话名和未读点；开着「保持接收」的会话名前有一个小标记。已退出的会话变灰。
- 关闭标签用 ✕：鼠标设备上，悬停或当前标签显示；触屏上只有当前标签显示，免得误点。鼠标中键点标签也能关闭。
- 右键（鼠标）或长按（触屏）标签，弹出与手机上相同的会话菜单：「改名 · 保持接收 · 关闭」。双击标签直接进入改名，这是鼠标上的快捷方式。改名时标签原地变成输入框，`Enter` 确认，`Esc` 取消。
- 标签按创建顺序排列，不支持拖动排序。超出宽度时横向滚动，当前标签变化时把它滚进视野，不用平滑滚动。
- 切换标签不改终端几何。标签栏常驻，只在页面加载时决定有没有。

**两种形态共有的规则**

- 选中态用强调色，hover 用中性灰，两者靠色相区分，并带 `aria-current="true"`。这是把 AC-4.9 从「侧栏 / 抽屉 / sheet」改写为「标签 / 列表项」。
- 关闭会话的语义不变，`Ctrl+Shift+W` 的确认规则见 keymap.md。

### 5. 终端上的手势（触屏）

| 手势 | 行为 | 里程碑 |
|---|---|---|
| 点一下 | 程序开了鼠标跟踪：交给 xterm，由浏览器把触摸合成为鼠标事件，按程序要的协议上报点击。没开：切换软键盘（终端有焦点就 `blur`，没有就 `focus`） | m8 |
| 纵向拖 | xterm 自带的触摸滚动（主屏滚 scrollback）。备用屏程序开了鼠标跟踪时由 xterm 按它的规则上报，没开就不动。自写的每帧落一次与惯性删除（[ADR-0026](0026-agent-holds-terminal-state.md) §7），量过实际效果再说 | m8 |
| 横向拖 | **不做任何事**。横滑切会话（AC-4.7）删除 | m8 |
| 双指捏合 | **改字号**，会真的重排，见下 | m10 |
| 长按 | 选中手指下的词，见下 | m10 |

**捏合改字号**（取代视觉缩放和 PTY 固定 43 列）：

- 捏合过程中只给 `.xterm-screen` 写 CSS `transform: scale()` 作为预览，不 `fit()`，不发 `resize`。这是继承 ADR-0021 的「跟手只做预览」。
- 松手后，新字号 = `clamp(round(起始字号 × 缩放比), 8, 32)`。所有 xterm 实例一起改 `fontSize`，对当前挂着的那个 `fit()`，然后**补发一条 `resize`**：cell 尺寸变了而容器没变，`ResizeObserver` 不会触发（AC-5.3 那条规则不变）。
- 字号按形态分别保存：`webterm.fontSize.compact` / `webterm.fontSize.wide`。默认都是 14px。
- 去掉双击放大。在m10之前，改字号走设置面板里的字号控件。

**长按选区**：

- 长按 ≥ 500ms 且移动 < 10px，选中手指下的词（`term.select`），两端出现拖拽手柄，上方出现一条浮条：「复制 · 粘贴 · 更多…」。「更多」里有：
  - **选择链接**：列出可视区内的 http(s) 链接，点一个在新标签页打开；
  - **分享**：选区有内容就分享选区，没有就分享当前屏幕的文本。用 Web Share API，不支持时退回复制；
  - **保持亮屏**：Wake Lock 开关。页面隐藏时浏览器会自动释放，回到前台时如果开关还开着就重新申请。
- 点选区以外的地方退出选区。新输出到达时选区不被破坏（AC-5.4）。
- 粘贴用 `navigator.clipboard.readText()` 读出来，再 `term.paste()`。

鼠标键盘设备的选择、复制、粘贴保持 xterm 和浏览器的默认行为，本 ADR 不涉及。

### 6. 状态与提示

- **连接状态**：
  - `compact` 平时什么都不显示。不在线时，在终端顶部盖一条细横幅，写状态和重试倒计时。横幅是绝对定位、盖在终端上的，不改终端几何：网络抖动时不该让 PTY 收到 SIGWINCH；
  - `wide` 在标签栏右侧常驻一个状态点，不在线时同样出那条横幅；
  - `conn-text` 元素一直在 DOM 里，在线时只是视觉隐藏，保留 `aria-live`。这样读屏能播报，E2E 的引用也不用改。
- **保留**：「已恢复 · 补齐 N KB」toast（AC-2.10）；「历史输出已截断」改成 toast（AC-2.6）；组字预览 `ime-preview`；`fatal` 错误改成横幅。
- **会话结束**（取代 `ExitedBar`）：shell 退出后，在终端末尾写一行本地文字：`[进程已结束（退出码 N）· 按 Enter 关闭]`。
  - 直接 `term.write()`：xterm 的写入先进先出，自然排在最后一段输出之后；
  - 它**不计入 seq**，是纯本地的一次写入；
  - 在这个会话里按 `Enter`（终端里的按键，或文本页的空回车）就关闭会话；
  - 不提供「重开」，新会话从 ☰ 或 `+` 建；
  - 这行不在 agent 的模拟器里（它是浏览器本地写的），所以刷新或重连拿到快照之后，按会话状态再写一次，始终只有一行。
- **删除**：28px 状态细条、`degraded`（集成未生效）横幅、`unmarked`（当前 shell 没有集成）横幅。它们说明的是 composer/raw 自动切换和命令块能不能用，这两样已经没有了。
- **响铃**（m10）：`navigator.vibrate(50)`。只在 Android 上有效，iOS 不支持，什么也不做。

### 7. 快捷键

`Ctrl+Shift+*` 的约定不变（keymap.md 的设计约束表）：

- `Ctrl+Shift+Enter` 新建，`Ctrl+Shift+W` 关闭，`Ctrl+Shift+↑/↓` 上一个 / 下一个，`Ctrl+Shift+,` 设置，都保留；
- `Ctrl+Shift+B` 在 `compact` 上开关会话抽屉，在 `wide` 上不做任何事（侧栏已经没有了）；
- 删除：Composer 的键位（`Enter` / `Shift+Enter` / `↑↓` 翻历史 / `Esc` 清空 / `Tab` 插空格），侧栏分隔条的方向键调宽；
- **删除 `Ctrl/Cmd+F` 会话内搜索**（AC-5.2）。它从来没有实现过：`keymap.ts` 返回 `'search'` 动作，但前端没有任何地方处理它，`SearchAddon` 加载了却没人调用。Termux 也没有搜索。`SearchAddon` 和 `'search'` 动作一起删，`Ctrl/Cmd+F` 不再拦截，交还给浏览器或终端。

### 8. 不照抄 Termux 的地方

| Termux 的做法 | webterm 的做法 | 理由 |
|---|---|---|
| 备用屏里纵向滑动发 `↑` / `↓` | 开了鼠标跟踪才转成滚轮，否则不动 | ADR-0024 §4 已明令禁止：在 claude 里会翻出输入历史，在 vim 里会移动光标；在 tmux 里滚轮会把 pane 推进 copy-mode，而用户的 claude / codex 正是跑在 tmux 里 |
| `Ctrl+Alt+*` 快捷键 | `Ctrl+Shift+*` | Windows 和欧洲键盘上 `Ctrl+Alt` 等于 AltGr，会吃掉输入的字符 |
| 从左缘划出抽屉 | ☰ 按钮 | Android 手势导航下左缘是系统返回，网页拦不住（原生 App 能申请手势豁免区，网页不能）。用户的要求：入口要「简洁可靠」 |
| 左滑是文本输入页的唯一入口 | ✎ 按钮，滑动只作加速 | 同上，主入口要看得见 |
| 音量键当 Ctrl | 不做 | 浏览器拿不到音量键，附加键里有 CTRL |
| 「重置终端」 | 不做 | 本地 `term.reset()` 会和 agent 侧记录的粘性模式（ADR-0019）对不上；终端乱了在 shell 里敲 `reset` |
| `~/.termux/termux.properties` 配置文件 | 设置面板 + `localStorage` | 配置属于这台浏览器，不属于服务器 |

### 9. 前端：清除与重构

**原则**：

- 不留兼容层，不留开关，不保留「仅存历史」的文档段落，不注释掉旧代码；
- testid 只在语义完全相同时沿用：`conn-text` `terminal` `new-session` `ime-preview` `settings` `font-size` `font-family` `theme-select`；
- 新组件只做装配，逻辑放进可单测的纯模块。老 `app.tsx` 积成 1271 行，就是因为没守住这一条。

**删除**：

| 文件 | 原用途 |
|---|---|
| `input/composer.tsx` `input/sheet.tsx` `input/chips.ts` `input/complete.ts` `input/history.ts` | 编辑面板及其补全和历史 |
| `input/modes.ts` | composer/raw 状态机 |
| `input/keybar.tsx` | 上下文键行 |
| `commands/api.ts` `commands/history.tsx` | 历史面板、快捷命令条 |
| `ui/sidebar.ts` `ui/sessionlist.tsx` `ui/reveal.ts` | 桌面侧栏、会话列表、选中项滚进视野 |
| `ui/status.tsx` | 状态细条 |
| `term/pinch.ts` `term/hswipe.ts` | 视觉缩放、横滑切会话、手势仲裁 |
| `term/interactive.ts` | 占屏检测，只用来换键区内容 |
| `ui/app.tsx` `style.css` | 整体重写 |
| `keymap.ts` 里的 `PROMPT_KEYS`、各程序键集、`programOf`、`EDIT_INSERT`、Composer 键位、`'search'` 动作 | — |
| `term/terminal.ts` 里的 `SearchAddon` | 没有调用方的搜索 |

对应的单测：`commands` `complete` `composer` `history` `hswipe` `interactive` `keymap-ai` `modes` `pinch` `reveal` `sidebar` `submit`。

**保留**：

- `conn/*`、`protocol/*`；
- `sessions/store.ts`（去掉 `modes` 和 `interactive` 两个字段）；
- `term/terminal.ts`、`userinput.ts`（`outputqueue.ts`、`budgetwriter.ts`、`inertia.ts`、WebGL 挂载按 [ADR-0026](0026-agent-holds-terminal-state.md) §7 删除）；
- `input/raw.ts`、`input/inputstats.ts`、`keymap.ts` 里的字节映射和应用快捷键；
- `ui/drawer.tsx`、`ui/swipe.ts`、`ui/pair.tsx`、`ui/gate.tsx`、`ui/paircode.ts`、`ui/fonts.ts`；
- `ui/settings.ts`（字号改成按形态保存）、`ui/viewport.ts`（断点改成形态判定）。

**目标结构**：

```
web/src/
  main.tsx
  app/      app.tsx（装配：形态、会话、连接）· form.ts（形态判定）· tabs.tsx（wide）
            · sessions.tsx（compact 抽屉内容）· notices.tsx（连接横幅 / toast / 进程结束）· settings.tsx
  keys/     extrakeys.tsx（键位页 + 文本页）· keymap.ts · raw.ts · inputstats.ts
  term/     terminal · userinput · gestures.ts（点按；m10加捏合 / 长按）· selection.ts（m10）
  ui/       drawer · swipe · pair · gate · paircode · fonts · viewport · prefs.ts（原 settings.ts）
  conn/  protocol/  sessions/
```

`input/` 里剩下的几个文件挪进 `keys/`。现在的 `ui/` 里混着入口装配和通用组件，拆成 `app/` 和 `ui/` 两个目录。

**E2E**：

| 处理 | spec |
|---|---|
| 删除 | `sheet` `inputmodel` `swipe` `sidebar` `tablet` `pinch` `control` `escape` `commands` `integration` |
| 按新设计重写 | `drawer`（手机会话抽屉）、`mobile`（compact 几何与附加键）、`keyboard`（软键盘几何）、`sessionactive`（标签和列表的选中态）、`sessions`、`sessionmgmt`、`reading` |
| 只改脚手架 | `basic` `continuity` `ime` `input` `inputalive` `liveness` `pairdigits` `redraw` `reexec` `replay-echo` `scrollperf` `security` `subscribe-reset` `zombie` |

脚手架：现在有 33 处通过 `composer` 敲命令，统一改成一个往终端里敲的辅助函数。

### 10. 随之变成死代码的后端与协议

界面改完之后，命令历史、路径补全、提示符状态在前端都没有消费者了。[ADR-0026](0026-agent-holds-terminal-state.md) §6 把这一层**整体**删掉：shell 集成（rcfile、OSC 133 / 1701 / 7 解析）、命令历史全套（`commands` 表、`/api/commands*`、`/api/fs`、`/api/settings`、`--no-history`）、相关的协议消息与会话字段。工作目录改为每秒读一次 `/proc/<前台进程组>/cwd`。和本 ADR 在同一个 PR 里落地。

### 11. 文档怎么处理

- **ADR 是决策日志，不删**。被取代的 ADR 在标题下加一条横幅，指向本 ADR。
- **`docs/40-frontend/` 整体重写**，只描述当前设计：
  - `layout-responsive.md` → `layout.md`（形态、几何、软键盘、渲染）；
  - `input-modes.md` → `input.md`（附加键、文本页、IME 兜底、输入路径排障）；
  - `keymap.md`、`session-ux.md` 原地重写；
  - `commands-ux.md` 删除。
- **需求、验收标准、E2E 场景**：作废的条目**直接删掉**，不划线保留，编号**不复用**。被删编号的清单只记在本 ADR 的[§影响](#影响)里，可追溯性放在这一处。
- `docs/90-roadmap/milestones.md` 加上下面四步。

## 分步

| 步 | 分支 | 内容 | 出口 |
|---|---|---|---|
| m8 | `feat/40-termux-shell` | 本 ADR 与 [ADR-0026](0026-agent-holds-terminal-state.md) 一起落地：文档重写；§9 前端清除；新骨架（§1 形态、§2 静态附加键（不含上划和连发）、§3 文本页、§4 两种会话切换、§5 点按、§6（不含响铃）、§7）；输出链路重建与后端清理（ADR-0026）；E2E 脚手架改造 | `go test ./...`、`npm test`、`npm run e2e` 全绿；字节级连续性（增量）与屏幕级一致性（快照）都过；`TestHandoffByteLevelContinuity` 过 |
| m9 | `feat/40-termux-keys` | §2 的上划副键、长按连发、键位可配 | 同上 |
| m10 | `feat/40-termux-gestures` | §5 捏合改字号、长按选区与菜单；§6 响铃 | 同上；真机手势进手工清单 |

用户要求**一个 PR 全搞定**：界面、输出链路、后端死代码一起改。界面和输出链路的问题因此不能靠 PR 边界归因，改由两边各自的可观测性来区分（输入 `inputStats()`、输出按段计数，见 [ADR-0026](0026-agent-holds-terminal-state.md)）。

## 代价与取舍

- **两行附加键占 80px**，老界面单行是 56px，手机上终端少约一行半。换来的是 14 个键全部可见、位置不变、不用横滑。
- **失去上下文键**：less 的 `q`、vim 的 `:wq`、top 的 `k` 都要用软键盘打。
- **失去 claude 的固定 43 列**：改字号会重排，claude 会收到 SIGWINCH 并整屏重画。Termux 也是这样。
- **点终端会切换软键盘**：键盘弹着的时候点终端，键盘会收起。这是 Termux 的肌肉记忆，接受。
- **失去命令历史**：跨设备的历史、快捷命令、同目录历史都没有了。shell 自己的 `↑` 和 `Ctrl+R` 还在。这是「彻底清除」的直接代价，用户知情。
- **形态按屏幕尺寸定**：桌面浏览器窗口拖得很窄，仍然是标签栏；iPad 分屏到 320px 宽，也是标签栏，标签横向滚动。两种情况都能用，接受。
- **鼠标键盘设备上没有文本页**：实体键盘上的输入法直接进终端（RawIme），长段中文的编辑体验不如老 Composer。将来真有需要，再给 `wide` 加一个快捷键打开文本页。

## 影响

### 删除的验收标准与 E2E 场景（编号不复用）

- **删除**：
  - AC：AC-3.1、3.2（Composer，由 AC-3.19 取代）、3.5、3.7、3.9、3.12、3.13，讲键行不盖终端的那条 AC-3.14，AC-4.7、5.2、5.12，AC-6.4、6.6、6.7、6.11（历史与快捷命令的界面），以及文档里早已划线作废的 AC-3.6、旧 3.12–3.16、5.6–5.8、6.8；
  - E2E：E2E-8、9、13、14、19、24、25、29、32，以及早已作废的 11b、12b、20、23。
- **同一个 PR 里由 [ADR-0026](0026-agent-holds-terminal-state.md) 删除**：AC-6 余下的条目、AC-7.1–7.7，以及输出链路相关的 AC-2.7、2.16–2.19、5.5、5.9、5.10、5.15–5.17。
- **原地改写，编号保留**（讲的还是同一件事）：
  - AC：AC-2.10（连接指示）、AC-3.3 / 3.4 / 3.14 的措辞（「Raw 模式」改为「终端直输」）、AC-3.8（软键盘）、AC-4.5（会话结束）、AC-4.8（焦点跟着会话走）、AC-4.9（选中态：标签 / 列表项）、AC-5.3（字号按形态保存）、AC-5.11（浮层：设置与手机会话抽屉）、AC-6.5 / 6.9（去掉 E2E-14）、AC-7.6（去掉界面降级提示）；
  - E2E：E2E-5、6、7（去掉 Composer 段）、10、11、12（去掉搜索）、21、28、34、35。

### 新增的验收标准与 E2E 场景

| 编号 | 内容 | E2E |
|---|---|---|
| AC-5.18 | **形态**：`.app[data-form]` 由屏幕短边决定。弹出软键盘、旋转屏幕都不改变它，也不发 `resize` | E2E-39 |
| AC-3.18 | **附加键**：`compact` 或 `pointer: coarse` 时显示，默认 14 键与上图逐个一致，且不随前台程序变；393px 宽下不横向滚动；方向键在 DECCKM 开启时发 `ESC O A`；按键不改变焦点 | E2E-10 |
| AC-3.19 | **文本输入页**：✎ 和左右滑动都能切换，切换时终端行列数不变；有内容回车 = 发内容不回车；空回车 = 发 `\r`；组字期间回车不发送；含换行的内容走括号粘贴；发送计入 `inputStats` | E2E-40 |
| AC-3.20 | **点按终端**：开了鼠标跟踪时上报点击；没开时切换软键盘（焦点进出终端） | E2E-10 |
| AC-4.10 | **会话切换两种形态**：`compact` 上 ☰ 显示未读点，抽屉的关闭方式包括系统返回键，选中会话后焦点按「打开前在不在终端」恢复；`wide` 上标签栏可以切换、关闭、改名、新建，切换不改终端几何 | E2E-28、E2E-41 |

会话结束（AC-4.5）和连接横幅（AC-2.10）在原编号上改写。捏合改字号、长按选区（m10）和附加键增强（m9）的验收标准在各自的分支里加。

### 代码落点

见 [§9](#9-前端清除与重构) 和 [§10](#10-随之变成死代码的后端与协议)。
