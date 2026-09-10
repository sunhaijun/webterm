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
还在跑，于是停在 Raw、提交语义变成"发给程序"，**用户敲的下一条命令会被粘进上一条的 stdin**，要等下一条命令
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

有程序占屏时，键条**按前台程序换内容**，而不是永远那一排通用键。占屏 = xterm 备用缓冲激活（vim / top / less），**或主屏就地重绘**（claude / codex 这类不切备用缓冲、靠光标寻址重画的 CLI，检测见 `web/src/term/interactive.ts`）：

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

手机默认是读视图（块流），xterm 不可见。底栏是一个**写态 sheet**（分片 ③），两个模式的落点变成：

| 模式 | 读视图里的输入 |
|---|---|
| Composer | 底栏收起时是一行输入框（`data-testid="composer"`，始终是同一个 `textarea`）+「终端」+ ⋯。碰它升起 sheet：半屏 / 全屏 |
| Raw | **还是同一个 Composer**（ADR-0012）。发送 = 整段交给 `xterm.paste()`（按前台程序的括号粘贴模式自动包裹、换行转回车）再补一个回车；sheet 里的「发送」**长按 = 只粘贴不回车**（codex 的数字选项、y/n 这类想自己按回车的场合）。单键（Esc ^C ⇧Tab ↑ ↓ Enter Tab Ctrl）在功能键条 |

长文在本地编辑完一次送出：慢网下不再逐键往返等回显，iOS 输入法也走原生 textarea（满足 AC-3.3）。claude / codex 都开了括号粘贴（`?2004h`），多行 prompt 不会被换行提前提交。**占屏程序（claude/codex/vim…）在读视图运行时不再用 `plainText` 拍扁**（那样会把光标定位输出拍成乱码）。

### 写态 sheet 的三档

| 档 | 高度 | 进入 | 内容 |
|---|---|---|---|
| 收起 | 56px 一行 | 提交、空输入时 `Esc`、「收起」、拖到底、命令开始跑 | 输入框 +「终端」+ ⋯ |
| 半屏 | `max(190px, 46% × 主区高)` | 碰输入框（默认档；记住上次开的档） | 把手 · chips · 输入框 · 编辑键条 |
| 全屏 | 主区高 − 顶部条与横幅 | 把手点一下（半屏 ⇄ 全屏）、往上拖 | 同上，输入框吃掉全部 |

**sheet 盖在块流上，不挤画布**：`.bottom` 绝对定位在 56px 定高的 `.bottom-slot` 里往上长。`.canvas` 的几何在三档之间完全不变，xterm 不会 resize，PTY 不会收到 SIGWINCH —— 否则每开一次输入框，正在跑的程序就重排一次。块流按 `--sheet-inset` 让出被盖住的那段，本来贴底的继续贴底。高度取自 `.main` 的实际高度：键盘弹出 `.main` 变矮，sheet 跟着矮。

**提交即收起**：发出去之后该看的是输出，键盘一起收。想连着敲就再碰一下输入框。命令跑起来（Raw）sheet 一定是收起的。

### 编辑键条（分片 ③）

sheet 打开且是触摸设备时，输入框下面一排面向"写"的键（`data-testid="edit-<key>"`），不是终端键：

`Tab ↑ ↓ ← → ⌫词 | ~ / - _ " ' $ ⇤ ⇥` + **发送**

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

### 终端视图里的底栏（手机 / 平板）

终端视图**共用同一个 56px 的槽** —— 两种视图画布几何完全一致，切视图不给 PTY 发 resize（ADR-0011 约束 1 的另一半）：

| 模式 | 槽里是什么 |
|---|---|
| Composer | 一行输入框 +「读」+ ⋯。**没有 sheet**：升起来会盖住终端最后几行，而 prompt 就在那儿 |
| Raw | 功能键条独占（含上下文键），「读」与 ⋯ 是键条最前面的两个前导键；没有触摸能力时退回一行提示 +「读」+ ⋯ |

桌面（`≥ 1024px`）两种视图都保留经典底栏：模式条 + 输入框 + 快捷命令条 + 键条。

### ⋯ 菜单

模式条上的次要入口（历史、命令面板、输入模式切换 / 解锁、设置；终端视图里还有「块」面板）在手机 / 平板上收进底栏右侧的 ⋯（`data-testid="open-more"` → `more-menu`），各项 testid 不变。底栏只留三样：输入、「终端」/「读」、⋯。

## 降级（AC-3.7 / US-7.1）

`integration === "inactive"` 时：

- 强制 Composer 模式，自动切换禁用
- 模式切换按钮变为主要交互（用户需要自己切到 Raw 才能用 vim）
- 顶部细条显示一个不打扰的提示：`shell 集成未生效 · 了解原因`，点击展开说明与 `webterm shell-init bash` 的接入方法
- 历史导航（`↑`）仍可用（历史来自 agent 的 DB，只是不再新增记录）
