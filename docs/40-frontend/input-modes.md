# 输入模式

> 状态：Accepted。决策背景见 [ADR-0007](../20-architecture/adr/0007-dual-mode-input.md)（模式状态机）、
> [ADR-0013](../20-architecture/adr/0013-terminal-only.md)（终端唯一显示面）、
> [ADR-0014](../20-architecture/adr/0014-input-toggle.md)（底栏互切键）、
> [ADR-0015](../20-architecture/adr/0015-bottom-keyrow.md)（底栏单行键行）。

## 用户看到的：底栏键行与互切键（ADR-0014 / ADR-0015）

底栏永远只有**一条键行**（56px；`short` 布局 40px），结构固定：**行首互切键 · 上下文标签 · 横向滚动的键区 · 行尾固定键**。第一个键在【终端输入】⇄【编辑面板】之间切，**默认终端输入**：

- **终端输入**：终端铺满，点终端逐键直送 PTY。键行 = `⌨ 编辑` · 键区 · `⋯`。键区按「谁在占屏」换内容：停在提示符给提示符键集（`Tab ↑ ↓ ^C ^L | ~ / - _ ← →`），命令在跑给通用键集，占屏按前台程序换（见下）。**键行正好填满槽位，不盖终端**。
- **编辑面板**：升起 Composer（同目录历史 / 路径补全 / 多行），整段编辑后一次发送。头部只有 16px 抓手（拖动 / 点一下半屏 ⇄ 全屏），底部键行 = `✎ 终端` · （命令在跑时）`Esc ^C` · 编辑键 · `发送`。没有「收起」：拖到底、空输入再按 Esc、`✎ 终端` 都回终端输入。
- **全屏 TUI（vim/top/less）**强制终端输入，键区换成该程序的退出 / 导航键；互切键仍在行首。

下面的「两个模式」「状态机」讲的是**内部** composer/raw 信号 —— 它只驱动功能键条的出现，跟上面这个用户可见的互切键是两条正交的轴。

## 两个模式（内部信号）

| | Composer | Raw |
|---|---|---|
| 终端区 | 只读（可滚动、可选中、可搜索） | 接收焦点，按键直通 |
| 输入元素 | 可见的多行 `textarea` | 屏幕外的隐藏 `textarea`（承载 IME） |
| IME | 完全原生，候选框位置正确 | composition 期间不写入，`compositionend` 一次性提交 |
| 提交 | `Enter` 提交 / `Shift+Enter` 换行 | 每个按键立即发送 |
| 适用 | 停在 shell prompt 时 | 有命令在跑时 |

---

## 状态机

```
状态 = { mode: "composer" | "raw" }
```

模式**全自动**，跟着 shell 集成上报的 `prompt` 状态走，**没有手动开关**
（ADR-0013：输入按触摸位置判定直送 / 编辑，模式只决定底栏形态 —— 提示符给
输入框，命令在跑给功能键条）。

### 转移表

| 当前 | 事件 | 结果 |
|---|---|---|
| 任意 | `prompt{state:"input"}` | `mode=composer` |
| 任意 | `prompt{state:"running"}` | `mode=raw`（**经去抖**，见下） |
| 任意 | `prompt{state:"done"}` | `mode=composer` |
| 任意 | `integration` 变为 `inactive` | `mode=composer`，自动切换禁用，显示降级提示 |
| 任意 | 重连后收到 `welcome` | 按 `sessions[].prompt_state` 重新对齐 |

### 重连之后必须重新对齐

`prompt` 消息只在状态变化时发一次，客户端离线期间的那些就丢了。断线如果
恰好跨过一个命令边界，客户端手里还是断线前的状态 —— 命令早跑完了它却以为
还在跑，于是停在 Raw、提交语义变成"发给程序"，**用户敲的下一条命令会被粘进上一条的 stdin**，要等下一条命令
才自愈。

所以收到 `welcome` 时要用 `sessions[].prompt_state` 重算一次（集成不可用、
没有数据源时不动，维持当前 Composer）。

### `running` 的去抖

命令瞬间结束（`ls`、`echo`）会产生 `running` → `done` 只隔几毫秒的序列。如果直接切换，界面会闪一下 Raw 再回来，很难看。

**规则**：收到 `prompt{state:"running"}` 后延迟 **120ms** 再切到 Raw。若在延迟期内收到 `done`，取消切换。

去抖只对 `running` 生效 —— 切回 Composer 必须立即，否则用户输入会被拖慢。

### 状态是每会话的

模式状态跟随会话，不是全局的。切换会话时加载目标会话的模式状态，并重置到 Composer（上一个会话的状态不该跨会话生效）。

---

## Composer 实现要点

### DOM 结构

```html
<textarea
  class="composer"
  rows="1"                      <!-- 自适应高度，上限 40vh -->
  autocorrect="off"
  autocapitalize="off"
  spellcheck="false"
  enterkeyhint="send"           <!-- 移动端软键盘显示"发送" -->
></textarea>
```

`autocorrect` / `autocapitalize` / `spellcheck` 必须关掉（AC-3.10）—— 否则移动端会把 `cd` 自动大写成 `Cd`、把 `ls` 改成 `is`。

> **必须用 `setAttribute` 设，不能只写在 JSX 里。** Chrome 把 `autocorrect` 实现成了 **boolean** IDL 属性，框架看到同名属性存在就会去赋属性 —— 而 `"off"` 是个真值，反射出来的 attribute 变成 `autocorrect="on"`，正好是反的。E2E 里断言的是 attribute 的实际值，别只看源码里写了什么。

### 键位

| 键 | 行为 |
|---|---|
| `Enter` | 提交 |
| `Shift+Enter` | 插入换行 |
| `Ctrl/Cmd+Enter` | 提交（备用，兼容习惯） |
| `↑` / `↓` | 光标在**首行行首 / 末行行尾**时翻历史，否则正常移动光标 |
| `Esc` | 清空当前输入（内容非空）/ 切到 Raw 并聚焦终端（内容为空） |
| `Tab` | v0.1：插入两个空格。补全留给 v0.2 |

**`Enter` 在 IME 组字期间不能提交**：必须检查 `event.isComposing`，为 `true` 时直接 return。这是中文输入的关键一点 —— 否则按 Enter 选词就会误提交。

### 提交格式（AC-3.2）

| 内容 | 发送 |
|---|---|
| 含换行 | `ESC[200~` + 内容 + `ESC[201~` + `CR` |
| 单行 | 内容 + `CR` |
| 空 / 只有空白 | `CR` |

- **为什么多行要包 bracketed paste**：否则会被 shell 逐行当成独立命令执行（US-3.6）。包上之后 readline 把它当成一整块待编辑的输入。
- **为什么单行不包**：`ESC[200~` 只有在对端开着 bracketed paste 时才会被吞掉。集成失效被强制 Composer 时（AC-3.7），对端可能是 `cat`、python REPL 或 bash < 4.4 —— 那两串会作为字面量进入命令行。单行提交本来就不需要它，不包就没有这个风险。多行提交在这些环境下仍会降级，属于已接受的窄边缘。
- **为什么末尾是 `CR` 而不是 `LF`**：PTY 的行规程期望 `CR`（回车键的真实字节）

### 历史导航

`↑` 从最近往旧走，`↓` 反向。规则：

- 从当前输入进入历史时，暂存当前输入（走到底再按 `↓` 能回到它）
- 有输入内容时按 `↑` 做**前缀匹配**（只翻以当前内容开头的历史），空输入时翻全部
- 历史来源是 agent 的 `commands` 表（不是浏览器 localStorage）—— 跨设备一致

### 高度自适应

`rows` 随内容增长，上限 `40vh`。超出后内部滚动。高度变化会改变终端可视区 → 触发 `resize`（100ms 防抖）。

---

## Raw 实现要点

### IME 处理

隐藏 `textarea` 放在屏幕外（不能用 `display:none`，否则拿不到 composition 事件）。

```
compositionstart  → 置 composing=true，开始在光标位置渲染内联预览浮层
compositionupdate → 更新浮层内容（不发送任何字节）
compositionend    → composing=false，隐藏浮层，把 event.data 一次性发送
```

**`keydown` 处理器必须在 `composing === true` 时全部 return**（AC-3.3）。这是 Raw 模式下中文能用的唯一关键点。

**`composing` 必须有兜底复位**（AC-3.3 / [ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)）。上面那张表里 `composing` 只有一个出口 —— `compositionend`。可它不保证来：切输入法、切窗口、候选框被系统吞掉，都可能让组字就这么停在半路。而 `composing` 卡在 true 的后果是**这个会话的终端输入永久失效**（`keydown` 全部 return），用户没有任何线索，只能刷新页面。两条兜底：

| 兜底 | 为什么它成立 |
|---|---|
| `blur` | 元素都不是焦点了，组字不可能还在进行 |
| 捕获阶段的 `keydown`，`isComposing === false` 且 `keyCode !== 229` | 浏览器自己说了这不是组字中的按键 |

`keydown` 那条**必须挂在捕获阶段**：`RawIme` 是在 `term.open()` 之后构造的，冒泡阶段的监听排在 xterm 自己的 `keydown` 后面，等它跑完这一下按键已经被当成"组字中"丢掉了。复位要发生在 xterm 处理这个键**之前**。

`blur` 复位不提交任何文本：`blur` 时拿不到组字内容（那是 `compositionend` 才带的 `data`）。如果浏览器随后仍然补发了 `compositionend`，它照常提交，不会丢字。

内联预览浮层：绝对定位到 xterm 的当前光标屏幕坐标（`terminal.buffer.active.cursorX/cursorY` × cell 尺寸），显示未提交的组字内容 + 下划线。让用户知道自己在打什么。

### 直接插入的文本（AC-3.14）

组字只是一半。另一半是**软键盘不经过组字、直接插进来的字符** —— iOS 中文键盘的全角标点就走这条路。**这条路 xterm 5.5 接不住**，两头都不接：

| xterm 的路 | 它的条件 | iOS 全角标点为什么落空 |
|---|---|---|
| `keydown` 直接取字 | `keyCode >= 48 && key.length === 1` | iOS 对这类直接插入报 **`keyCode` 0** |
| `input` 事件兜底 | `!composed \|\| !_keyDownSeen` | keydown 已经发生过（`_keyDownSeen` 为真），整个 `input` 事件被忽略 |
| `keyCode === 229` 的 textarea 差量 | 只在 `keyCode` 恰好是 229 时 | 不是 229 就不走这条 |

于是「逗号进不去、句号能进」这种现象就出现了 —— 同一个键盘上，一个键报 `keyCode` 0（两头都不接，字丢掉），另一个键报 229（走差量路，能进）。

**做法：非组字的 `insertText` 由 `RawIme` 自己接管**：在 `beforeinput` 上发送并 `preventDefault`。`preventDefault` 让字符**不落进 textarea**，于是 xterm 的 `input` 路径与 229 差量路径都不会再发一遍 —— 不重复，也不依赖它的启发式。

三个不碰：
- **组字中**（`isComposing`）不碰，那是 `compositionend` 的活；
- `inputType` 不是 `insertText` 的不碰（`insertCompositionText` / 删除 / 替换各有各的路）；
- xterm 在 `keydown` 里处理掉的键会 `preventDefault`，**根本不会有 `beforeinput`**，所以普通按键完全不受影响。

两个去重：
- `compositionend` 之后的极短窗口里，同内容的 `insertText` 吃掉不再发（WebKit 会在组字提交后补发一次）；
- `keypress` 刚发过同一个字符时吃掉不再发（xterm 的 `_keyPress` 已经送过了）。

### 按键映射

见 [`keymap.md`](keymap.md)。要点：

- 使用 xterm.js 的 `onData` 拿到已经映射好的字节（它处理了绝大多数控制键）
- `attachCustomKeyEventHandler` 拦截应用级快捷键（`Ctrl+Shift+*`、`Ctrl/Cmd+K`），让它们不进 PTY
- 粘贴（`onPaste`）也用 bracketed paste 包裹

### 回放门只吞自动应答（AC-2.15 / ADR-0020）

`onData` 上有两种东西，必须分开：

| 来源 | 什么时候发生 | 该不该进 PTY |
|---|---|---|
| xterm 对历史查询（DSR / DA / `CSI ?u`）的**自动应答** | 同步发生在 `term.write()` 的解析里 | 回放期间**不该** —— 那不是用户输入，送进去就是给 claude / codex 喂乱码 |
| 用户的按键 / 粘贴 | 同步发生在一次 DOM 输入事件的派发里 | **永远该** |

所以判据是**谁产生的**，不是**什么时候**。按"会话此刻是否在回放"一刀切，就会把用户正在敲的字一起吞掉，而回放窗口在 `ring_bytes` 满载时是**秒级**的（1 MiB 的 reset 回放，xterm 按 12ms 分片让出主线程）。

做法（`web/src/term/userinput.ts`）：问浏览器**此刻正在派发哪个事件** —— `window.event`。它在派发期间指向当前事件，派发一结束就恢复，不需要自己挂监听器、也就没有窗口关不掉的问题：

```
onData(data):
  window.event?.type ∈ 用户输入事件表  → 放行（哪怕在回放）
  否则 replayDepth > 0                  → 丢弃（自动应答）
  否则                                  → 放行
```

用户输入事件表：`keydown` `keypress` `beforeinput` `input` `paste` `compositionend` `compositionupdate` —— 即 xterm 会在其中同步 `triggerDataEvent` 的那几个。

**不自己开时间窗**：xterm 对它处理掉的按键 `preventDefault + stopPropagation`，冒泡阶段根本收不到，窗口只能靠定时器关，而定时器任务与网络任务之间没有顺序保证 —— 中间插进来的一次解析就会把自动应答放出去。

顺带覆盖两个容易漏的情形：xterm 在用户刚输入过之后会**同步**解析下一次 `write()`（`_didUserInput` 优化），那次 write 发起自 WebSocket 的 `message` 事件，`type` 不在表里，照样拦住；`setTimeout` 驱动的分片解析没有正在派发的事件，也拦住。

新增一种能产生 `onData` 的用户交互（例如鼠标跟踪）时，想让它在回放期间也放行就把对应事件加进这张表；不加也只是回到"回放期间丢弃"的旧行为，不会更糟。

---

## 移动端功能键条（AC-3.9）

### 键行结构（ADR-0015）

```
[⌨ 编辑] less  q 退出  / 搜索  n  N  ␣ 翻页  b 上页 …  [⋯]
 行首      标签  ← 键区：横向滚动 ──────────────→   行尾
```

`.keybar` 本身不滚动：行首 `leading`（互切键）与行尾 `trailing`（`⋯`）固定，中间 `.keybar-scroll` 装上下文标签与键，独立横滚。整行高度 = 槽位高度（`--slot-h`：56px，`short` 40px），键 44px（`short` 32px）。

### 按键集合

| 状态 | 键区 |
|---|---|
| 停在提示符 | `Tab ↑ ↓ ^C ^L | ~ / - _ ← →`（`PROMPT_KEYS`：Tab 补全、翻历史、清屏、管道，软键盘最缺的几个） |
| 命令在跑 / 集成降级 | `Esc ^C Tab Ctrl ↑ ↓ ← → Alt ^D ^Z ^L | ~ / - _ Home End PgUp PgDn`（`KEY_BAR`） |
| 有程序占屏 | 按前台程序换（下节） |

键区可横向滚动。命令在跑时**前 5 个（`Esc ^C Tab Ctrl ↑`）在 393px 宽下必须无需滚动即可见**，`^C` 在其中（AC-3.9）。没有触摸能力（`pointer: fine`）时键区为空，只剩互切键与 `⋯`。

### 粘滞修饰键

`Ctrl` / `Alt` 是**粘滞**的：

1. 点 `Ctrl` → 按钮进入高亮激活态
2. 下一次按键（软键盘或功能键条）与 `Ctrl` 组合发送
3. 发送后自动取消激活
4. 再点一次 `Ctrl` 手动取消
5. **长按 `Ctrl`** → 锁定态（连续多次组合，如 `Ctrl+C` 之后接着 `Ctrl+D`），再点解锁

激活态必须有明显视觉反馈 —— 否则用户不知道下一次按键会变成什么。

### 上下文键条（ADR-0011 分片 ②）

有程序占屏时，键条**按前台程序换内容**，而不是永远那一排通用键。占屏 = xterm 备用缓冲激活（vim / top / less），**或主屏就地重绘**（claude / codex 这类不切备用缓冲、靠光标寻址重画的 CLI，检测见 `web/src/term/interactive.ts`）。**终端态与编辑态都按这个 `interactive` 信号判定**（ADR-0015）—— 之前终端态只看备用缓冲，claude 在终端态拿到的是通用键：

| 程序 | 键 |
|---|---|
| `less` / `more` / `man` / `most` / `bat` | `q 退出` `/ 搜索` `n` `N` `␣ 翻页` `b 上页` `g 顶` `G 底` `^C` `Esc` |
| `top` / `htop` / `btop` | `q 退出` `k 杀` `P CPU` `M 内存` `/ 找` `↑` `↓` `Enter` `^C` `Esc` |
| `vim` / `vi` / `nvim` | `Esc` `:w` `:q` `:q!` `:wq` `i` `u 撤销` `h` `j` `k` `l` `^C` |
| `nano` | `^X 退出` `^O 保存` `^W 搜索` `^K` `^U` `Y` `N` `Enter` 方向键 |
| 不认识的（含 claude / codex） | `Esc` `^C` `q` `Enter` `Tab` 方向键 `Ctrl`，键条左侧显示程序名 |

程序名取自正在跑的块的命令原文（`programOf`：跳过 `FOO=1` 与 `sudo` 之类包装，管道取末端）。选错也只是少几个快捷键 —— `^C` 与 `Esc` 每一套都有。vim 的 `:q` 发的是 `Esc :q Enter`，避免停在插入模式。

键条左侧显示当前占屏的程序名（`data-testid="keybar-context"`），`data-context` 属性给测试用。

### 在 Composer 模式下的行为

功能键条在两个模式下都显示，但语义不同：

- Composer 模式：`↑↓` 走历史，`Tab` 插空格，`Esc` 清空/切 Raw，方向键移动光标
- Raw 模式：全部直通 PTY

`Ctrl+C` 是个特例：**在 Composer 模式下也直接发送 `0x03` 到 PTY**（而不是"复制"），因为用户按它的意图几乎总是打断当前进程。

### 外接键盘时隐藏

`@media (pointer: fine) and (not (pointer: coarse))` 时隐藏功能键条并启用桌面快捷键（AC-3.9 的平板部分）。

---

## 排障：输入死在哪一段（AC-3.17）

[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md) 立了「绝不静默丢弃 / 失活」的原则，但没有给出**怎么确认它没被违反**。四条路修完之后再遇到"打字没反应"，第一步仍然是猜 —— 所以输入路径按段留了计数：

```js
__webterm.inputStats()
// {
//   keydown:  {n: 12, agoMs: 900},    // 捕获阶段看到的 keydown：键真的按下了
//   toTerm:   {n: 12, agoMs: 900},    // 其中焦点确实在终端的 helper textarea 上
//   data:     {n: 12, agoMs: 900},    // xterm 吐出的 onData（用户输入那一路）
//   sent:     {n: 12, agoMs: 890},    // 发给 agent 的 INPUT 帧
//   gated:    0,                      // 被回放门丢掉的（自动应答，不该有用户按键）
//   unackedBytes: 0,                  // 发了但 agent 还没 ack —— 涨着不降就是没送到
//   focus: 'xterm-helper-textarea',
//   verdict: '四段都通：输入已经送达 agent'
// }
```

**按段读**，断点一眼可见（`verdict` 就是按这张表算的）：

| 现象 | 断点 | 多半是 |
|---|---|---|
| `keydown` 不涨 | 键没进页面 | 焦点在别的窗口 / 系统层吃掉了 |
| `keydown` 涨、`toTerm` 不涨 | 焦点不在终端 | 切会话 / 关浮层之后焦点落回 `body`（ADR-0020 推论一）；`focus` 字段直接写着它在哪 |
| `toTerm` 涨、`data` 不涨 | 卡在 xterm | 组字状态没复位（`composing` 恒真，推论二）；或按键被应用级快捷键拦下 |
| `data` 涨、`sent` 不涨 | 没发出去 | 回放门（看 `gated`）、或连接已断且离线队列满 |
| `sent` 涨、`unackedBytes` 一直不降 | agent 没确认 | 僵尸连接（决策一）、或 agent 那一侧 PTY 写不进 |
| **四段全通，程序还是没反应** | **不在 webterm 内** | 前台程序自己不读 stdin，或者它进了别的模式 —— 最常见的是 **tmux 的 copy-mode**（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §4），出口是 `q` / `Esc` |

两条口径：

- **计数按「最近一次发生」比，不按总量比**。总量是页面打开以来的累计，卡住之前的成功输入会把它撑满，看不出问题；`agoMs`（距今多久）才能说明"最近这一下走到哪儿断了"。
- **`keydown` 必须挂在捕获阶段**。xterm 处理掉的键会 `preventDefault + stopPropagation`，冒泡阶段根本收不到 —— 那样正常打字反而计不上数。

**生产构建里也在**，和 `__webterm.altScreen()` 同一条口径（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §排障口径）：排障要在真机真会话里当场能做，藏在 dev build 里等于没有。

## 软键盘适配（AC-3.8）

用 `visualViewport` 而不是 `window.innerHeight`：

```js
visualViewport.addEventListener('resize', onViewportChange)
visualViewport.addEventListener('scroll', onViewportChange)
```

布局规则：

- 应用容器高度 = `visualViewport.height`
- 功能键条与 Composer 固定在容器底部，因此始终在键盘上方
- 终端可视区 = 剩余空间，键盘弹出时**收缩**而不是被遮挡
- 收缩后触发 `resize`（防抖 100ms）→ 终端行数减少

**iOS Safari 的坑**：

- `100vh` 不随键盘变化，**不能用**。全部用 `visualViewport.height` 计算
- 键盘弹出时 iOS 会把整个页面向上"推"（`visualViewport.offsetTop` 非 0），需要用 `transform: translateY(-offsetTop)` 抵消
- 输入框聚焦时 iOS 可能自动滚动页面，需要 `overscroll-behavior: none` 并在容器上禁止滚动

## 读视图下的输入（ADR-0011；读视图已随 ADR-0013 移除，本节仅存历史）

手机默认是读视图（块流），xterm 不可见。底栏是一个**写态 sheet**（分片 ③），两个模式的落点变成：

| 模式 | 读视图里的输入 |
|---|---|
| Composer | 底栏收起时是一行输入框（`data-testid="composer"`，始终是同一个 `textarea`）+「终端」+ ⋯。碰它升起 sheet：半屏 / 全屏 |
| Raw | **还是同一个 Composer**（ADR-0012）。发送 = 整段交给 `xterm.paste()`（按前台程序的括号粘贴模式自动包裹、换行转回车）再补一个回车；sheet 里的「发送」**长按 = 只粘贴不回车**（codex 的数字选项、y/n 这类想自己按回车的场合）。单键（Esc ^C ⇧Tab ↑ ↓ Enter Tab Ctrl）在功能键条 |

长文在本地编辑完一次送出：慢网下不再逐键往返等回显，iOS 输入法也走原生 textarea（满足 AC-3.3）。claude / codex 都开了括号粘贴（`?2004h`），多行 prompt 不会被换行提前提交。**占屏程序（claude/codex/vim…）在读视图运行时不再用 `plainText` 拍扁**（那样会把光标定位输出拍成乱码）。

### claude / codex 在前台：转录视图（ADR-0012 γ；已随 ADR-0013 移除，仅存历史）

前台正在跑的程序是 `claude` / `codex`（命令原文取程序名，刷新页面后从转录回放的 `active` 补）时，读视图的画布不是块流而是**转录视图**（`data-testid="transcript"`）：

- **对话卡片**：用户消息右侧气泡；助手消息渲成 Markdown（标题 / 列表 / 围栏代码横滑 / 行内代码 / 粗斜体 / 链接只放 http(s) / 引用 / 表格，全部转义）；工具调用一行摘要（工具名 + 命令或路径）；斜杠命令的本地回显灰字。原生滚动、原生选择、原生双指缩放。
- **贴底跟随**同块流：在底部就跟，翻上去读旧的不拽人，来了新内容底部出「↓ 新内容」。
- **终端尾巴**（`transcript-tail`）：xterm 缓冲末 8 行的纯文本，300ms 节流 —— 看 spinner、权限提示、菜单；点它进终端视图操作。
- 数据来源：WS `transcript` 增量 + 切会话 / 重连 / 刷新时 `GET /api/transcript` 回放，按 id 去重；命令结束条目留着但视图回到块流。
- **不再自动跳终端**：占屏程序是 AI CLI 时留在读视图（转录 + Composer 才是主场）；vim / less / top 这类照旧自动进终端。刷新页面后占屏重判会早于转录回放到达，判定等回放说话，不会先跳终端再跳回。
- 写还是同一个 Composer：整段粘贴 + 回车；键条是 AI 套。

### 编辑面板 sheet 的档位（ADR-0015）

| 档 | 高度 | 进入 | 内容 |
|---|---|---|---|
| 收起 = 终端输入 | 槽位一行（56px / `short` 40px） | 拖到底、空输入时 `Esc`、`✎ 终端` | 终端态键行（sheet 不挂载） |
| 半屏 | `max(190px, 46% × 主区高)` | `⌨ 编辑`（默认档；记住上次开的档） | 抓手 · chips（有才显示）· 输入框 · 键行 |
| 全屏 | 主区高 − 顶部条与横幅 | 抓手点一下（半屏 ⇄ 全屏）、往上拖 | 同上，**输入框填满剩余高度**（sheet 内取消 40vh 上限） |

**sheet 盖在终端上，不挤画布**：`.bottom` 绝对定位在定高的 `.bottom-slot` 里往上长。`.canvas` 的几何在各档之间完全不变，xterm 不会 resize，PTY 不会收到 SIGWINCH —— 否则每开一次输入框，正在跑的程序就重排一次。高度取自 `.main` 的实际高度：键盘弹出 `.main` 变矮，sheet 跟着矮。**终端态没有这个例外**：键行正好填满槽位，`.bottom` 不高于 `.bottom-slot`，所以不盖终端（AC-3.14）。

**发送后留在编辑面板**（ADR-0014+）：连着发是常态，要回终端直输点 `✎ 终端`。

### 编辑键行（分片 ③ / ADR-0015）

sheet 打开时输入框下面是一条键行（`data-testid="editkeys"`），和终端态同一副骨架：

`✎ 终端` · `Esc ^C`（只在命令在跑 / 占屏 / 降级时出现，`data-testid="key-Escape"` / `key-CtrlC"`，直发 PTY）· 编辑键（横滚，`data-testid="edit-<key>"`）· **发送**（行尾固定）

编辑键面向"写"，不是终端键（触摸设备才显示；接了键盘的平板只剩互切键与发送）：

`Tab ↑ ↓ ← → ⌫词 | ~ / - _ " ' $ ⇤ ⇥`

- `Tab`：有路径 chip 时补第一个 —— 这就是触屏上的 Tab 补全；没有就插两个空格
- `↑ ↓` 翻历史（不看光标位置，按这两个键的意图是明确的）；`← →` 移光标；`⇤ ⇥` 行首 / 行尾；`⌫词` 删光标左边一个词
- 符号键插字面；`|` 插的是 ` | `
- 所有键在 `pointerdown` 时 `preventDefault`，**不抢输入框焦点** —— 软键盘一收一弹是最糟的体验

### chips（分片 ③）

sheet 顶上一排，横滑（`data-testid="chip"`，`data-kind` = `pin` / `cmd` / `path`）：

| 输入框 | 内容 | 点一下 |
|---|---|---|
| 空 | 快捷命令（★）+ **同目录历史**（`GET /api/commands?cwd=`，去重，最多 8 条） | 整条填入 |
| 有内容 | 光标处 token 的**路径补全**（[`GET /api/fs`](../30-protocol/http-api.md#路径补全)）+ 以整段输入为前缀的历史 | 路径：只替换光标所在的 token，目录补 `/` 还能继续往下补；历史：整条填入 |

路径补全只在"值得问"的时候问（`wantsPath`）：参数位都问，选项（`-x`）不问，命令位只有 `./` `../` `/` `~` 开头的才问 —— 否则敲 `gi` 会去找 `gi*`，而用户想打的是 `git`。文件名里 shell 会误解的字符插入时加反斜杠。没有 CWD（集成不可用）就没有路径与同目录历史，只剩快捷命令与前缀历史。

数据 120ms 去抖；一个接口失败当空列表，不影响另一半。

### 终端态的底栏（手机 / 平板）

槽位 `.bottom-slot` 定高（`--slot-h`），终端态的键行正好填满它 —— 提示符 / 命令在跑 / 占屏 / 降级只换键区内容，高度不变、不盖终端、不给 PTY 发 resize：

| 内部模式 | 键行 |
|---|---|
| Composer（停在提示符） | `⌨ 编辑` · `Tab ↑ ↓ ^C ^L | ~ / - _ ← →` · `⋯` |
| Raw（命令在跑）/ 降级 | `⌨ 编辑` · `Esc ^C Tab Ctrl ↑ ↓ ← → …` · `⋯` |
| 占屏 | `⌨ 编辑` · 程序名 · 该程序的键 · `⋯` |

没有触摸能力时键区为空：`⌨ 编辑` · `⋯`。桌面（`≥ 1024px`）保留经典底栏：模式条 + 输入框 + 快捷命令条 + 键条。

### ⋯ 菜单

模式条上的次要入口（会话、历史、设置）在手机 / 平板上收进终端态键行**行尾**的 ⋯（`data-testid="open-more"` → `more-menu`，从底部滑起的操作面板），各项 testid 不变。三项打开的是**同一种浮层**（`Drawer`：贴底 sheet、抓手、标题栏 + ✕、点遮罩 / `Esc` / 下滑都能关，见 [ADR-0018](../20-architecture/adr/0018-one-drawer-primitive.md) 与 [layout-responsive.md §浮层](layout-responsive.md#浮层adr-0018)）。编辑面板里没有 ⋯（行尾是「发送」）；历史与快捷命令在面板里以 chips 的形式出现。

## 降级（AC-3.7 / US-7.1）

`integration === "inactive"` 时：

- 强制 Composer 模式，自动切换禁用
- 模式切换按钮变为主要交互（用户需要自己切到 Raw 才能用 vim）
- 顶部细条显示一个不打扰的提示：`shell 集成未生效 · 了解原因`，点击展开说明与 `webterm shell-init bash` 的接入方法
- 历史导航（`↑`）仍可用（历史来自 agent 的 DB，只是不再新增记录）
