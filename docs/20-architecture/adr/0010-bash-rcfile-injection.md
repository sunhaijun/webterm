# ADR-0010 通过临时 rcfile 注入 shell 集成

> 状态：Accepted · 2026-09-06

## 背景

shell 集成是 v0.1 的必需项（它同时支撑命令历史、CWD 上报、输入模式自动切换 —— 见 [ADR-0007](0007-dual-mode-input.md)）。

传统做法是让用户往 `~/.bashrc` 里加一行 `eval "$(webterm shell-init bash)"`。但这有几个问题：

- 需要用户手动配置，安装体验不再是"跑起来就行"
- 用户改了 dotfile 之后，webterm 卸载了这行还在
- 多版本 agent 与 rc 里的脚本版本可能不匹配

## 决策

**agent 启动会话时生成一个临时 rcfile，用 `bash --rcfile <path> -i` 启动。用户不需要修改任何 dotfile。**

```go
cmd := exec.Command("bash", "-i", "--rcfile", rcPath)
```

## 关键细节：正确模拟 bash 的初始化语义

`--rcfile` 只影响**交互式非登录** shell。登录 shell 读 `~/.bash_profile` 并**忽略** `--rcfile`。所以不能简单地加 `-l`。

生成的 rcfile 按模式做不同的事：

```bash
if [ "$__WEBTERM_LOGIN" = 1 ]; then
    # 登录模式：走 profile 链，取第一个存在的
    [ -r /etc/profile ] && . /etc/profile
    for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
        [ -r "$f" ] && { . "$f"; break; }
    done
else
    # 非登录模式：只走 bashrc
    [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
    [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
fi

__webterm_install_hooks    # 必须在用户配置之后
```

**注意登录模式下我们不额外 source `~/.bashrc`。** 这不是遗漏，而是刻意的：

- 绝大多数人的 `~/.bash_profile` 里都有 `. ~/.bashrc`，所以它会被加载
- 如果某人的 `.bash_profile` 故意不 source `.bashrc`，那正是 bash 登录 shell 的真实语义，我们应该遵守
- **这样就完全避免了 `.bashrc` 被重复加载**（重复 source 常导致 PATH 重复、别名重复定义、prompt 被叠加）

**默认用登录模式**，因为用户是从 `ssh host` 迁移过来的，而 `ssh host` 给的就是登录 shell。若不这样，用户在 `~/.bash_profile` 里设的 PATH 会突然消失，这是无法接受的回归。提供 `--no-login-shell` 开关。

## 钩子必须安装在用户配置之后

这是上面代码顺序的原因。`__webterm_install_hooks` 需要**包装**而不是覆盖用户已有的配置：

- `PS1`：在前后追加 OSC 133 A/B 标记，保留原有内容
- `PROMPT_COMMAND`：追加我们的函数，不覆盖（bash 5.1+ 支持数组形式，需要分别处理）
- `DEBUG` trap：如果已有 trap，链式调用，不替换

即便如此，用户配置仍可能在 prompt 渲染时动态重写 `PS1`（比如某些主题框架）。所以我们的 precmd 函数每次都**重新断言**标记存在，而不是只在安装时设一次。

## 备选方案与否决理由

### A. 要求用户改 `~/.bashrc`

**否决**：破坏"跑起来就行"的安装体验，且留下卸载残留。仍然作为**降级方案**保留 —— `webterm shell-init bash` 子命令输出脚本，供特殊环境（用户用 `exec` 换了 shell、用容器、用 `su` 切用户）手动接入。

### B. 通过环境变量注入（`BASH_ENV` / `PROMPT_COMMAND`）

**否决**：`BASH_ENV` 只对非交互 shell 生效。从环境继承 `PROMPT_COMMAND` 会被用户的 `.bashrc` 覆盖。

### C. 启动后往 PTY 里写入脚本

**否决**：会在用户屏幕上留下痕迹，且时序不可靠（不知道 shell 什么时候准备好读输入）。

### D. 临时 rcfile（采纳）

## 后果

**正面**：
- 零手工配置。安装体验保持为"scp + 跑"
- 脚本版本与 agent 版本天然同步（脚本 `go:embed` 在二进制里）
- 卸载 agent 就干净了，不留残留

**负面**：
- 需要正确处理 bash 初始化语义的所有分支（上面已展开）。这块必须有集成测试覆盖（AC-7.3）。
- rcfile 是临时文件，需要处理：
  - 权限 `0600`，放在 agent 的运行时目录而不是 `/tmp`（避免同机其他用户读取，避免 `/tmp` 清理策略干扰）
  - 会话结束后删除；agent 崩溃残留的文件在下次启动时清理
  - `$BASH_ENV` 等可能干扰的变量在启动 PTY 前清理
- **无法覆盖用户在会话内 `exec zsh` / `su` / 进容器的情况**。这时集成失效，agent 通过"10 秒内没收到 `OSC 1701;hello`"检测到并标记 `integration: inactive`，UI 显示降级提示（AC-7.6）。

## 集成失败必须不影响可用性

rcfile 里所有 webterm 相关逻辑都包在函数里并且容错。脚本出错（语法错误、bash 版本太老）绝对不能导致 shell 启动失败 —— 宁可没有集成，也不能没有终端（AC-7.7）。

具体做法：把钩子安装包在 `{ ... } 2>/dev/null || true` 里，并在脚本开头检查 bash 版本（需要 4.4+ 才有可靠的 `PS0`；更老的版本退化为只用 `DEBUG` trap + `PROMPT_COMMAND`）。
