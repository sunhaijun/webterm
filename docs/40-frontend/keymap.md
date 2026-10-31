# 快捷键与按键映射

> 状态：Accepted。界面层面的决策见 [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md)。

## 设计约束

终端直输时**所有按键都要能进 PTY**。所以应用级快捷键必须用终端程序不会用到的组合。

| 修饰组合 | 能不能给应用用 | 原因 |
|---|---|---|
| `Ctrl+<字母>` | ❌ | 终端控制码（`Ctrl+C`、`Ctrl+D`、`Ctrl+R`、`Ctrl+K`…） |
| `Alt+<字母/数字>` | ❌ | TUI 的 Meta 键（emacs、vim、tmux 前缀） |
| `Ctrl+Alt+<字母>` | ❌ | Windows 和欧洲键盘上等于 AltGr，会吃掉输入的字符（Termux 用它，我们不照抄） |
| `Ctrl+<数字>` | ❌ | 浏览器切标签页占用 |
| `Cmd+<字母>`（macOS） | ⚠️ 部分 | 浏览器占用大部分 |
| **`Ctrl+Shift+<字母>`** | ✅ | 不是合法的终端控制码，终端程序收不到 |

**结论：应用快捷键只用 `Ctrl+Shift+*`，没有例外。** `Ctrl/Cmd+F` 与 `Ctrl/Cmd+K` 都不拦，交还给浏览器或终端（readline 的 `Ctrl+K` 是「删到行尾」）。

快捷键保持**极少**是刻意的：入口本来就少，而且都在屏幕上。

## 应用级快捷键

通过 xterm 的 `attachCustomKeyEventHandler` 拦截（返回 `false` 阻止进入 PTY）。文本输入页有焦点时同样生效。

| 快捷键 | 动作 |
|---|---|
| `Ctrl+Shift+Enter` | 新建会话 |
| `Ctrl+Shift+W` | 关闭当前会话（规则见 [session-ux.md](session-ux.md)） |
| `Ctrl+Shift+↑` / `↓` | 上一个 / 下一个会话（到头回绕） |
| `Ctrl+Shift+B` | `compact`：打开 / 关闭会话抽屉。`wide`：不做任何事 |

**被浏览器强占、不能用的组合**：`Ctrl+Shift+T/N`（新标签页 / 新窗口）、`Ctrl+Shift+P`（Firefox 隐私窗口）、`Ctrl+Shift+H`（Firefox 历史库）。

**`Ctrl+Shift+W` 是已知妥协**：浏览器里是"关闭窗口"，PWA standalone 下可拦截，普通标签页里抢不过。PWA 是推荐用法；会话菜单里的「关闭」与标签上的 ✕ 是备用路径。

## 键到字节

终端直输时绝大部分交给 xterm.js 的 `onData` —— 它已经正确实现了标准映射。附加键（[input.md](input.md#附加键ac-318)）发的字节与实体键盘**完全相同**，用同一张表（`web/src/keys/keymap.ts`）：

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
| `↑ ↓ → ←` | `ESC [ A/B/C/D`；**应用光标键模式（DECCKM）下** `ESC O A/B/C/D` |
| `Home` / `End` | `ESC [ H` / `ESC [ F`；DECCKM 下 `ESC O H` / `ESC O F` |
| `PgUp` / `PgDn` | `ESC [ 5 ~` / `ESC [ 6 ~` |
| `Delete` | `ESC [ 3 ~` |
| `Insert` | `ESC [ 2 ~` |
| `F1`–`F4` | `ESC O P/Q/R/S` |
| `F5`–`F12` | `ESC [ 15/17/18/19/20/21/23/24 ~` |
| `Alt+<字符>` | `ESC` + 字符 |
| `Shift+Tab` | `ESC [ Z` |

DECCKM 的状态读 `term.modes.applicationCursorKeysMode`，**每次按键时现读**，不缓存：程序退出时会复位它。

### 附加键的粘滞修饰

附加键的 CTRL / ALT 激活时（[input.md](input.md#行为)），下一个键按下表组合：

| 下一个键 | CTRL | ALT |
|---|---|---|
| 字母 `a`–`z`（大小写不分） | `0x01`–`0x1a` | `ESC` + 字符 |
| `[` `\` `]` `^` `_` | `0x1b` `0x1c` `0x1d` `0x1e` `0x1f` | `ESC` + 字符 |
| `@` / 空格 | `0x00` | `ESC` + 字符 |
| `?` | `0x7f` | `ESC` + 字符 |
| 其它可打印字符 | 原样 | `ESC` + 字符 |
| 方向键 / `HOME` / `END` / `PGUP` / `PGDN` | xterm 的修饰编码，如 `ESC [ 1 ; 5 A` | 如 `ESC [ 1 ; 3 A` |
| `ESC` / `TAB` | 原样 | `ESC` + 字节 |

CTRL 与 ALT 同时激活时先做 CTRL 变换，再加 `ESC` 前缀。

## 粘贴

`onPaste` 交给 xterm：对端开了括号粘贴（`?2004h`）就包 `ESC[200~ … ESC[201~`，换行转 `CR`。

## 可配置性

**应用快捷键不做自定义**。不到十个，全是不冲突的 `Ctrl+Shift+*`，做配置界面的成本远大于收益。

附加键的键位可以自定义（[ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) §2，第 3 步）。
