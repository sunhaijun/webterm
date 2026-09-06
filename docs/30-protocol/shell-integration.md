# bash shell 集成协议

> 状态：Accepted
>
> ★ 这是 agent 与 shell 之间的契约。改动需同步 `internal/shellinit`（脚本）与 `internal/oscparse`（解析器）。

## 它为什么是 v0.1 的必需项

一份集成脚本同时支撑**四个**功能：

1. **命令历史** —— 命令原文、退出码、耗时、CWD（[US-6.1](../10-requirements/user-stories.md)）
2. **CWD 上报** —— 会话自动命名（[AC-4.4](../10-requirements/acceptance-criteria.md)）
3. **输入模式自动切换** —— prompt 状态驱动 Composer ⇄ Raw（[ADR-0007](../20-architecture/adr/0007-dual-mode-input.md)）
4. **命令块视图的数据基础** —— v0.2 用，v0.1 只采数据

其中第 3 项是决定性的：没有它，双模输入就要用户手动切，一天切几十次，产品价值废掉一半。

**没有它会怎样**：终端照常可用，但无历史、无 CWD 显示、模式需手动切。UI 显示降级提示（[US-7.1](../10-requirements/user-stories.md)）。

---

## 1. 注入方式

agent 启动会话时生成临时 rcfile，用 `bash -i --rcfile <path>` 启动。**用户不需要修改任何 dotfile。**

详细的 bash 初始化语义处理（登录 / 非登录、避免重复 source、钩子安装在用户配置之后）见 [ADR-0010](../20-architecture/adr/0010-bash-rcfile-injection.md)。

rcfile 要求：

- 权限 `0600`，放在 agent 运行时目录（`$XDG_RUNTIME_DIR/webterm/` 或数据目录下的 `run/`），**不放 `/tmp`**
- 会话结束时删除；agent 启动时清理上次崩溃的残留
- 启动 PTY 前清理可能干扰的环境变量：`BASH_ENV`、`ENV`

降级入口：`webterm shell-init bash` 输出同一份脚本到 stdout，供用户手动 `eval` 接入（换了 shell、进容器、`su` 切用户等场景）。

---

## 2. 转义序列定义

三组序列。前两组是生态里的半标准，第三组是 webterm 私有。

`ST` 指字符串终止符，可以是 `ESC \`（`0x1b 0x5c`）或 `BEL`（`0x07`）。**脚本统一发 `BEL`**（更短，且在 bash 的 `$'...'` 里更好写）；**解析器必须同时接受两种**。

### 2.1 OSC 133 — prompt 与命令标记（半标准）

| 序列 | 时机 | agent 动作 |
|---|---|---|
| `ESC ] 133 ; A BEL` | prompt 开始绘制 | 剥离，不产生消息 |
| `ESC ] 133 ; B BEL` | prompt 绘制完毕，等待用户输入 | 剥离，发 `prompt{state:"input"}` |
| `ESC ] 133 ; C BEL` | 命令开始执行，输出即将开始 | 剥离，发 `prompt{state:"running"}`，并结算 `command.start` |
| `ESC ] 133 ; D ; <exit_code> BEL` | 命令执行结束 | 剥离，发 `prompt{state:"done"}` + `command.end` |

用 OSC 133 而不是自定义序列，是为了让其它支持它的终端（kitty、WezTerm、VS Code）也能受益于同一份脚本。

`<exit_code>` 为十进制整数字符串。非数字或缺失 → 视为 `null`，不阻断处理。

### 2.2 OSC 7 — 工作目录（半标准）

```
ESC ] 7 ; file://<hostname><percent-encoded-path> BEL
```

agent 动作：剥离，解析出 path，路径变化时发 `cwd{sid, path}`。

- `hostname` 部分**忽略**（我们总是在本机）
- path 必须做 percent-decode
- 解析失败 → 忽略这条，不发消息，不报错

### 2.3 OSC 1701 — webterm 私有扩展

`1701` 是 webterm 的私有 OSC 命名空间（任意选定的未占用编号）。

| 序列 | 时机 | agent 动作 |
|---|---|---|
| `ESC ] 1701 ; hello ; <version> BEL` | 集成脚本加载完成 | 剥离，`integration` 置 `active`，发 `session.updated` |
| `ESC ] 1701 ; cmd ; <base64(命令原文)> BEL` | 命令即将执行（在 `133;C` 之前） | 剥离，缓存为待结算的命令原文 |

**为什么命令原文需要私有序列**：OSC 133 只标记边界，不含命令文本。终端"本应"通过捕获 `B` 与 `C` 之间用户键入的字节来推断命令 —— 但那在 readline 编辑（方向键、历史调用、补全）下完全不可靠。所以显式发送。

**为什么 base64**：命令原文可以包含任意字节，包括 `BEL`、`ESC`、换行、以及会破坏 OSC 结构的字符。base64（标准字母表，带 `=` 填充）保证载荷安全。

`<version>` 是集成脚本的版本号（如 `1`），用于将来 agent 与脚本版本不匹配时的诊断。

---

## 3. 命令生命周期与结算

一条命令的完整序列（正常情况）：

```
ESC]133;A BEL   <prompt 文本>   ESC]133;B BEL
                                       ↑ 用户在这里输入（Composer 模式）
ESC]1701;cmd;Z28gdGVzdCAuLy4uLg== BEL
ESC]133;C BEL
<命令输出……>
ESC]133;D;0 BEL
```

agent 侧的状态机：

| 事件 | 动作 |
|---|---|
| `1701;cmd` | 暂存 `pending_cmd_text` |
| `133;C` | 若有 `pending_cmd_text`：写 `commands` 表（`started_at` = 现在，`exit_code`/`duration_ms` 为 NULL），得 `cmd_id`，发 `command.start{text, cwd, out_seq}`，清空暂存 |
| `133;D;<code>` | 若有进行中的 `cmd_id`：更新该行的 `exit_code` 与 `duration_ms`，发 `command.end{out_seq}` |

### 必须容忍的异常序列

| 情况 | 处理 |
|---|---|
| `133;C` 没有前置的 `1701;cmd` | 不记录命令（可能是空回车，或以空格开头被跳过），但仍发 `prompt{state:"running"}` |
| `133;D` 没有前置的 `133;C` | 只发 `prompt{state:"done"}`，不结算命令 |
| 有 `133;C`，shell 在 `133;D` 之前死掉 | `commands` 行的 `exit_code`/`duration_ms` 永久为 NULL。查询时按"未完成"展示。client 需容忍悬空的 `command.start` |
| 连续两个 `1701;cmd` 中间没有 `133;C` | 后者覆盖前者 |
| 命令内部输出了 `133;*` 序列（比如 `cat` 一个含这些字节的文件） | **无法区分**。已知限制，见 §6 |

---

## 4. 集成脚本要点

完整脚本在 `internal/shellinit/bash.sh`（`go:embed`）。这里定义它必须满足的行为。

### 4.1 命令原文的获取

用 `DEBUG` trap + 守卫标志（经典的 bash-preexec 模式），并从 `history 1` 取**完整命令行**：

```bash
__webterm_preexec_invoked=0

__webterm_preexec() {
    [ -n "$COMP_LINE" ] && return                  # 补全过程中，跳过
    [ "$__webterm_preexec_invoked" = 1 ] && return # 一个命令行内只触发一次
    __webterm_preexec_invoked=1
    local line
    line=$(HISTTIMEFORMAT= builtin history 1)
    line=${line#*[0-9]  }                          # 去掉历史编号
    …emit OSC 1701;cmd + OSC 133;C…
}
```

**为什么用 `history 1` 而不是 `$BASH_COMMAND`**：`$BASH_COMMAND` 在 DEBUG trap 里给的是**当前正在执行的单个简单命令**。对 `foo | bar` 它会触发两次，分别给 `foo` 和 `bar`；对 `for` 循环会触发 N 次。守卫标志能保证只取第一次，但那就只拿到 `foo`，不是完整命令行。`history 1` 给的是用户实际输入的整行。

**副作用即是特性**：`HISTCONTROL=ignorespace` 时，以空格开头的命令不进历史，`history 1` 会返回**上一条**命令。脚本必须检测这种情况（把上次记录的命令行缓存下来比对，相同则判定为"本次命令未进历史"）并**跳过上报** —— 这正好实现了 AC-6.2 / US-6.7 的隐私需求。

脚本必须显式确保 `HISTCONTROL` 包含 `ignorespace`（如果用户没设，我们追加；不移除用户已有的设置）。

### 4.2 precmd（命令结束 + prompt 前）

装在 `PROMPT_COMMAND` 上，必须**追加而不覆盖**，并处理 bash 5.1+ 的数组形式：

```bash
__webterm_precmd() {
    local code=$?
    if [ "$__webterm_preexec_invoked" = 1 ]; then
        …emit OSC 133;D;$code…
    fi
    __webterm_preexec_invoked=0
    …emit OSC 7 (cwd)…
    __webterm_assert_ps1                # 重新断言 PS1 上的标记
}
```

**`$?` 必须在函数第一行捕获**，否则会被函数内的任何命令覆盖。

### 4.3 PS1 标记

在 `PS1` 前后包上 `133;A` 和 `133;B`，包在 `\[ \]`（零宽区域）里以免 readline 算错行宽：

```bash
PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]'
```

**必须每次 precmd 都重新断言**（`__webterm_assert_ps1`），因为某些 prompt 主题框架（starship、powerline、oh-my-bash）会在每次 prompt 前重写 `PS1`。断言逻辑：检查 `PS1` 是否已含标记，没有则重新包上。

### 4.4 已有 DEBUG trap 的链式调用

安装前用 `trap -p DEBUG` 取出已有的 trap 命令，如果非空则在我们的函数末尾调用它，不替换。

### 4.5 容错要求（AC-7.7）

- 整个钩子安装过程包在 `{ …; } 2>/dev/null || true` 里
- 开头检查 bash 版本；`BASH_VERSINFO[0] < 4` 时只安装最基本的 `PROMPT_COMMAND` 钩子（放弃 `cmd` 上报，保留 CWD 与 prompt 状态）
- 脚本里所有变量与函数名统一 `__webterm_` 前缀，避免污染用户命名空间
- **绝不能让 shell 启动失败**。宁可没有集成，也不能没有终端

### 4.6 握手

脚本加载完成的最后一步发 `OSC 1701;hello;1`。agent 10 秒内没收到就把 `integration` 标记为 `inactive`（AC-7.6）。

---

## 5. agent 侧 OSC 解析器要求

`internal/oscparse` 是一个**流式状态机**，必须满足：

| 要求 | 说明 |
|---|---|
| 任意分片 | 序列可能被 `PTY.Read()` 切在**任何一个字节**上。解析器跨调用保持状态 |
| 两种终止符 | `BEL`（`0x07`）与 `ST`（`ESC \`）都必须识别 |
| 只剥离我们关心的 | 仅剥离 OSC `133` / `7` / `1701`。**其它 OSC（0/1/2 标题、8 超链接、52 剪贴板…）必须原样透传**，否则会破坏终端功能 |
| 负载上限 | 单个 OSC 负载上限 **8 KiB**。超限则放弃该序列：把已缓冲的字节**原样输出**并回到正常状态（不能吞掉数据） |
| 畸形容错 | 参数格式错误、base64 解码失败、缺少分隔符 → 剥离该序列但不产生事件，记 debug 日志，不崩溃 |
| 不误吞 | 遇到 `ESC ]` 后如果后续字节表明这不是我们关心的 OSC，必须把已缓冲的字节完整吐出 |
| 零拷贝倾向 | 无 OSC 的常见路径（绝大多数字节）不应产生额外分配 |

**关键不变式**：剥离必须在环形缓冲 `append` 之前完成，`out_seq` 在剥离**之后**计数（[ADR-0006](../20-architecture/adr/0006-agent-side-osc-parsing.md)）。

必测用例（AC-7.5）：

```
UT-osc-2  完整序列一次读入
UT-osc-3  序列被切成 N 份（对每个字节位置都切一次，逐一验证）
UT-osc-4  ST 终止符 vs BEL 终止符
UT-osc-5  超长负载 → 原样吐出
UT-osc-6  畸形 base64 → 剥离但无事件
UT-osc-7  OSC 0/8/52 原样透传
UT-osc-8  ESC ] 后跟无关内容 → 完整吐出
UT-osc-9  剥离后 out_seq 与输出字节数严格一致
```

---

## 6. 已知限制

### 命令输出中的 OSC 序列无法区分

如果命令输出里恰好包含 `ESC]133;D;0 BEL`（例如 `cat` 一个含这些字节的文件，或 `docker logs` 里有别的终端的输出），agent 会把它当成真的命令结束标记，导致：

- 输入模式误切到 Composer
- 命令记录的耗时和退出码错误

**无法根本解决**（这是 OSC 带内信令的固有问题，所有实现 OSC 133 的终端都有这个问题）。缓解：
- `prompt{state}` 的处理带去抖，短时间内的状态反复不触发模式切换
- 影响范围有限且自愈（下一条真实命令会纠正状态）

### 与 tmux 共存

用户可以在会话里手动敲 `tmux`（webterm 自己不用 tmux，见 [ADR-0003](../20-architecture/adr/0003-no-tmux.md)）。但 tmux 默认会**过滤未知的 OSC 序列**，导致集成失效。

用户如需在 webterm 里用 tmux 并保留集成，需要：

```
# ~/.tmux.conf
set -g allow-passthrough on
```

即便如此，tmux 内多 window/pane 的 prompt 状态会混在一条流里，`prompt{state}` 会来回跳。**这属于用户自选的降级路径**，不做保证。

### 不覆盖 shell 替换场景

用户在会话里执行 `exec zsh`、`su`、`docker exec -it` 之后，集成失效。agent 通过"连续 2 个命令周期缺失 OSC 133 标记"检测到并把 `integration` 改回 `inactive`。

---

## 7. 未来（不在 v0.1）

- **zsh 支持**（v0.2）：`preexec`/`precmd` 钩子天然存在，比 bash 干净很多。同一套 OSC 协议，只需要新写一份脚本
- **补全支持**：Composer 里按 Tab 时向 agent 请求 shell 补全。需要新的控制消息与一条独立的补全通道（不能污染主 PTY）
- **命令块视图**（v0.2）：`command.start/end` 已携带 `out_seq`，协议无需改动
