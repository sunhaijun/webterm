# 输入模式

> 状态：Accepted
>
> 决策背景见 [ADR-0007](../20-architecture/adr/0007-dual-mode-input.md)。这篇定义状态机与实现细节。

## 两个模式

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
状态 = { mode: "composer" | "raw", locked: boolean }
```

`locked` 表示用户手动指定过模式，自动切换暂停。

### 转移表

| 当前 | 事件 | 结果 |
|---|---|---|
| 任意，`locked=false` | `prompt{state:"input"}` | `mode=composer` |
| 任意，`locked=false` | `prompt{state:"running"}` | `mode=raw`（**经去抖**，见下） |
| 任意，`locked=false` | `prompt{state:"done"}` | `mode=composer` |
| 任意 | 用户点击模式切换按钮 / 按 `Ctrl+Shift+M` | 切换 `mode`，`locked=true` |
| 任意 | 用户点"解锁自动"（或切换会话） | `locked=false`，立即按最近的 `prompt` 状态重算 |
| 任意 | `integration` 变为 `inactive` | `mode=composer`，自动切换禁用，显示降级提示 |
| 任意，`locked=false` | 重连后收到 `welcome` | 按 `sessions[].prompt_state` 重新对齐 |
| Composer | 用户点击终端区并开始打字 | 不切模式。把字符注入 Composer 并聚焦它（避免"点了终端打不出字"的困惑） |
| Raw | 用户点击 Composer 输入框 | `mode=composer`，`locked=true` |

### 重连之后必须重新对齐

`prompt` 消息只在状态变化时发一次，客户端离线期间的那些就丢了。断线如果
恰好跨过一个命令边界，客户端手里还是断线前的状态 —— 命令早跑完了它却以为
还在跑，于是停在 Raw、Composer 收起，**用户连字都打不了**，要等下一条命令
才自愈。

所以收到 `welcome` 时要用 `sessions[].prompt_state` 重算一次（`locked` 时
不动，那是用户的明确选择）。

### `running` 的去抖

命令瞬间结束（`ls`、`echo`）会产生 `running` → `done` 只隔几毫秒的序列。如果直接切换，界面会闪一下 Raw 再回来，很难看。

**规则**：收到 `prompt{state:"running"}` 后延迟 **120ms** 再切到 Raw。若在延迟期内收到 `done`，取消切换。

去抖只对 `running` 生效 —— 切回 Composer 必须立即，否则用户输入会被拖慢。

### 状态是每会话的

模式状态跟随会话，不是全局的。切换会话时加载目标会话的模式状态。切换会话会重置 `locked=false`（用户对上一个会话的手动选择不该跨会话生效）。

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

内联预览浮层：绝对定位到 xterm 的当前光标屏幕坐标（`terminal.buffer.active.cursorX/cursorY` × cell 尺寸），显示未提交的组字内容 + 下划线。让用户知道自己在打什么。

### 按键映射

见 [`keymap.md`](keymap.md)。要点：

- 使用 xterm.js 的 `onData` 拿到已经映射好的字节（它处理了绝大多数控制键）
- `attachCustomKeyEventHandler` 拦截应用级快捷键（`Ctrl+Shift+*`、`Ctrl/Cmd+K`），让它们不进 PTY
- 粘贴（`onPaste`）也用 bracketed paste 包裹

---

## 移动端功能键条（AC-3.9）

### 按键集合

```
Esc  Tab  Ctrl  Alt  ↑  ↓  ←  →  |  ~  /  -  _  Home  End  PgUp  PgDn
```

可横向滚动。前 8 个（`Esc Tab Ctrl ↑↓←→ |`）在最窄屏幕下必须无需滚动即可见。

### 粘滞修饰键

`Ctrl` / `Alt` 是**粘滞**的：

1. 点 `Ctrl` → 按钮进入高亮激活态
2. 下一次按键（软键盘或功能键条）与 `Ctrl` 组合发送
3. 发送后自动取消激活
4. 再点一次 `Ctrl` 手动取消
5. **长按 `Ctrl`** → 锁定态（连续多次组合，如 `Ctrl+C` 之后接着 `Ctrl+D`），再点解锁

激活态必须有明显视觉反馈 —— 否则用户不知道下一次按键会变成什么。

### 上下文键条（ADR-0011 分片 ②）

有程序占屏时（xterm 备用屏幕缓冲激活），键条**按前台程序换内容**，而不是永远那一排通用键：

| 程序 | 键 |
|---|---|
| `less` / `more` / `man` / `most` / `bat` | `q 退出` `/ 搜索` `n` `N` `␣ 翻页` `b 上页` `g 顶` `G 底` `^C` `Esc` |
| `top` / `htop` / `btop` | `q 退出` `k 杀` `P CPU` `M 内存` `/ 找` `↑` `↓` `Enter` `^C` `Esc` |
| `vim` / `vi` / `nvim` | `Esc` `:w` `:q` `:q!` `:wq` `i` `u 撤销` `h` `j` `k` `l` `^C` |
| `nano` | `^X 退出` `^O 保存` `^W 搜索` `^K` `^U` `Y` `N` `Enter` 方向键 |
| 不认识的 | `Esc` `^C` `q` `Enter` `Tab` 方向键 `Ctrl` |

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

## 读视图下的输入（ADR-0011）

手机默认是读视图（块流），xterm 不可见。两个模式的落点变成：

| 模式 | 读视图里的输入 |
|---|---|
| Composer | 和原来一样：底部多行 `textarea`，提交走 bracketed paste |
| Raw | **直发输入行**（`data-testid="rawline"`）：单行 `input`，Enter 把整行 + `\r` 送进 PTY。用于 `[Y/n]`、密码、REPL 这类"命令在跑但要输入"的场景 |

直发输入行是**按行**发的，不是按键直通 —— 组字期间自然不会有半个字节出去（AC-3.3 的另一种满足方式）。要真正按键直通（vim / less 的单键操作）就切到终端视图，或者等分片 ② 让备用缓冲自动切过去。功能键条在两种视图里都直接发字节。

## 降级（AC-3.7 / US-7.1）

`integration === "inactive"` 时：

- 强制 Composer 模式，自动切换禁用
- 模式切换按钮变为主要交互（用户需要自己切到 Raw 才能用 vim）
- 顶部细条显示一个不打扰的提示：`shell 集成未生效 · 了解原因`，点击展开说明与 `webterm shell-init bash` 的接入方法
- 历史导航（`↑`）仍可用（历史来自 agent 的 DB，只是不再新增记录）
