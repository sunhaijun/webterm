# 排障

> 状态：Accepted

先跑 `webterm doctor --domain term.example.com`。它覆盖下面大部分情况并给出可读诊断。

---

## 证书 / TLS

### 启动时卡在申请证书

按顺序检查：

```bash
dig +short term.example.com        # 解析结果
curl -s ifconfig.me                # 本机公网 IP
# 两者必须一致
ss -lntp | grep -E ':(80|443)\b'   # 必须为空（除了 webterm 自己）
```

常见原因：

| 现象 | 原因 | 处理 |
|---|---|---|
| `bind: address already in use` | 80 或 443 被占（nginx/apache/caddy） | 停掉它，或改用反代模式（[`install.md`](install.md#反向代理--隧道场景)） |
| `bind: permission denied` | 没有绑特权端口的权限 | `sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm` |
| 升级完行为没变，像是没装上 | 磁盘上是新的，跑着的还是旧进程。`webterm version` 看磁盘，`systemctl --user show webterm -p ExecMainStartTimestamp` 看进程什么时候起的 | `systemctl --user restart webterm`。（`install.sh` 现在会自动重启并确认起来了；这条留给手工替换二进制的情况） |
| `webterm update` / `reload` 说「热升级中止」 | 新二进制的预检没过（`journalctl --user -u webterm -n 50` 里有 `热升级中止` 与原因：schema 不认、二进制不可执行、冻结超时）。此时**运行的仍是旧版本、会话照常** | 修好原因后重跑 `webterm reload`；或接受丢会话 `webterm update --force-restart`（[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)） |
| `webterm reload` 说「不支持热升级或没在跑」 | 运行中的是升级前的老版本，没有控制 socket（`<data-dir>/run/agent.sock`）；老版本不认 `SIGUSR2`（默认动作是终止，别手动发） | 这一次只能 `systemctl --user restart webterm`（会关闭会话）；之后的升级就能热升了 |
| 配对成功但客户端【一直重试连接】 | `/ws` 被 Origin 校验 403。日志里搜 `WebSocket 被拒`，它会打出实际收到的 Origin 和期望值 | 二者不符时确认 `--https-port` 与对外访问用的端口一致 —— 浏览器在非默认端口上发的 Origin 带端口号 |
| `install.sh` 说「找不到 setcap」 | 没装 libcap（`setcap` 在 `/usr/sbin`，普通用户 PATH 里没有 sbin，但脚本会去那儿找） | `sudo apt install libcap2-bin`，或换成 1024 以上的端口 |
| `no viable challenge type found`（最常见）或 `Invalid response from http://...` | CA 连不上本机 —— 80 和 443 上的挑战都没过 | **先查云安全组**（最常漏的一步）：在别的机器上 `curl -sI http://<域名>/`，超时就是没放行。再查本机 `ufw status` |
| 用 Cloudflare 且开着代理（小云朵） | 挑战被 Cloudflare 截住，`Origin` 也会不对 | 该记录设为 DNS only |
| `urn:ietf:params:acme:error:rateLimited` | 撞了 Let's Encrypt 限流 | 等（每域名每周 50 次签发）。**先用 `--acme-staging` 调通再上正式** |
| DNS 解析到别的 IP | 记录没生效或指错了 | 等 TTL 过期；确认改的是 A/AAAA 而不是 CNAME 到别处 |

> **教训**：第一次部署**永远先用 `--acme-staging`**。正式环境的限流窗口是一周，撞上了只能等。

### 日志里一堆 `TLS handshake error`

**默认不会再出现了**（会记到 DEBUG）。webterm 的端口对整个互联网开放，
扫描器会持续制造这类行 —— 拿 IP 直连没有 SNI、发纯 HTTP、连上不说话到超时，
每一种都是一行。要看就加 `--log-level debug`。

判断是不是自己的问题：看 IP。反复用不同方式探同一个端口的、云厂商网段的
（GCP / DigitalOcean 之类），都是扫描器。

其中 `remote error: tls: unknown certificate` 里的 `remote error` 表示
**警告是对端发来的**，也就是客户端拒绝了我们的证书。来自扫描器可以无视；
如果是你自己的设备，在别的机器上跑这条看服务的到底是什么证书：

```bash
echo | openssl s_client -connect <域名>:<端口> -servername <域名> 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

`issuer` 里带 `STAGING` 说明还在用 `--acme-staging` 签出来的证书（没有客户端
信任它）。**去掉 `--acme-staging` 重启不会自动换掉它** —— autocert 判断缓存
证书是否可用时只看有效期、域名、私钥匹配，**不看签发者**，而 staging 与正式
用的是同一个缓存 key。必须手工删掉：

```bash
systemctl --user stop webterm
rm -f <data-dir>/certs/<域名>*
systemctl --user start webterm
```

### 证书没自动续期

autocert 在到期前 `min(30 天, 有效期/3)` 自动续期（LE 的 90 天证书就是提前 30 天），
续期要重新过一次域名验证，**80 或 443 有一个从公网可达就够**
（HTTP-01 走 80，TLS-ALPN-01 走 443，两条都是通的）。

所以"后来把 80 在安全组里关了"不会导致续期失败。真会出事的是**两条路一起断**：
机器挪到了 NAT 后面、公网 IP 变了但 DNS 没跟、或者给 Cloudflare 开了小云朵。

完整的前提与验证办法见 [install.md 的「证书续期」](install.md#证书续期)。检查：

```bash
journalctl --user -u webterm | grep -i acme
ss -lntp | grep -E ':(80|443)\b'   # webterm 应该在监听
dig +short <域名>                   # 应当等于 curl -s ifconfig.me
```

### 443 已经被别的服务占了

启动会拿到 `bind: address already in use`。换个端口就行：

```bash
webterm serve --domain term.example.com --https-port 8443
```

**证书照旧自动申请与续期** —— 走 80 上的 HTTP-01（CA 只连 80 和 443，不会连 8443）。
配对 URL 与二维码会自动带上 `:8443`，扫码就能直接打开。`webterm pair` 是独立进程，
记得给它带同一个 `--https-port`。

详见 [install.md 的「跑在非标准端口上」](install.md#跑在非标准端口上)。

### 启动时报"`--http-port` 和 `--https-port` 不能相同"

它们是两个独立监听：ACME 挑战与 HTTPS 跳转走 `--http-port`，HTTPS 服务走
`--https-port`。写成同一个值会被直接拒绝。

### `certs/` 丢了

会重新申请。注意限流 —— 所以 `certs/` 值得备份（[`install.md`](install.md#数据与备份)）。

---

## 连接问题

### 浏览器打不开

```bash
systemctl --user status webterm         # 服务在跑吗
curl -I https://term.example.com/healthz  # 从外部能到吗
journalctl --user -u webterm -n 50
```

### 服务退出登录后就停了

没做 linger：

```bash
sudo loginctl enable-linger $USER
systemctl --user enable --now webterm
```

这是 user service 最常见的坑。

### WebSocket 连不上（页面能开，终端一直"重连中"）

| 检查 | 说明 |
|---|---|
| 浏览器控制台的 WS 错误码 | `401` = 认证问题（Cookie 丢了？设备被吊销了？）；`403` = Origin 不匹配；`503` = 并发连接数超过 `--max-conns` |
| `403` | `--domain` 的值必须与浏览器地址栏的域名完全一致 |
| 连上了但立刻被关，日志有 `protocol_unsupported` | agent 与前端版本不匹配。刷新页面（Service Worker 可能缓存了旧前端）；仍不行则确认二进制里的前端是新构建的 |
| 反代场景下连不上 | 代理是否传递了 `Upgrade` / `Connection` 头 |

### 每 60 秒断一次

反向代理的读超时。nginx 默认 60s：

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

webterm 自己的心跳是 30 秒一次，所以正常情况下不会触发 60s 空闲超时 —— 如果仍然每 60 秒断，说明代理配置没生效或者中间还有一层。

### 频繁"历史输出已截断"

断线期间的输出超过了环形缓冲。加大它：

```
--ring-bytes 4194304      # 4 MiB
```

代价是内存（`会话数 × ring-bytes`）。20 会话 × 4 MiB = 80 MiB。

### 往回拖不动 / 刷新后只剩最后一屏

先分清是哪一类。**全屏程序（备用屏）根本没有 scrollback** —— vim / less / htop 是这样，本机终端里也一样，那些"历史"在程序自己手里。webterm 默认会把已知的 AI CLI 拉回主屏（AC-7.8），让它的输出变成可以回滚的追加流。

确认这条兼容生效没有，两步，从便宜的开始：

```bash
# ① 变量有没有注入到会话 —— 在 webterm 的终端里跑
env | grep CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN     # 有输出 = 注入到位
```

```js
// ② 程序有没有真的留在主屏 —— 浏览器控制台
__webterm.altScreen()      // false = 在主屏（生效）；true = 还在备用屏
```

肉眼信号是等价的：底部键条没有切成 TUI 那一档，且往上拖真的能拖动。

- ① 没输出：`--no-altscreen-compat` 开着，或你自己的环境里已经设过同名变量（**我们不覆盖用户的值**）。
- ① 有、② 仍是 `true`：上游换了实现或变量名（这些是**私有开关，没有兼容承诺**）。用 `--session-env` 补上新的变量名，或接受备用屏的行为。
- ② 是 `false` 但还是拖不动：看是不是终端里正跑着别的全屏程序（vim / less / htop）。

> **别用 `script -c claude` 抓 `ESC[?1049h` 来验。** 实测：`script` 里拿不到 winsize 时 claude 自己就退回 classic 渲染器（`?1049h` 0 次），抓到的 0 不代表你那个会话里是 0。
- **刷新后能往回滚多远**由客户端快照决定（2000 行，[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §3）；再往前的历史只能靠 `--ring-bytes` 的字节窗口，它按字节算而不是按行算。

不想要这套兼容（比如就是喜欢钉在底部的输入框）：`--no-altscreen-compat`。

### 连接总是很快被断开（正常用着突然掉）

有界队列保护触发了（[协议 §5.5](../30-protocol/websocket-protocol.md#55-有界队列策略读写两侧)）。看日志区分是哪一侧：

| 日志 | 含义 | 处理 |
|---|---|---|
| `conn queue full` | 输出侧：客户端网络太慢而输出太快 | 加大 `--conn-queue-bytes`，或减少输出量 |
| `input_stalled` | 输入侧：某个会话的前台程序长时间不读 stdin，PTY 写不进去 | 看那个会话在跑什么（`Ctrl+C` 或关掉它）。这是保护措施 —— 不这样做的话整条连接的所有会话都会一起卡住 |

---

## shell 集成

### 界面提示"shell 集成未生效"

诊断顺序：

```bash
bash --version
```

| 原因 | 现象 | 处理 |
|---|---|---|
| bash < 4.0 | 集成降级：只有 CWD 与 prompt 状态，没有命令原文 | 升级 bash，或接受降级（终端仍可用） |
| bash < 4.4 | 集成正常，但 Composer 的**多行**提交会被逐行执行（readline 没有 bracketed paste） | 升级 bash，或分多次提交 |
| 会话里 `exec zsh` / `su` / 进了容器 | 集成在替换后失效 | 预期行为。在新 shell 里手动 `eval "$(webterm shell-init bash)"` |
| 用户的 prompt 主题重写 `PS1` | 命令记录缺失或 prompt 状态不准 | 我们每次 precmd 都重新断言标记；如果仍失效，把主题初始化放在 `.bashrc` 更早的位置 |
| 会话里跑了 tmux | tmux 过滤未知 OSC | `set -g allow-passthrough on`（[shell-integration.md](../30-protocol/shell-integration.md#与-tmux-共存)） |
| `--no-shell-integration` 开着 | | 去掉这个参数 |

**注意：集成失效不影响终端可用性**（AC-7.7）。丢的只有命令历史、CWD 显示和输入模式自动切换。

### 命令历史里少了一些命令

| 原因 | 说明 |
|---|---|
| 命令以空格开头 | **这是刻意的隐私设计**（[privacy-history.md](../60-security/privacy-history.md#空格前缀规则ac-62--us-67)） |
| `--no-history` 开着 | 或 UI 里关了历史记录 |
| 用户的 `HISTCONTROL` 设了 `ignoredups` / `ignoreboth` | 重复命令不进 bash 历史 → 我们也拿不到。这是 bash 行为，不是 bug |
| `HISTSIZE=0` | bash 完全不记历史，我们的 `history 1` 拿不到东西 |

### 输入模式切换不对 / 闪烁

| 现象 | 原因 |
|---|---|
| 一直不切到 Raw | 集成未生效：没有数据源，固定在 Composer（见降级横幅）。ADR-0013 起没有手动模式开关 |
| 模式来回跳 | 命令输出里含 OSC 133 序列（比如 `cat` 一个含这些字节的文件）。**固有限制**，见 [shell-integration.md](../30-protocol/shell-integration.md#6-已知限制) |
| 短命令时闪一下 Raw | 去抖失效。正常应该有 120ms 去抖 —— 报 bug |

---

## 会话

### 升级/重启后会话全没了

**预期行为**（[ADR-0003](../20-architecture/adr/0003-no-tmux.md)）。agent 持有 PTY，进程重启则 shell 收到 `SIGHUP`。

命令历史存在 SQLite 里，跨重启存活。

### "会话数已达上限"

关掉不用的会话，或者加大：`--max-sessions 40`。

### 会话里的程序在关闭会话后还在跑

不应该发生 —— 关闭时先让 bash 把 SIGHUP 转发给所有作业，兜底再按会话清扫一遍（[session-manager.md](../50-backend/session-manager.md#关闭)）。如果发生了：

```bash
ps -eo pid,pgid,sid,ppid,cmd | grep <进程名>
```

看 `sid`：如果它和别的进程不在同一个会话里，说明它主动 `setsid` 脱离了。带 `nohup` / `setsid` / `systemd-run` 启动的进程就是这样，那是用户主动的行为，符合预期。其它情况请报 bug。

---

## 移动端

### 软键盘遮住输入框 / 布局跳动

在 iOS 上多见。确认：

- 用的是 PWA（加到主屏）还是浏览器标签页？**PWA 下行为更稳定**
- iOS 版本 ≥ 16
- 报 bug 时附上 iOS 版本、机型、横竖屏状态

### 中文输入法候选框位置不对

- 在 **Composer 模式**下应该完全正常（原生 textarea）
- 在 **Raw 模式**下靠内联预览浮层。如果浮层位置不对，附上截图报 bug

### 无法安装到主屏

需要 HTTPS（secure context）。`--dev` 的 `http://localhost` 在桌面可以，但手机访问局域网 IP 的 http **不是** secure context，装不了。必须用正式域名。

---

## 数据

### 想看数据库里有什么

```bash
sqlite3 ~/.local/share/webterm/webterm.db '.tables'
sqlite3 ~/.local/share/webterm/webterm.db 'SELECT text, exit_code, started_at FROM commands ORDER BY started_at DESC LIMIT 20;'
```

### 数据库文件变得很大

历史上限默认 5 万条。检查：

```bash
sqlite3 ~/.local/share/webterm/webterm.db 'SELECT count(*) FROM commands;'
```

淘汰后空间不会自动回收，手动整理：

```bash
systemctl --user stop webterm
sqlite3 ~/.local/share/webterm/webterm.db 'VACUUM;'
systemctl --user start webterm
```

### 忘了配对，所有设备都吊销了

在服务器上跑 `webterm pair` 重新生成配对码。这是"必须能访问服务器终端"的场景 —— 也正是 v0.2 的 Passkey 想要填补的缺口。

---

## 提 bug 需要附上

```bash
webterm version
webterm doctor --domain <你的域名>
bash --version
journalctl --user -u webterm -n 200 --no-pager
```

外加浏览器控制台的报错、机型/OS/浏览器版本。**如果是"打字没反应"这类**，再附一份控制台里的 `__webterm.inputStats()`（**卡住的当下**取，不要事后补）—— 它按段说明输入断在哪一层，见下面的《打字没反应：先看输入断在哪一段》。

日志里不含敏感数据（配对码、Cookie、命令原文、终端输出均已脱敏），可以直接贴。

## 底栏盖住终端 / 拖动到底变空白（读态布局）

- 给元素设 `display`（如 `.bar{display:flex}`）会压过 `hidden` 属性的 UA `display:none` —— 隐藏的直发提示行仍占 56px，把终端最后几行盖住。用全局 `[hidden]{display:none!important}` 兜住。
- xterm 的内部滚动容器 `.xterm-viewport` 要 `overscroll-behavior: contain`，否则手机上拖到底再拖会把整页橡皮筋拽成空白。

## 一点输入，输入框就被键盘推得看不见（iPhone）

**现象**：读视图点 Composer、或终端视图点「⌨ 打字」，软键盘弹出的同时整个页面被"上推"，输入框（甚至整个应用）不在屏幕上。

**根因**：iOS Safari 弹键盘只缩【可视视口】不缩布局视口，并把可视区上推（`visualViewport.offsetTop` > 0）去露出输入框；应用要 `translateY(offsetTop)` 跟过去。而 Safari 的 `window.innerHeight` 报的是可视视口高度 —— 键盘一弹它也变矮，若用它做"键盘是否弹起"的参照，闸门永远关着、不补偿。参照必须是 `documentElement.clientHeight`（布局视口），见 [`../40-frontend/layout-responsive.md`](../40-frontend/layout-responsive.md) §高度计算。

**排查**：在 Safari 的 Web Inspector 里聚焦输入框后看 `document.querySelector('.app').style.transform` —— 键盘弹起时应为 `translateY(<offsetTop>px)`；为空即闸门没开，对比 `visualViewport.height`、`document.documentElement.clientHeight`、`window.innerHeight` 三个数。

## 打字没反应：先看输入断在哪一段

**卡住的当下**在浏览器控制台里敲：

```js
__webterm.inputStats()
```

它按四段给计数和"最近一次发生在多久以前"，`verdict` 直接说断点在哪一段：

| 现象 | 断点 | 怎么办 |
|---|---|---|
| `keydown` 不涨 | 键没进页面 | 焦点在别的窗口 / 被系统层吃掉 |
| `keydown` 涨、`toTerm` 不涨 | 焦点不在终端（`focus` 字段写着在哪） | 点一下终端；这是 bug，请连 `inputStats` 一起提 |
| `toTerm` 涨、`data` 不涨 | 卡在 xterm（多半是组字状态没复位） | 切走再切回或刷新；同样请提 bug |
| `data` 涨、`sent` 不涨 | 没发出去（看 `gated` 与连接状态） | 看状态条是不是"重连中" |
| `sent` 涨、`unackedBytes` 一直不降 | agent 没确认 | 僵尸连接：切到后台再回前台会触发一次探活（2 秒判死重连，[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md) 决策一） |
| **四段全通，程序还是没反应** | **不在 webterm 内** | 前台程序自己不读 stdin，或者它进了别的模式 —— 最常见的是 tmux 的 copy-mode —— **见下一条** |

【按"最近一次发生"看，不要看总量】：总量是页面打开以来的累计，卡住之前那些成功的输入早就把它撑满了。
## 在 tmux 里突然打不进字（滚了一下之后）

**现象**：在 webterm 里跑 tmux，tmux 里跑 claude / codex。滚了一下滚轮（或触屏拖了一下）之后，键盘输入完全没反应；点终端、切会话、刷新页面、断线重连**全都没用**。

**根因**：不是 webterm。tmux 开了 `mouse on` 时，默认根绑定是

```
WheelUpPane → if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -e }
```

pane 里的前台程序那一刻**没开鼠标跟踪**的话，一次滚轮就把它推进 **copy-mode** —— 之后的键全是 copy-mode 命令，不进程序。状态在 **tmux 服务器**里，所以 webterm 这边做什么都不管用。

**确认**：pane 右上角有 `[12/340]` 这种位置指示；或者在别处 `tmux display -p -t <session> '#{pane_in_mode}'`，回 `1` 就是。

**出口**：按 `q` 或 `Esc`。

**注意**：`--no-altscreen-compat` 的默认值（把 claude 拉回 classic 渲染器，[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §1）会让这个坑**变密** —— classic 渲染器不开鼠标跟踪，于是 tmux 里每一次滚轮都会进 copy-mode。在 tmux 里跑 claude 又不想碰这个坑，可以 `tmux set -g mouse off`，或给 webterm 加 `--no-altscreen-compat`（代价是回滚历史没了）。

## claude / codex 跑着，读视图却没有转录卡片

**现象**：进了 claude / codex，读视图是块流的门或空转录视图，尾巴条有输出但没有对话卡片。

**排查顺序**：
1. agent 认出的程序名：`command.start` 的 `text` 最后一段第一个词得是 `claude` / `codex`（`ProgramOf` 规则，包装器 sudo / env 会跳过；别名 / 脚本名不算）
2. 会话文件在哪：Claude Code 写 `~/.claude/projects/<cwd 里非字母数字换成 ->/<session>.jsonl`，Codex 写 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`；agent 只认**命令开始之后被写过**的文件，cwd 对得上的优先。`--resume` 继续旧会话时，第一条新消息落盘后才会被认出
3. home 对不对：agent 用自己进程的 home（systemd 下是 `User=` 的 home）；`WEBTERM_TRANSCRIPT_HOME` 可以指别处
4. `GET /api/transcript?sid=N`：404 = 没跟踪过（程序名没认出）；200 但 `items` 空 = 文件还没被写或没定位到
5. 消息是整块完成才落盘的：正在流式输出时看尾巴条，答完才出卡片
