# 安装与部署

> 状态：Accepted

## 前置条件（硬要求）

[ADR-0004](../20-architecture/adr/0004-acme-only-tls.md) 决定 TLS 只走 ACME，所以这些是**硬要求**，不是建议：

| 要求 | 为什么 | 怎么验证 |
|---|---|---|
| 一个域名 | ACME 需要它 | `dig +short term.example.com` |
| 域名 A/AAAA 记录指向本机公网 IP | HTTP-01 挑战需要 | 上面的结果 == `curl -s ifconfig.me` |
| **80 端口可用** | HTTP-01 挑战走 80 | `ss -lntp \| grep :80` 为空 |
| **443 端口可用** | 服务本体 | `ss -lntp \| grep :443` 为空 |
| Linux（x86_64 / arm64） | | `uname -m` |

bash 不是硬要求，但版本影响功能完整度：**4.4+** 才有 readline 的 bracketed paste（Composer 的多行提交依赖它）；**4.0+** 才有完整的 shell 集成（更低版本降级为只上报 CWD 与 prompt 状态）。任何版本下终端本身都完全可用。

`webterm doctor` 子命令会逐项检查并给出可读的诊断。**部署前先跑它。**

## 安装

### 一条命令（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/sunhaijun/webterm/main/scripts/install.sh \
  | bash -s -- --domain term.example.com
```

脚本会：认架构 → 下载二进制 → **校验 SHA256** → 装到 `/usr/local/bin` →
`setcap` 让普通用户能绑 443 → 生成 systemd user service → `enable-linger` →
启动服务。然后跑一次 `webterm pair` 就能扫码开工。

先看它要做什么：加 `--dry-run`。全部选项：`--help`。

**本地试用**（不需要域名、证书、root）：

```bash
curl -fsSL https://raw.githubusercontent.com/sunhaijun/webterm/main/scripts/install.sh \
  | bash -s -- --dev
webterm serve --dev      # → http://127.0.0.1:8080
```

> 正式 `v*` tag 之前 `latest` 是空的 —— 加 `--channel dev` 装 `main` 的滚动构建。

关于 `curl | bash`：装的是一个会把 shell 暴露到公网的东西，所以脚本
**强制校验 SHA256**，取不到校验和就直接中止。不放心可以先
`curl -fsSL … -o install.sh` 读一遍再跑，脚本只有两百来行。

### 从源码构建

需要 Go 1.27+ 与 Node 22+（Node 只在构建时需要，产物是单个二进制）。

```bash
git clone https://github.com/sunhaijun/webterm.git
cd webterm
make build          # 前端 + 二进制，顺序已经排好
```

交叉编译出发布产物：

```bash
make release        # → release/webterm-linux-{amd64,arm64} + SHA256SUMS
```

不用 make 的话手写是这样，**顺序不能反** —— 前端产物是 `go:embed` 的输入，
反了嵌进去的是空目录，二进制跑起来会明说「没有嵌入前端产物」：

```bash
cd web && npm ci && npm run build && cd ..
CGO_ENABLED=0 go build -ldflags "-s -w" -o webterm ./cmd/webterm
```

得到约 15 MB 的静态二进制（`ldd` 显示 not a dynamic executable），
可以直接 scp 到目标机器。

### 手工部署（不用安装脚本）

```bash
# 1. 检查环境（DNS、端口、bash）
./webterm doctor --domain term.example.com

# 2. 试运行（用 ACME staging，避免撞正式环境限流）
sudo ./webterm serve --domain term.example.com --acme-staging

# 3. 正式运行
sudo ./webterm serve --domain term.example.com
```

`--dev` 下 `http://localhost` 本身就是 secure context，所以 PWA、剪贴板、
Service Worker 都能测（[ADR-0004](../20-architecture/adr/0004-acme-only-tls.md)）。
手机访问局域网 IP 的 http **不是** secure context，装不了 PWA —— 那个必须上正式域名。

### 关于 sudo

绑定 80/443 需要特权。三个选择，**推荐第二个**：

```bash
# ① 直接 root 运行 —— 不推荐（agent 的 shell 就是 root shell）
sudo ./webterm serve --domain X

# ② 普通用户 + CAP_NET_BIND_SERVICE —— 推荐
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm
webterm serve --domain X

# ③ 普通用户监听高端口 + 系统层转发
webterm serve --domain X --http-port 8080 --https-port 8443
# 再用 nftables/iptables 把 80→8080、443→8443
```

**强烈建议 agent 以普通用户运行**（方案 ②）。webterm 不试图沙箱化自己（[`../60-security/threat-model.md`](../60-security/threat-model.md#信任边界)），所以 agent 跑在哪个用户下，攻破它就等于拿到哪个用户的权限。以 root 跑等于把 root shell 挂到公网。

需要 root 时用会话里的 `sudo`。

## 首次配对

启动后 stdout 打印：

```
webterm 0.1.0 · https://term.example.com
证书已就绪（Let's Encrypt，到期 2026-12-05，自动续期）

尚无已授权设备。配对码 5 分钟内有效：

  https://term.example.com/pair#kJ8xR2mQ...

  ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄▄
  █ ▄▄▄ █ ▀▄▄▀█▄ █ ▄▄▄ █
  █ ███ █ █▄ ▄ ▀ █ ███ █
  …

用手机扫码即可完成授权。
```

之后新设备接入用 `webterm pair` 再生成一个。

## 命令行参数

### `webterm serve`

| 参数 | 默认 | 说明 |
|---|---|---|
| `--domain` | — | 域名。生产必填 |
| `--dev` | false | 本地开发：`127.0.0.1:8080` 明文，不申请证书 |
| `--acme-staging` | false | 用 Let's Encrypt staging 环境（调试部署用） |
| `--data-dir` | `$XDG_DATA_HOME/webterm` | 数据目录 |
| `--http-port` | 80 | ACME 挑战 + HTTPS 跳转 |
| `--https-port` | 443 | |
| `--bind` | `0.0.0.0` | 监听地址。设为 `127.0.0.1` 配合隧道/反代 |
| `--no-tls` | false | 关闭 TLS。**仅允许在 `--bind` 为回环或私有地址时使用** |
| `--trust-proxy` | false | 信任 `X-Forwarded-For`（**仅在反代后启用**，否则限速可被绕过） |
| `--max-sessions` | 20 | 会话数上限 |
| `--max-conns` | 16 | 并发 WebSocket 连接上限（每条连接占一个写队列） |
| `--ring-bytes` | 1048576 | 每会话输出缓冲（影响能容忍的断线时长） |
| `--conn-queue-bytes` | 4194304 | 每连接写队列上限 |
| `--max-history` | 50000 | 命令历史条数上限 |
| `--no-history` | false | 完全关闭命令历史记录 |
| `--no-shell-integration` | false | 不注入 shell 集成（排障用） |
| `--no-login-shell` | false | 用非登录交互 shell（只读 `~/.bashrc`） |
| `--shell` | `bash` | v0.1 只支持 bash |
| `--log-level` | `info` | `debug` / `info` / `warn` / `error` |

### 其它子命令

| 命令 | 说明 |
|---|---|
| `webterm doctor [--domain X]` | 检查部署前置条件 |
| `webterm pair` | 生成新的配对码（打印 URL + 二维码） |
| `webterm devices [list\|revoke <id>\|revoke-all]` | 设备管理（CLI 侧，UI 里也有） |
| `webterm shell-init bash` | 输出 shell 集成脚本（手动接入的降级路径） |
| `webterm version` | 版本信息 |

## systemd

见 [`systemd.md`](systemd.md)。

## 数据与备份

```
$XDG_DATA_HOME/webterm/     （默认 ~/.local/share/webterm/）
├── webterm.db       ← 设备授权 + 命令历史 + 快捷命令
├── certs/           ← autocert 缓存（丢了会重新申请，注意 Let's Encrypt 限流）
└── run/             ← 临时 rcfile，无需备份
```

备份 `webterm.db` 即可。建议先停服或用 `sqlite3 webterm.db ".backup /path/to/backup.db"`，直接 `cp` 可能撞上 WAL 状态不一致。

> ⚠️ **`webterm.db` 里有你的完整命令历史。** 备份到哪里就等于把历史复制到哪里。见 [`../60-security/privacy-history.md`](../60-security/privacy-history.md)。

**`certs/` 值得一并备份** —— 不是因为不能重新申请，而是 Let's Encrypt 有签发频率限制（每域名每周 50 次），频繁重建会撞限流。

## 升级

> ⚠️ **升级会关闭所有会话。** 这是 [ADR-0003](../20-architecture/adr/0003-no-tmux.md) 的已知取舍：agent 持有 PTY，进程重启则 shell 收到 `SIGHUP`。

```bash
# 1. UI 上确认没有正在跑的重要任务
# 2. 替换二进制
sudo install -m755 webterm-new /usr/local/bin/webterm
# 3. 重启
systemctl --user restart webterm
```

agent 收到 `SIGTERM` 时会先向所有客户端广播"agent 即将重启，所有会话将结束"再退出，所以你至少能看到发生了什么，而不是一个莫名的重连失败。

**命令历史存在 SQLite 里，跨重启存活** —— "我刚才在跑什么"这个信息不会丢。

## 反向代理 / 隧道场景

架构上完全支持（[ADR-0002](../20-architecture/adr/0002-self-contained-binary.md) 的"不烧桥"性质）：

```bash
webterm serve --domain term.example.com --bind 127.0.0.1 --no-tls --http-port 8080 --trust-proxy
```

然后让 nginx / Caddy / cloudflared / frp 接管 TLS 与暴露。要点：

- **必须传递 WebSocket 升级头**（`Upgrade` / `Connection`）
- **`--domain` 仍然要填**，因为 `Origin` 校验需要它
- 代理的读超时必须足够长或禁用，否则长连接会被掐（nginx 默认 60s 会断 WebSocket，需要 `proxy_read_timeout 3600s`）
- 只在真的有反代时开 `--trust-proxy`，否则限速可被伪造 `X-Forwarded-For` 绕过

## 卸载

```bash
systemctl --user disable --now webterm
rm /usr/local/bin/webterm
rm -rf ~/.local/share/webterm       # 含历史，确认后再删
rm ~/.config/systemd/user/webterm.service
```

**不需要清理 dotfiles** —— webterm 从不修改 `~/.bashrc`（[ADR-0010](../20-architecture/adr/0010-bash-rcfile-injection.md)），集成通过临时 rcfile 注入，卸载即干净。
