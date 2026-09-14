# 快捷键与按键映射

> 状态：Accepted

## 设计约束

Raw 模式下**所有按键都要能进 PTY**。所以应用级快捷键必须用终端程序不会用到的组合。

| 修饰组合 | 能不能给应用用 | 原因 |
|---|---|---|
| `Ctrl+<字母>` | ❌ | 终端控制码（`Ctrl+C`、`Ctrl+D`、`Ctrl+R`…） |
| `Alt+<字母/数字>` | ❌ | TUI 的 Meta 键（emacs、vim、tmux 前缀） |
| `Ctrl+<数字>` | ❌ | 浏览器切标签页占用 |
| `Cmd+<字母>`（macOS） | ⚠️ 部分 | 浏览器占用大部分 |
| **`Ctrl+Shift+<字母>`** | ✅ | 不是合法的终端控制码，终端程序收不到 |

**结论：应用快捷键统一用 `Ctrl+Shift+*`。** 唯一的例外是 `Ctrl/Cmd+F`（会话内搜索）—— 终端程序不用它。

快捷键保持**极少**是刻意的，不做几十个快捷键：入口本来就少，而且都在屏幕上。

**`Ctrl/Cmd+K` 不拦。** 它一度是命令面板的总入口，但 readline 的 `Ctrl+K` 是「删到行尾」（bash / zsh / emacs / fish 通用）—— 拦它等于拦了一个终端真正在用的键。命令面板已随 [ADR-0022](../20-architecture/adr/0022-drop-command-palette.md) 删除，这个键归还终端。

## 应用级快捷键

在 Composer 和 Raw 两个模式下都生效，通过 xterm 的 `attachCustomKeyEventHandler` 拦截（返回 `false` 阻止进入 PTY）。

| 快捷键 | 动作 |
|---|---|
| `Ctrl/Cmd+F` | 会话内搜索 |
| `Ctrl+Shift+Enter` | 新建会话 |
| `Ctrl+Shift+W` | 关闭当前会话（`running` 需确认） |
| `Ctrl+Shift+↑` / `↓` | 上一个 / 下一个会话 |
| `Ctrl+Shift+B` | 折叠/展开侧栏（desktop）/ 开关浮层（phone / tablet） |
| `←` / `→` | **焦点在侧栏分隔条上时**：改侧栏宽度，步进 16px（`Shift` 加持 64px）；`Home` / `End` 到最小 / 最大；`Enter` / `Space` 收起或展开 |
| `Ctrl+Shift+,` | 设置 |

**被浏览器强占、不能用的组合**：`Ctrl+Shift+T/N`（新标签页/新窗口）、`Ctrl+Shift+P`（Firefox 隐私窗口）、`Ctrl+Shift+H`（Firefox 历史库）。历史面板因此**不设快捷键** —— 它在模式条 / ⋯ 菜单里点一下就开，这正是"只留极少快捷键"的意义。

**`Ctrl+Shift+W` 是已知妥协**：浏览器里是"关闭窗口"，PWA standalone 下可拦截，普通标签页里抢不过。PWA 是推荐用法，会话列表里每条会话的 ✕ 是备用路径。

## Composer 模式键位

| 键 | 行为 |
|---|---|
| `Enter` | 提交（`isComposing` 为 true 时**必须忽略**） |
| `Shift+Enter` | 插入换行 |
| `Ctrl/Cmd+Enter` | 提交 |
| `↑` | 光标在首行行首 → 历史上一条（有内容时做前缀匹配）；否则移动光标 |
| `↓` | 光标在末行行尾 → 历史下一条；否则移动光标 |
| `Esc` | 有内容 → 清空；无内容 → 切到 Raw 并聚焦终端 |
| `Tab` | 插入两个空格（v0.1；补全留 v0.2） |
| `Ctrl+C` | **直通 PTY 发 `0x03`**（不是复制）。用户按它的意图几乎总是打断进程 |
| `Ctrl+V` / `Cmd+V` | 原生粘贴（进输入框，不直接进 PTY） |

## Raw 模式按键映射

绝大部分交给 xterm.js 的 `onData` —— 它已经正确实现了标准映射。这里列出需要**自己处理**或需要验证的（AC-3.4）：

| 按键 | 发送字节 |
|---|---|
| `Ctrl+A`…`Ctrl+Z` | `0x01`…`0x1a` |
| `Ctrl+C` | `0x03` |
| `Ctrl+D` | `0x04` |
| `Ctrl+[` / `Esc` | `0x1b` |
| `Ctrl+\` | `0x1c` |
| `Ctrl+]` | `0x1d` |
| `Backspace` | `0x7f`（DEL，不是 `0x08`） |
| `Tab` | `0x09` |
| `Enter` | `0x0d`（CR） |
| `↑ ↓ → ←` | `ESC [ A/B/C/D` |
| `Home` / `End` | `ESC [ H` / `ESC [ F` |
| `PgUp` / `PgDn` | `ESC [ 5 ~` / `ESC [ 6 ~` |
| `Delete` | `ESC [ 3 ~` |
| `Insert` | `ESC [ 2 ~` |
| `F1`–`F4` | `ESC O P/Q/R/S` |
| `F5`–`F12` | `ESC [ 15/17/18/19/20/21/23/24 ~` |
| `Alt+<字符>` | `ESC` + 字符 |
| `Shift+Tab` | `ESC [ Z` |

**IME 期间全部忽略**：`keydown` 处理器在 `composing === true` 时立即 return（AC-3.3）。

**粘贴**：`onPaste` 用 bracketed paste 包裹（`ESC[200~ … ESC[201~`）。

## 功能键条（移动端）

见 [`input-modes.md`](input-modes.md#移动端功能键条ac-39)。按键集合与粘滞修饰键行为在那里定义。

功能键条的按键在两个模式下语义不同：

| 键 | Composer | Raw |
|---|---|---|
| `Esc` | 清空 / 切 Raw | `0x1b` |
| `Tab` | 插两空格 | `0x09` |
| `↑↓` | 翻历史 | `ESC[A` / `ESC[B` |
| `←→` | 移动光标 | `ESC[C` / `ESC[D` |
| `Ctrl` `Alt` | 粘滞修饰（组合后直通 PTY） | 粘滞修饰 |
| `\| ~ / - _` | 插入字符 | 发送字符 |
| `Home End PgUp PgDn` | 移动光标 | 对应转义序列 |

## 可配置性

**v0.1 不做快捷键自定义。** 键位表硬编码在 `web/src/input/keymap.ts`。

理由：快捷键不到十个，除 `Ctrl/Cmd+F` 外都是不冲突的 `Ctrl+Shift+*`。做配置界面的成本远大于收益。如果将来有真实需求（比如某个键被系统占用），再加。
