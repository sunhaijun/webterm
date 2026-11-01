# 排障

> 状态：Accepted

先跑 `webterm doctor --domain term.example.com`。它覆盖下面大部分情况并给出可读诊断。

---

## 证书 / TLS

### 启动时卡在申请证书

按顺序检查：

```bash
sudo systemctl stop webterm
webterm doctor --acme              # 地址、端口，再用 staging 实签一次；失败会说为什么
sudo systemctl start webterm
```

不想停服务就手工看：

```bash
dig +short term.example.com        # 解析结果（IP 模式跳过这条）
curl -s ifconfig.me                # 本机公网 IP
# 两者必须一致
ss -lntp | grep -E ':(80|443)\b'   # 必须为空（除了 webterm 自己）
```

常见原因：

| 现象 | 原因 | 处理 |
|---|---|---|
| `bind: address already in use` | 80 或 443 被占（nginx/apache/caddy） | 停掉它，或改用反代模式（[`install.md`](install.md#反向代理--隧道场景)） |
| `bind: permission denied` | 没有绑特权端口的权限 | `sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm` |
| 升级完行为没变，像是没装上 | 磁盘上是新的，跑着的还是旧进程。`webterm version` 看磁盘，`systemctl show webterm -p ExecMainStartTimestamp` 看进程什么时候起的 | `webterm reload`（会话保留），或 `sudo systemctl restart webterm`。（`install.sh` 现在会自动重启并确认起来了；这条留给手工替换二进制的情况） |
| `webterm update` / `reload` 说「热升级中止」 | 新二进制的预检没过（`journalctl -u webterm -n 50` 里有 `热升级中止` 与原因：schema 不认、二进制不可执行、冻结超时）。此时**运行的仍是旧版本、会话照常** | 修好原因后重跑 `webterm reload`；或接受丢会话 `webterm update --force-restart`（[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)） |
| `webterm reload` 说「不支持热升级或没在跑」 | 运行中的是升级前的老版本，没有控制 socket（`<data-dir>/run/agent.sock`）；老版本不认 `SIGUSR2`（默认动作是终止，别手动发） | 这一次只能重启（会关闭会话）：从 SSH 跑 `webterm update --force-restart`，顺带迁移成系统服务。之后的升级就能热升了 |
| 配对成功但客户端【一直重试连接】 | `/ws` 被 Origin 校验 403。日志里搜 `WebSocket 被拒`，它会打出实际收到的 Origin 和期望值 | 二者不符时确认 `--https-port` 与对外访问用的端口一致 —— 浏览器在非默认端口上发的 Origin 带端口号 |
| `install.sh` 说「找不到 setcap」 | 没装 libcap（`setcap` 在 `/usr/sbin`，普通用户 PATH 里没有 sbin，但脚本会去那儿找） | `sudo apt install libcap2-bin`，或换成 1024 以上的端口 |
| `no viable challenge type found`（最常见）或 `Invalid response from http://...` | CA 连不上本机 —— 80 和 443 上的挑战都没过 | **先查云安全组**（最常漏的一步）：在别的机器上 `curl -sI http://<域名>/`，超时就是没放行。再查本机 `ufw status` |
| 用 Cloudflare 且开着代理（小云朵） | 挑战被 Cloudflare 截住，`Origin` 也会不对 | 该记录设为 DNS only |
| `urn:ietf:params:acme:error:rateLimited` | 撞了 Let's Encrypt 限流 | 失败的验证按小时限（每小时 5 次），等一小时；签发成功的次数按周限（每域名 / 每个 IP 每周 50 张，同一组标识每周 5 张）—— 通常是反复删 `certs/` 造成的，只能等 |
| `这个 CA 不签 IP 证书` / `shortlived` | `--domain` 是 IP，但 ACME 目录里没有 `shortlived` profile | 只有 Let's Encrypt（正式与 staging）签 IP 证书；用了自定义目录就换回去，或改用域名 |
| `暂只支持 IPv4` | `--domain` 给的是 IPv6 字面量 | 用域名（`AAAA` 记录），见 [install.md 的「IP 还是域名」](install.md#ip-还是域名) |
| `公网 IP 是 …，不等于 --domain` | IP 模式下 IP 填错了，或者机器的公网 IP 变了 / 在 NAT 后面 | `./webterm install --domain <新 IP>` 重装；IP 变了设备要重新配对 |
| DNS 解析到别的 IP | 记录没生效或指错了 | 等 TTL 过期；确认改的是 A/AAAA 而不是 CNAME 到别处 |

> 安装脚本在首次安装时会先用 staging 实签一次（`webterm doctor --acme`），过不了就不启动服务，
> 所以正式环境一般撞不上限流。手工部署也先跑它。

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

`issuer` 里带 `STAGING` 说明正式服务在发 staging 证书（没有客户端信任它）。
**ADR-0042 之后不会再发生**：staging 证书放在 `certs-staging/`，与 `certs/` 分开。
但**升级前**用 `--acme-staging` 跑过的机器，`certs/` 里可能还留着一张 —— autocert
判断缓存证书是否可用时只看有效期、域名、私钥匹配，**不看签发者**，所以它会一直被用到
快过期才续。手工删掉：

```bash
sudo systemctl stop webterm
rm -f <data-dir>/certs/<域名>*
sudo systemctl start webterm
```

### 证书没自动续期

autocert 在到期前 `min(30 天, 有效期/3)` 自动续期（LE 的 90 天证书就是提前 30 天），
续期要重新过一次域名验证，**80 或 443 有一个从公网可达就够**
（HTTP-01 走 80，TLS-ALPN-01 走 443，两条都是通的）。

所以"后来把 80 在安全组里关了"不会导致续期失败。真会出事的是**两条路一起断**：
机器挪到了 NAT 后面、公网 IP 变了但 DNS 没跟、或者给 Cloudflare 开了小云朵。

完整的前提与验证办法见 [install.md 的「证书续期」](install.md#证书续期)。检查：

```bash
journalctl -u webterm | grep -i acme
ss -lntp | grep -E ':(80|443)\b'   # webterm 应该在监听
dig +short <域名>                   # 应当等于 curl -s ifconfig.me
```

### IP 模式：证书过期了 / 状态总览里证书标黄

IP 证书只有 6 天期，约 4 天续一次，**只走 80 上的 HTTP-01**（[ADR-0042](../20-architecture/adr/0042-ip-address-certificates.md)）。
标黄（剩不到 40 小时）说明续期已经失败了十几次：

```bash
journalctl -u webterm --since "2 days ago" | grep -i 'IP 证书'
```

最常见的是 80 被关了（安全组改过、或者把 ufw 规则删了）。域名模式下关 80 没事，IP 模式下不行。

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
systemctl status webterm                # 服务在跑吗
curl -I https://term.example.com/healthz  # 从外部能到吗
journalctl -u webterm -n 50
```

### 服务退出登录后就停了

还是迁移前的**用户服务**，而且没做 linger。系统服务不会这样（[ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md)）。
从 SSH 迁移一次就好：

```bash
webterm update --force-restart     # 会关闭所有会话，见 systemd.md「从用户服务迁移」
```

### 会话里 `systemctl --user` 报 `Failed to connect to bus`

| 原因 | 处理 |
|---|---|
| 没做 linger：最后一个登录会话一结束，logind 就停掉了用户管理器，`/run/user/<uid>/bus` 跟着没了 | `sudo loginctl enable-linger $USER`，然后 `sudo systemctl start user@$(id -u).service` |
| 手写的系统单元漏了 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS`（会话里 `echo $XDG_RUNTIME_DIR` 是空的） | 照 [`systemd.md`](systemd.md#etcsystemdsystemwebtermservice) 补上，uid 写字面值，不能写 `%U`；`sudo systemctl restart webterm` |

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

### 切回或重连之后，画面整个重画了一下

断线或切走期间的输出超出了环形缓冲（默认 256 KiB），agent 改发了一份快照（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)）：浏览器清屏后按快照重画，回看位置回到底部。内容是完整的，不会缺。刷新页面、改列数（转屏、改窗口宽度）也一定走快照。

经常在短暂断线后看到它，就加大缓冲，让更多情况走增量：

```
--ring-bytes 1048576      # 1 MiB
```

代价是内存（`会话数 × ring-bytes`）。

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

肉眼信号是等价的：往上拖真的能拖动。

- ① 没输出：`--no-altscreen-compat` 开着，或你自己的环境里已经设过同名变量（**我们不覆盖用户的值**）。
- ① 有、② 仍是 `true`：上游换了实现或变量名（这些是**私有开关，没有兼容承诺**）。用 `--session-env` 补上新的变量名，或接受备用屏的行为。
- ② 是 `false` 但还是拖不动：看是不是终端里正跑着别的全屏程序（vim / less / htop）。

> **别用 `script -c claude` 抓 `ESC[?1049h` 来验。** 实测：`script` 里拿不到 winsize 时 claude 自己就退回 classic 渲染器（`?1049h` 0 次），抓到的 0 不代表你那个会话里是 0。
- **刷新后能往回滚多远**由 agent 的快照决定：至多 2000 行（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)）。不刷新的话，浏览器自己留着 5000 行。

不想要这套兼容（比如就是喜欢钉在底部的输入框）：`--no-altscreen-compat`。

### 连接总是很快被断开（正常用着突然掉）

有界队列保护触发了（[协议 §5.6](../30-protocol/websocket-protocol.md#56-有界队列策略读写两侧)）。看日志区分是哪一侧：

| 日志 | 含义 | 处理 |
|---|---|---|
| `conn queue full` | 输出侧：客户端网络太慢而输出太快 | 减少输出量；断开后会自动重连（走增量或快照），不丢画面 |
| `input_stalled` | 输入侧：某个会话的前台程序长时间不读 stdin，PTY 写不进去 | 看那个会话在跑什么（`Ctrl+C` 或关掉它）。这是保护措施 —— 不这样做的话整条连接的所有会话都会一起卡住 |

---

## 会话

### 会话全没了

agent 持有 PTY，进程一死 shell 就收到 `SIGHUP`（[ADR-0003](../20-architecture/adr/0003-no-tmux.md)）。热升级不会这样（[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)），所以全没了一定是进程真的死过。先看是哪一种：

```bash
systemctl show webterm -p NRestarts -p ExecMainStartTimestamp   # 自动重启过几次、这次什么时候起的
sudo journalctl -u webterm | grep -iE 'oom|Main process exited|Stopping'
```

| 记录 | 是什么 | 处理 |
|---|---|---|
| `Stopping webterm.service` | 有人 `systemctl restart/stop`，或者 `webterm update --force-restart` | 预期行为。升级用 `webterm update`，会话保留 |
| `killed by the OOM killer` / `Failed with result 'oom-kill'` | 内存耗尽，内核杀了 agent | 看单元是不是 ADR-0034 的系统服务（`systemctl cat webterm` 里有 `OOMScoreAdjust=-900`）。**还是用户服务的话**，agent 的优先级是 200，内存一紧就先被杀 —— 从 SSH 跑 `webterm update --force-restart` 迁移。已经是系统服务还被杀，说明机器内存确实不够 |
| `Main process exited, code=killed`（不带 oom） | 崩溃或者被 `kill -9` | 提 bug，附上前后 200 行日志 |

systemd 的这些记录在系统日志里，所以要 `sudo`。`journalctl -u webterm` 不加 sudo 只能看到 agent 自己写的那部分。

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

- 在**文本输入页**里应该完全正常（原生 textarea）—— 长段中文就用它
- **终端直输**靠内联预览浮层。如果浮层位置不对，附上截图报 bug

### 无法安装到主屏

需要 HTTPS（secure context）。`--dev` 的 `http://localhost` 在桌面可以，但手机访问局域网 IP 的 http **不是** secure context，装不了。必须用正式域名。

---

## 数据

### 想看数据库里有什么

```bash
sqlite3 ~/.local/share/webterm/webterm.db '.tables'
sqlite3 ~/.local/share/webterm/webterm.db 'SELECT id, name, last_seen_at, revoked_at FROM devices;'
```

### 忘了配对，所有设备都吊销了

在服务器上跑 `webterm pair` 重新生成配对码。这是"必须能访问服务器终端"的场景 —— 也正是 v0.2 的 Passkey 想要填补的缺口。

---

## 提 bug 需要附上

```bash
webterm version
webterm doctor --domain <你的域名>
bash --version
journalctl -u webterm -n 200 --no-pager
```

外加浏览器控制台的报错、机型/OS/浏览器版本。**如果是"打字没反应"这类**，再附一份控制台里的 `__webterm.inputStats()`（**卡住的当下**取，不要事后补）—— 它按段说明输入断在哪一层，见下面的《打字没反应：先看输入断在哪一段》。

日志里不含敏感数据（配对码、Cookie、用户输入、终端输出均不记录），可以直接贴。

## 拖动到底变空白

- xterm 的内部滚动容器 `.xterm-viewport` 要 `overscroll-behavior: contain`，否则手机上拖到底再拖会把整页橡皮筋拽成空白。

## 一点输入，输入框就被键盘推得看不见（iPhone）

**现象**：点终端或在文本输入页里点输入框，软键盘弹出的同时整个页面被"上推"，附加键和输入框（甚至整个应用）不在屏幕上。

**根因**：iOS Safari 弹键盘只缩【可视视口】不缩布局视口，并把可视区上推（`visualViewport.offsetTop` > 0）去露出输入框；应用要 `translateY(offsetTop)` 跟过去。而 Safari 的 `window.innerHeight` 报的是可视视口高度 —— 键盘一弹它也变矮，若用它做"键盘是否弹起"的参照，闸门永远关着、不补偿。参照必须是 `documentElement.clientHeight`（布局视口），见 [`../40-frontend/layout.md`](../40-frontend/layout.md)。

**排查**：在 Safari 的 Web Inspector 里聚焦输入框后看 `document.querySelector('.app').style.transform` —— 键盘弹起时应为 `translateY(<offsetTop>px)`；为空即闸门没开，对比 `visualViewport.height`、`document.documentElement.clientHeight`、`window.innerHeight` 三个数。

## 输出显示不对：先分清是哪条路

输出只有两条路（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)）：**增量**（原始字节原样转发）和**快照**（agent 的终端模拟器导出的完整画面）。浏览器开发者工具 → Network → WS 看帧：二进制帧首字节 `01` 是增量（OUTPUT），`03` 是快照（SNAPSHOT）。

| 现象 | 多半是 |
|---|---|
| 只在切回 / 重连 / 刷新 / 转屏之后不对 | 快照那条路。记下当时在跑的程序，附上 `webterm version` 报 bug —— 快照的口径是「先吃快照再吃之后的字节」逐格等于「直接吃全部字节」 |
| 一直开着、没断过也不对 | 增量那条路就是程序的原始输出，和本机终端应当一致；先在本机同尺寸的 xterm 系终端里复现 |
| top 表头最右一格少了反白 / 上划线不显示 | 已知差异：前者是 xterm.js 在行尾「擦到行尾」时和其它终端不同，后者是快照不带 SGR 53。程序重画那一格后恢复 |
| 只改了行数（软键盘弹出收起）之后画面错了几行 | 已知：只改行数不重发快照，两边各自调整的结果可能不同。程序收到 SIGWINCH 重画后收敛，或者切走再切回 |
| 中文标点（。…—“”）偶尔不见 | xterm.js 写 `Uint8Array` 时切开的 UTF-8 会丢字，前端必须先用流式 `TextDecoder` 解码。再出现就是这条被改坏了 |

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
| `data` 涨、`sent` 不涨 | 没发出去（看 `gated` 与连接状态） | 看顶部有没有连接横幅（重连中 / 离线） |
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
