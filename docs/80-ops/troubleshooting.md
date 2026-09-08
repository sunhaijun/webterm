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
| 一直不切到 Raw | 集成未生效，或者用户手动锁定了模式（点"解锁自动"） |
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

外加浏览器控制台的报错、机型/OS/浏览器版本。

日志里不含敏感数据（配对码、Cookie、命令原文、终端输出均已脱敏），可以直接贴。
