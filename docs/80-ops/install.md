# 安装与部署

> 状态：Accepted。设计理由见 [ADR-0044](../20-architecture/adr/0044-ip-address-certificates.md)（IP 证书）、[ADR-0045](../20-architecture/adr/0045-install-from-the-binary.md)（安装）、[ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md)（系统服务）。

## 前提

- Linux（x86_64 / arm64），一个能 sudo 的**普通用户**（不要用 root）
- 公网 IPv4。域名可选
- **云安全组放行入方向 TCP 80 和 443**
- 有域名的话：加一条 `A` 记录指向本机公网 IP。不要 CNAME 到别处；用 Cloudflare 要关掉小云朵（DNS only）

## 安装

### 用二进制装（推荐）

不需要 GitHub 凭据。在手边有二进制的机器上：

```bash
scp webterm server:
ssh -t server ./webterm install                              # 用公网 IP
ssh -t server ./webterm install --domain term.example.com    # 用域名
```

`-t` 不能省（中途要输 sudo 密码）。手边没有二进制就先下载一个：

```bash
gh release download --repo sunhaijun/webterm --pattern webterm-linux-amd64 -O webterm && chmod +x webterm
```

### 在服务器上从网上装

仓库是私有的，先在服务器上 `gh auth login`：

```bash
gh api repos/sunhaijun/webterm/contents/scripts/install.sh -H 'Accept: application/vnd.github.raw' | bash
# 有域名：… | bash -s -- --domain term.example.com
```

这样会在服务器上留下能访问你所有仓库的 GitHub 凭据。能用上一种方式就用上一种。

### 安装会做什么

放行本机防火墙（ufw / firewalld）→ 签证书 → 装成 systemd 服务并启动 → 打出配对二维码。

**证书签不下来就停在这一步，不装服务。** 最常见的原因是安全组没放行 80。修好之后重跑同一条命令。

### 常用参数

| 参数 | 说明 |
|---|---|
| `--domain <域名或 IPv4>` | 不给：这台机器装过就沿用上次的参数，没装过就用本机公网 IP |
| `--https-port <n>` | 443 被别的服务占了时用，例如 `8443` |
| `--dry-run` | 只打印要执行的命令 |
| `--force` | 签证书没通过也继续装 |
| `--channel dev` | 装 `main` 的滚动构建（只对从网上装有效） |

全部参数：`./webterm install --help`。

## 配对

用手机扫安装最后一屏的二维码，授权就完成了。扫不了的话，在手机浏览器打开 `https://<地址>/pair`，输入屏幕上的 16 位数字。

- 配对码 5 分钟内有效，用过一次就失效
- 再加一台设备：`webterm pair`（在已经配对的设备上开一个会话跑也行）
- 手机浏览器里「添加到主屏幕」，就装成了 PWA

## 检查

```bash
webterm                      # 状态总览：服务、地址、证书、设备
webterm doctor               # 检查前置条件
journalctl -u webterm -f     # 看日志
```

出问题见 [troubleshooting.md](troubleshooting.md)。

## 升级

```bash
webterm update               # 从网上取最新版；热升级，会话保留
```

或者用手边的新二进制：`scp webterm server: && ssh -t server ./webterm install`（沿用上次的参数）。

| 选项 | 说明 |
|---|---|
| `--when-idle` | 等所有会话都没有命令在跑时再升级 |
| `--force-restart` | 重启服务，会关闭所有会话。旧版本 agent、或从用户服务迁移成系统服务时用；**要从 SSH 跑**（见 [systemd.md](systemd.md#从用户服务迁移)） |

手工替换二进制：

```bash
sudo install -m755 webterm-new /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm   # 每次替换都要重做
webterm reload                                                  # 热升级，会话保留
```

## IP 还是域名

| | IP | 域名 |
|---|---|---|
| DNS | 不用配 | 一条 A 记录 |
| 证书 | 6 天期，约 4 天续一次 | 90 天期，提前 30 天续 |
| 80 端口 | **必须一直开着** | 签下来之后可以关 |
| 换机器 / 换 IP | 每台设备都要重新配对 | 改 A 记录就行 |

改地址：`./webterm install --domain <新地址>`，之后每台设备都要重新配对。

只支持 IPv4。只有 IPv6 的机器请用域名（`AAAA` 记录）。

## 跑在非标准端口上

443 被别的服务（Xray 等）占了：

```bash
./webterm install --https-port 8443
```

- 配对 URL 和跳转会自动带上 `:8443`
- 证书仍然走 80 端口签，所以 80 要空着
- 两个端口都在 1024 以上时不需要 setcap

## 反向代理 / 隧道场景

由 nginx / Caddy / cloudflared / frp 负责 TLS，webterm 只监听本机回环地址：

```bash
webterm serve --domain term.example.com --bind 127.0.0.1 --no-tls --http-port 8080 --trust-proxy
```

- 代理要转发 WebSocket 升级头（`Upgrade` / `Connection`）
- 读超时要调长：nginx 设 `proxy_read_timeout 3600s`
- `--domain` 仍然要填，Origin 校验要用它
- 只有真的在反代后面才开 `--trust-proxy`

这种用法的 systemd 单元写法见 [systemd.md](systemd.md#反代隧道场景)。

## 家宽 / NAT 后面

公网 IP 不在这台机器上时，二选一：

- 在路由器上把外部 80/443 映射到这台机器。很多运营商会封 80，签证书那一步会直接报出来
- 套隧道或反代，见上一节

## 本地试用

```bash
./webterm serve --dev        # → http://127.0.0.1:8080，终端里会打出配对二维码
```

## 手工部署（不用安装脚本）

```bash
sudo install -m755 webterm /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm
webterm doctor --domain term.example.com --acme    # 检查并签好证书
webterm serve --domain term.example.com
```

systemd 单元见 [systemd.md](systemd.md)。

## 关于 sudo

- 用普通用户运行，**不要用 root**：用 root 跑等于把 root shell 挂到公网
- 普通用户能绑 80/443 靠的是 `setcap`。安装脚本会做；手工替换二进制之后要重做
- 要用 root 时，在会话里用 `sudo`

## 证书续期

证书会自动续期，前提是服务一直在跑：

| | 域名 | IP |
|---|---|---|
| 有效期 | 90 天 | 约 6 天 |
| 什么时候续 | 到期前 30 天 | 到期前约 53 小时 |
| 续期要求从公网能访问 | 80 或 443 | **80** |
| 续期失败时 | 自动重试 | 每小时重试一次 |

状态总览（`webterm`）里证书标黄，说明续期已经失败了好几次，去看 `journalctl -u webterm`。

## 配置文件

`~/.config/webterm/config`，安装脚本会写好 `domain` 和端口：

```ini
domain     = term.example.com
https-port = 8443
log-level  = info
```

- 键名就是 `webterm serve --help` 里的 flag 名，去掉前面的 `--`
- 命令行参数会覆盖配置文件
- 键名写错会报错，并指出是第几行
- `--dev` 和 `--config` 不能写进配置文件

## 命令行参数

### `webterm serve`

| 参数 | 默认 | 说明 |
|---|---|---|
| `--domain` | — | 域名或公网 IPv4，生产必填 |
| `--dev` | false | 本地开发：`127.0.0.1:8080`，明文，不签证书 |
| `--data-dir` | `~/.local/share/webterm` | 数据目录 |
| `--http-port` | 80 | 签证书用的验证端口，也负责跳转到 HTTPS |
| `--https-port` | 443 | 服务端口 |
| `--bind` | `0.0.0.0` | 监听地址 |
| `--no-tls` | false | 关掉 TLS，只允许 `--bind` 是回环或私有地址 |
| `--trust-proxy` | false | 信任 `X-Forwarded-For`，只在反代后面开 |
| `--max-sessions` | 20 | 会话数上限 |
| `--max-conns` | 16 | WebSocket 连接数上限 |
| `--ring-bytes` | 262144 | 每个会话的环形缓冲大小 |
| `--session-env` | — | 给会话加环境变量，写成 `KEY=VAL`，可以给多次 |
| `--no-altscreen-compat` | false | 不再把全屏 AI CLI 拉回主屏（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)） |
| `--no-login-shell` | false | shell 不以登录 shell 启动（bash 只读 `~/.bashrc`） |
| `--shell` | `bash` | 会话里用的 shell |
| `--log-level` | `info` | `debug` / `info` / `warn` / `error` |

### 其它子命令

| 命令 | 说明 |
|---|---|
| `webterm` | 状态总览 |
| `webterm install` | 用这个二进制本身安装或升级 |
| `webterm update` | 从网上升级到最新版 |
| `webterm pair` | 生成配对码和二维码 |
| `webterm devices [list \| revoke <id> \| revoke-all]` | 查看 / 吊销已授权的设备 |
| `webterm doctor [--acme]` | 检查前置条件；加 `--acme` 会顺带签好证书（服务没在跑时才能用） |
| `webterm reload [--when-idle]` | 热升级成磁盘上的新二进制 |
| `webterm version` | 版本 |

## 数据与备份

```
~/.local/share/webterm/
├── webterm.db    设备授权（要备份）
├── certs/        证书缓存（建议备份：丢了要重签，Let's Encrypt 有限流）
└── run/          控制 socket
```

```bash
sqlite3 ~/.local/share/webterm/webterm.db ".backup webterm-backup.db"
```

## 卸载

```bash
sudo systemctl disable --now webterm
sudo rm /etc/systemd/system/webterm.service /usr/local/bin/webterm
sudo systemctl daemon-reload
rm -rf ~/.local/share/webterm ~/.config/webterm     # 含设备授权，删了要重新配对
```

## 从源码构建

需要 Go 1.27+、Node 22+：

```bash
make build      # → ./webterm
make release    # → release/webterm-linux-{amd64,arm64} + SHA256SUMS
```
