# 安装与部署

> 状态：Accepted

## 从零到能用

需要：一台有公网 IPv4 的 Linux 机器（x86_64 / arm64），一个能 sudo 的普通用户。
**域名可选** —— 没有就用 IP（[ADR-0044](../20-architecture/adr/0044-ip-address-certificates.md)）。

### 1. 云安全组放行 80 和 443

这是唯一一件安装脚本替你做不了的事。去云控制台的安全组 / 防火墙规则里放行
**入方向 TCP `80` 和 `443`**（阿里云、腾讯云叫「安全组」，AWS 叫「Security Group」）。

机器自己的防火墙（ufw / firewalld）不用管，脚本发现它们开着会自己放行。
忘了这一步也不要紧：安装脚本会在启动服务**之前**先把证书签好，
安全组没开会当场报出来。

> 有域名的话，再加一条 `A` 记录指向这台机器的公网 IP。**不要用 CNAME 指到别处**；
> 用 Cloudflare 的话**把小云朵关掉**（DNS only）—— 开着代理时挑战会被 Cloudflare 截住，
> webterm 看到的 `Origin` 也不对。

### 2. 装

手边（笔记本、另一台服务器）已经有一个 webterm 二进制的话 —— **推荐这条**，不需要 GitHub 凭据：

```bash
scp webterm server:  &&  ssh -t server ./webterm install                              # 用公网 IP
scp webterm server:  &&  ssh -t server ./webterm install --domain term.example.com    # 用域名
```

二进制里嵌着安装脚本，`webterm install` 用它自己装自己（[ADR-0045](../20-architecture/adr/0045-install-from-the-binary.md)）。
`-t` 不能省：脚本中途要 sudo 问密码。手边没有二进制就[从源码构建](#从源码构建)一个，或者在服务器上直接从网上装：

```bash
# 仓库目前是私有的：先 gh auth login
gh api repos/sunhaijun/webterm/contents/scripts/install.sh \
  -H 'Accept: application/vnd.github.raw' \
  | bash -s -- --channel dev                    # 有域名就加 --domain term.example.com
```

> `--channel dev` 在 v0.2.0 发布之前是必需的：`latest` 还是 v0.1.0，它早于这套安装流程，
> 脚本会拒绝装它（[ADR-0045](../20-architecture/adr/0045-install-from-the-binary.md) §2）。

用**普通用户**跑，不要 sudo —— 脚本会在需要的地方自己调 sudo。
（agent 跑在哪个用户下，攻破它就等于拿到哪个用户的权限。以 root 跑等于把
root shell 挂到公网。）装出来的是**以你的用户运行的系统服务**：sudo 只用来写单元、setcap、
放行防火墙，agent 和会话都是你自己（[ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md)）。

脚本依次做：

1. 不给 `--domain` 时取本机公网 IP（以前装过就沿用上次的参数）
2. 装到 `/usr/local/bin`，`setcap` 让普通用户能绑 80/443
3. 放行已启用的 ufw / firewalld
4. **自检 + 签证书**：`webterm doctor --acme` —— 地址、端口，再**向 Let's Encrypt 申请证书**。
   签下来的证书存进 `certs/`，服务启动直接用；签不下来就停在这里，服务不会被写成 systemd 单元，
   修好重跑同一条命令
5. 写配置文件、生成 systemd 系统服务、启动
6. 等正式证书签下来，打出**配对二维码**

### 3. 扫码

最后一屏就是这个：

```
  https://203.0.113.42/pair#kJ8xR2mQ...

  ▄▄▄▄▄▄▄ ▄  ▄▄ ▄▄▄▄▄▄▄
  █ ▄▄▄ █ ▀▄▄▀█▄ █ ▄▄▄ █
  …
```

**手机扫码** → 自动完成授权 → 直接进终端。这台设备之后再也不用登录。
扫不了码（终端在另一块屏幕上）就在手机浏览器打开 `https://<地址>/pair`，输入终端里那 16 位数字（`1234-5678-9012-3456`，空格或 `-` 分隔都行）。

配对码 5 分钟过期、用过即废。它走 URL fragment，**不会发给服务器**，所以不进
访问日志、不进 Referer。错过了就再跑一次 `webterm pair`。别的设备也一样 ——
在已经配对的设备上打开一个会话跑 `webterm pair` 就行，不用再 SSH。

手机上可以「添加到主屏幕」装成 PWA。

### 走通了的样子

```bash
webterm                                   # 状态总览：服务、地址、证书、设备
systemctl status webterm                  # active (running)
journalctl -u webterm -n 20               # 有"证书已就绪"
```

### IP 还是域名

| | IP（`./webterm install`） | 域名（`--domain term.example.com`） |
|---|---|---|
| 要做的 DNS | 无 | 一条 A 记录 |
| 证书 | 6 天期，约 4 天续一次 | 90 天期，提前 30 天续 |
| 80 端口 | **必须一直开着**（续期只走 HTTP-01） | 签完可以关（续期也能走 443） |
| 换机器 / 换 IP | 地址变了，设备要重新配对 | 改 A 记录就行，设备不用动 |

**从 IP 换到域名**（或者 IP 变了）：`./webterm install --domain <新地址>` 重装一次。
浏览器那边是一个新的 origin，Cookie、PWA 都不会跟过去，**每台设备要重新配对**。

只支持 IPv4。IPv6 字面量会被拒绝 —— 只有 IPv6 的机器请用域名（`AAAA` 记录）。

---

### 家宽 / NAT 后面

公网 IP 不在这台机器上（`curl -s ifconfig.me` 与 `ip addr` 不一致，而且不是云厂商的
1:1 NAT）时，有两条路：

1. **路由器端口映射**：把外部 80/443 转发到这台机器。很多运营商**封 80 入方向**，
   那 HTTP-01 挑战就过不来 —— 安装时的自检会直接告诉你。
2. **套隧道 / 反代**（推荐）：让 Cloudflare Tunnel / frp / nginx 终结 TLS，
   webterm 只监听回环。见[反向代理 / 隧道场景](#反向代理--隧道场景)。

### 只想本地试试

不需要域名、证书、公网、root：

```bash
./webterm serve --dev
# → http://127.0.0.1:8080，stdout 有配对 URL 和二维码
```

`http://localhost` 本身就是 secure context，PWA、剪贴板、Service Worker 都能测。
但**手机访问局域网 IP 的 http 不算 secure context**，装不了 PWA —— 那个必须上正式证书。

---

## 前置条件速查

[ADR-0004](../20-architecture/adr/0004-acme-only-tls.md) 决定 TLS 只走 ACME，所以这些是**硬要求**，不是建议：

| 要求 | 为什么 | 谁来查 |
|---|---|---|
| 公网 IPv4，或者一个解析到它的域名 | ACME 要验证这个地址 | `webterm doctor`：域名查 DNS 是否指向本机，IP 查是否等于本机公网 IP |
| **80 端口可用** | HTTP-01 挑战走 80 | `webterm doctor` |
| **443 端口可用** | 服务本体（被占了就换 `--https-port`） | `webterm doctor` |
| 80/443 在**云安全组**里放行 | 挑战要从外网打进来 | `webterm doctor --acme`（真的签一次，机器内部唯一查得出来的办法） |
| Linux（x86_64 / arm64） | | `uname -m` |

webterm 不往 shell 里注入任何东西，用哪个 shell、哪个版本都行。想让多行粘贴不被逐行执行，shell 要支持 bracketed paste（bash 4.4+、zsh、fish 都支持）。

`webterm doctor` 逐项检查并给出可读的诊断，安装脚本在首次安装时会带 `--acme` 自动跑。

检查结果分三档：`✓` 通过、`✗` 挡住部署、`⚠` 值得知道但不挡。

`⚠` 目前只有一种情况：**特权端口空着，但当前这个二进制没有绑定权限**（还没 `setcap`）。
安装脚本在 `setcap` 之后才跑自检，所以装的时候看不到它；手工跑一个刚下载的二进制会看到。
端口【真的被别人占着】仍然是 `✗`：那时探测能连上去，两种情况分得开。

`--acme` 那一项要**真的绑上**两个端口，所以只能在服务没在跑的时候做（升级时安装脚本会跳过它）。
它签的是**正式证书**，存进 `certs/`，服务启动直接用 —— 不多签一张。`certs/` 里已经有有效证书时直接用它，
会说「没有找 CA」。签失败只消耗按小时计的失败额度（[ADR-0044](../20-architecture/adr/0044-ip-address-certificates.md) §3），
所以不需要先拿 staging 试。

## 安装

### 用二进制自己装（推荐）

```bash
./webterm install [--domain term.example.com] [--https-port 8443] …
```

参数和下面 `install.sh` 的一样（`./webterm install --help`）。二进制里嵌着同一份 `install.sh`，
`webterm install` 把它取出来、用自己当安装来源（`--binary`）跑一遍：不下载、不需要 GitHub 凭据。

**在已经装好的机器上再跑一次**就是用这个二进制升级：不给 `--domain` 时沿用上次的安装参数，
服务在跑、支持交接就热升级（会话保留），见[升级](#升级)。

### 从网上装

**仓库目前是私有的**，所以下面这两条路要分清 —— `raw.githubusercontent.com`
和 `releases/download` 都**不带凭据**，私有仓库下一律 404，哪怕这台机器
本来有权限访问那个仓库。

私有仓库（当前情况）—— 目标机器上先 `gh auth login`：

```bash
gh api repos/sunhaijun/webterm/contents/scripts/install.sh \
  -H 'Accept: application/vnd.github.raw' \
  | bash -s -- --channel dev
```

没有 `gh` 就用 token（要有 repo 读权限）：

```bash
export GH_TOKEN=<token>
curl -fsSL -H "Authorization: Bearer $GH_TOKEN" \
  -H 'Accept: application/vnd.github.raw' \
  https://api.github.com/repos/sunhaijun/webterm/contents/scripts/install.sh \
  | bash -s -- --channel dev
```

> 这两条都会在服务器上留下一份能读写你**所有仓库**的凭据，而这台机器正把 shell 挂在公网上。
> 能用 `webterm install` 就用它。

脚本自己也会用同一套凭据去下二进制：先试匿名，404 就回退到 `gh`，
再回退到 `GH_TOKEN` / `GITHUB_TOKEN`。三条都不行会明确报错并中止，
**不会跳过校验**。

仓库转公开之后，这条就够了（脚本不用改）：

```bash
curl -fsSL https://raw.githubusercontent.com/sunhaijun/webterm/main/scripts/install.sh | bash
```

**从网上取的脚本只负责下载**：认架构 → 下载二进制 → **校验 SHA256** → 交给**下载来的那个二进制**
的 `webterm install` 接着装（[ADR-0045](../20-architecture/adr/0045-install-from-the-binary.md) §2）。
这样干活的脚本和二进制永远是同一个版本。下载来的版本早于这套流程（不认 `install`，v0.1.0 及更早）
时会直接中止 —— v0.2.0 发布之前 `latest` 就是这种情况，所以要加 `--channel dev`（`main` 的滚动构建）。

先看它要做什么：加 `--dry-run`。全部选项：`--help`。

> **自己的下载源**：`--base-url <地址>` 直接指向放着
> `webterm-linux-<arch>` 和 `SHA256SUMS` 的任意 HTTP 服务。
> 走这条时脚本**不会**回退到 GitHub 凭据 —— 你指定了源就以你的源为准。

关于 `curl | bash`：装的是一个会把 shell 暴露到公网的东西，所以脚本
**强制校验 SHA256**，取不到校验和就直接中止。不放心可以先
`curl -fsSL … -o install.sh` 读一遍再跑。

### 不给 `--domain` 时用什么地址

1. 以前在这台机器上装过（有 `~/.config/webterm/install-state`）→ **沿用上次那套参数**，命令行上给的覆盖同名项
2. 否则 → 本机公网 IPv4（问 `api.ipify.org`，不行再问 `ifconfig.me`），走 IP 模式

用的是哪个会打印出来。`--dev` / `--no-service` 不需要地址。

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
sudo setcap 'cap_net_bind_service=+ep' ./webterm

# 1. 检查环境（地址、端口），并把证书签好 —— 安全组没开在这里暴露
./webterm doctor --domain term.example.com --acme

# 2. 正式运行
./webterm serve --domain term.example.com
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

**强烈建议 agent 以普通用户运行**（方案 ②）。`install.sh` 装出的系统服务就是这样：
单元里 `User=` 是你，sudo 只用来写单元和 setcap（[`systemd.md`](systemd.md)）。webterm 不试图沙箱化自己（[`../60-security/threat-model.md`](../60-security/threat-model.md#信任边界)），所以 agent 跑在哪个用户下，攻破它就等于拿到哪个用户的权限。以 root 跑等于把 root shell 挂到公网。

需要 root 时用会话里的 `sudo`。

## 首次配对

用安装脚本装的，首次安装最后一步就是 `webterm pair --wait`：等本机 HTTPS 用系统信任的证书能打开了
（最多 90 秒）再打印配对码，免得扫码后看到证书错误。

手工跑 `webterm serve` 时，没有授权设备的话启动后 stdout 打印：

```
time=... level=INFO msg="webterm 已启动" url=https://term.example.com
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

**「证书已就绪」这一行是启动时主动申请一次的结果。** autocert 默认懒加载 ——
证书要等第一次 TLS 握手才去申请，那样启动时根本看不出 ACME 通不通。
agent 会在监听起来之后主动触发一次。失败时打出的是「原因 + 怎么修」，不是一行 Go 的 error：

```
level=ERROR msg="证书申请失败 —— HTTPS 还不可用" domain=term.example.com

  HTTP-01 挑战没能打到本机的 80 端口。按顺序查：
    1. 云安全组 / 防火墙放行了入方向 TCP 80 吗？（最常漏的一步）
         在别的机器上跑：curl -sI http://term.example.com/
    2. DNS 指向本机吗？
         dig +short term.example.com   应当等于   curl -s ifconfig.me
    3. 用 Cloudflare 的话，把小云朵关掉（DNS only，不要 Proxied）
```

## 命令行参数

### `webterm serve`

| 参数 | 默认 | 说明 |
|---|---|---|
| `--domain` | — | 域名，或公网 IPv4（[IP 模式](#ip-证书)）。生产必填 |
| `--dev` | false | 本地开发：`127.0.0.1:8080` 明文，不申请证书 |
| `--data-dir` | `$XDG_DATA_HOME/webterm` | 数据目录 |
| `--http-port` | 80 | ACME 挑战 + HTTPS 跳转 |
| `--https-port` | 443 | 非 443 时**配对 URL 与启动日志会带上端口**，见[跑在非标准端口上](#跑在非标准端口上) |
| `--bind` | `0.0.0.0` | 监听地址。设为 `127.0.0.1` 配合隧道/反代 |
| `--no-tls` | false | 关闭 TLS。**仅允许在 `--bind` 为回环或私有地址时使用** |
| `--trust-proxy` | false | 信任 `X-Forwarded-For`（**仅在反代后启用**，否则限速可被绕过） |
| `--max-sessions` | 20 | 会话数上限 |
| `--max-conns` | 16 | 并发 WebSocket 连接上限（每条连接占一个写队列） |
| `--ring-bytes` | 262144 | 每会话环形缓冲。断线或切走期间的输出在它之内就增量续传，超出就改发快照（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)） |
| `--session-env` | 无 | 注入会话 PTY 的环境变量，`KEY=VAL`，可重复 |
| `--no-altscreen-compat` | false | 关掉"把全屏 AI CLI 拉回主屏"的内置清单（AC-7.8）|
| `--no-login-shell` | false | 以 `-i` 启动非登录交互 shell（bash 只读 `~/.bashrc`）。默认 `-l -i` |
| `--shell` | `bash` | 会话里跑的 shell，任何支持 `-l` / `-i` 的 shell 都行 |
| `--log-level` | `info` | `debug` / `info` / `warn` / `error`。公网扫描器制造的 TLS 握手失败记在 `debug`，默认看不到 |

> **`--session-env` 与 `--no-altscreen-compat` 会改变 AI CLI 的观感。** webterm 默认注入一份内置清单（目前只有 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`），把全屏 AI CLI 拉回主屏 —— 只有主屏的输出才是可以往回拖的追加流（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)）。可见的变化只有一条：**输入框从"钉在屏幕底部"变成"输出流的最后几行"** —— 贴底时它照样在屏幕底部、照样能打字，只有你滚上去回看时它会跟着滚出视野，回到底部就回来。换来的是 5000 行可以拖着看的历史。不想要就 `--no-altscreen-compat`。**在 tmux 里跑 claude 的话还有一条**：classic 渲染器不开鼠标跟踪，于是 tmux（`mouse on`）里每一次滚轮都会把 pane 推进 copy-mode，之后键盘输入不进程序 —— 按 `q` / `Esc` 退出，详见 [troubleshooting.md](troubleshooting.md#在-tmux-里突然打不进字滚了一下之后)。`--session-env` 可以重复给，也可以写进配置文件（多行）—— 两边是**合并**，同名键以后出现的为准，所以命令行照样压过配置文件；`TERM` 和 `WEBTERM_SESSION` 由 webterm 定死，写了会直接报错。

### 其它子命令

| 命令 | 说明 |
|---|---|
| `webterm install [参数]` | 用这个二进制本身安装 / 升级成系统服务（参数同 `install.sh`，见[安装](#安装)） |
| `webterm doctor [--domain X] [--acme]` | 检查部署前置条件；`--acme` 再把证书签好存进 `certs/`（服务没在跑时才能用） |
| `webterm update` | 从网上升级到最新版（按上次的安装参数重装） |
| `webterm pair [--wait]` | 生成新的配对码（打印 URL + 二维码 + 可手输的 16 位数字）；`--wait` 先等 HTTPS 证书就绪 |
| `webterm devices [list\|revoke <id>\|revoke-all]` | 设备管理（CLI 侧，UI 里也有） |
| `webterm version` | 版本信息 |

## systemd

见 [`systemd.md`](systemd.md)。

## 证书续期

**会自动续期，不需要你做任何事** —— 但有三个前提，缺一条就不会续。

### 续期规则

autocert 在证书到期前 **`min(30 天, 有效期的 1/3)`** 触发续期。
Let's Encrypt 的证书有效期 90 天，1/3 正好是 30 天，所以实际就是**提前 30 天**。

我们**刻意不显式设置 `RenewBefore`**：库的这条规则会跟着证书有效期自动缩放。
写死 30 天的话，将来换成短周期证书（Let's Encrypt 已在推 6 天期的选项）
就会变成"每次都立刻续期"。

### 三个前提

| 前提 | 为什么 | 缺了会怎样 |
|---|---|---|
| **进程活着** | 续期定时器在进程内存里 | 进程一直不跑就不会续期 |
| **80 或 443 从公网可达** | 续期要重新过一次域名验证 | 两个都不通才会失败 |
| `certs/` 可写 | 新证书要落盘 | 每次重启都重新申请，容易撞限流 |

第二条比想象中宽松：验证有两条路 —— **HTTP-01 走 80**，**TLS-ALPN-01 走 443**，
autocert 优先试后者，我们的 `NextProtos` 里带了 `acme-tls/1` 所以它是通的。
443 本来就得开着（不然服务没法用），**所以后来把 80 关掉不会导致续期失败**。
真正会出事的是把整台机器挪到 NAT 后面、或者给 Cloudflare 开了小云朵 ——
那时两条路一起断。

### 不依赖"有人访问"

autocert 的续期定时器是在**证书进入内存状态时**挂上的，而它默认是懒加载 ——
证书要等第一次 TLS 握手才加载。也就是说：**进程重启后如果一直没人访问，
就没有续期定时器。**

agent 在监听起来之后会**主动预热一次证书**（见[首次配对](#首次配对)），
所以续期定时器从启动那一刻就存在，不依赖有没有流量。

> 即便定时器缺失也不会立刻出事：过期的缓存证书会被判为 cache miss，
> 下一次握手时当场重新申请。但那是"用户等着"的时候申请，
> 撞上限流或验证不通就直接暴露成 TLS 错误 —— 提前 30 天续期才有缓冲。

### 怎么确认它真的在工作

```bash
# 当前证书的到期时间
echo | openssl s_client -connect term.example.com:443 -servername term.example.com 2>/dev/null \
  | openssl x509 -noout -dates

# 启动时那行「证书已就绪」
journalctl -u webterm | grep -i '证书\|acme'

# 80 / 443 还在监听吗（续期要过域名验证）
ss -lntp | grep -E ':(80|443)\b'
```

### IP 证书

`--domain` 是 IPv4 时走另一套（[ADR-0044](../20-architecture/adr/0044-ip-address-certificates.md)）：Let's Encrypt 的 IP 证书**只有 6 天期**
（`shortlived` profile，约 160 小时），autocert 不支持，由 agent 自己的证书管理器申请。

| | 域名 | IP |
|---|---|---|
| 有效期 | 90 天 | 约 160 小时 |
| 什么时候续 | 剩 1/3（30 天） | 剩 1/3（约 53 小时） |
| 验证 | HTTP-01（80）或 TLS-ALPN-01（443） | **只有 HTTP-01（80）** |
| 续不上时 | autocert 自己重试 | 每小时重试一次 |

所以 IP 模式下**80 端口不能关**：关了的话，几天之内证书就过期了。状态总览里证书剩不到
`min(10 天, 有效期/4)` 会标黄（IP 证书就是 40 小时），看到黄色就说明续期已经失败过好几次了，
去看 `journalctl -u webterm`。

### `certs/` 值得备份

丢了会重新申请 —— 能成功，但 Let's Encrypt 每域名每周只给 50 次签发。
反复重建容易撞限流，见[数据与备份](#数据与备份)。

## 数据与备份

```
$XDG_DATA_HOME/webterm/     （默认 ~/.local/share/webterm/）
├── webterm.db       ← 设备授权与配对（只存哈希）
├── certs/           ← 证书缓存（丢了会重新申请，注意 Let's Encrypt 限流）
└── run/             ← 控制 socket，无需备份
```

备份 `webterm.db` 即可。建议先停服或用 `sqlite3 webterm.db ".backup /path/to/backup.db"`，直接 `cp` 可能撞上 WAL 状态不一致。

**`certs/` 值得一并备份** —— 不是因为不能重新申请，而是 Let's Encrypt 有签发频率限制（每域名每周 50 次），频繁重建会撞限流。

## 升级

**热升级不丢会话**（[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)）：agent 原地换成新二进制，PID 不变，各会话的 shell、环形缓冲、终端模拟器的状态、序号一并交接过去。浏览器只会看到连接横幅闪一下然后自动重连，正在跑的 vim / claude / ssh 都在原处。

最省事的是拿新二进制再装一次 —— 替换、setcap、热升级都由安装脚本做：

```bash
scp webterm server:  &&  ssh -t server ./webterm install     # 沿用上次的安装参数
```

或者从网上取：`webterm update`（见下一节）。手工做的话是这样：

```bash
# 1. 替换二进制（file capability 会丢，要重做 setcap）
sudo install -m755 webterm-new /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm
# 2. 让运行中的 agent 原地换成新二进制
webterm reload              # 不需要 sudo；或 sudo systemctl reload webterm
```

`webterm reload` 先让新二进制预检快照能不能读，读不了就**中止、服务照常**，不会自动退化成重启。要接受丢会话就走老路：`sudo systemctl restart webterm`。`webterm reload --when-idle` 等所有会话都空闲再动：空闲 = PTY 的前台进程组就是 shell 自己，也就是没有命令在跑。

真正的重启（`systemctl restart`、`SIGTERM`）仍会关闭所有会话；agent 会先向所有客户端广播"agent 即将重启，所有会话将结束"再退出。设备授权存在 SQLite 里，跨重启存活，不用重新配对。

## 看一眼现在正不正常

不带子命令直接跑：

```bash
webterm
```

```
webterm v0.1.0

  服务      运行中（systemd）
  地址      https://term.example.com:8443
  证书      有效，到 2026-12-06（还有 89 天，自动续期）
  设备      2 台已授权
  配置      /home/you/.config/webterm/config

  webterm pair       拿配对码 + 二维码
  webterm devices    看已授权的设备 / 吊销
  webterm doctor     检查部署前置条件
```

证书剩不到 10 天会标黄，过期会标红 —— 那是唯一会**静默**变成事故的东西。
没有授权设备时会在 `webterm pair` 后面标出「← 下一步」。

「服务在不在跑」先问 systemd：先看系统单元，没有再看迁移前的用户单元，都没有时退化成探 `/healthz`
（**不是**看端口有没有人听 —— 443 上很可能是别的服务）。

## 升级

```bash
webterm update                 # 默认热升级：会话保留（ADR-0016）
webterm update --when-idle     # 等所有会话空闲（前台进程组就是 shell）再动
webterm update --force-restart # 接受丢会话，走 systemctl restart（老版本 agent 也是这条路）
```

按 **上次装成功时那套参数** 重跑一遍安装 —— 参数记在
`~/.config/webterm/install-state`，`install.sh` 装完时写的。`--when-idle` / `--force-restart`
是一次性开关，不记进去。

装完二进制、重做 setcap 之后，`install.sh` 先问运行中的 agent 支不支持交接
（`webterm reload --probe`）：支持就 `webterm reload`，会话保留；不支持（升级前的老版本）
或指定了 `--force-restart` 才 `sudo systemctl restart`，并保留原来的"将关闭会话"提示。
热升级预检失败会**中止并报错**，不静默重启。

**还是用户服务的机器**（[ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md) 之前装的）：
默认只换二进制并热升级那个用户服务，会话保留，单元文件不动，最后提示迁移。
`webterm update --force-restart` 才迁移成系统服务 —— 那一次会关闭所有会话，
版本没变也照样迁移。**要从 SSH 跑**：在 webterm 的会话里跑会被拒绝，因为停用户服务
会连这个会话一起杀掉。详见 [`systemd.md` 的「从用户服务迁移」](systemd.md#从用户服务迁移)。

```
webterm dev-2-g8cb0cdf

  按上次的安装参数升级：
    --domain t.awtto.com --https-port 8443 --channel dev

  安装脚本来源：gh api（私有仓库凭据）

  有新版本
    当前  webterm dev-2-g8cb0cdf
    最新  webterm dev-2-g10fd2c8
  …
```

**版本没变就什么都不做**，服务不会重启 —— 重启会把正在用的会话踢掉，
对"顺手跑一下"的命令来说代价太大。

它是个**薄壳**：取最新的 `install.sh` 用记下的参数重跑，而不是自己实现
一遍下载、校验、`setcap`、重启。升级路径上的知识都在那个脚本里
（私有仓库凭据回退、SHA256 校验、**替换二进制会丢掉 file capability
所以必须重做 setcap**、systemd 单元跟着端口走），照抄一份必然漂移。

选项：

| | |
|---|---|
| `--dry-run` | 只打印将要执行的命令 |
| `--script <路径>` | 用本地的 `install.sh`，不去下载（离线、自建源） |
| `--state <路径>` | 指定安装参数文件 |

没有 `install-state` 时会明说这台机器还没用 `install.sh` 装过 ——
手工装的二进制不知道当初的参数，只能先正常装一次。

## 配置文件

装完之后不用每次都敲 `--domain`、`--https-port`：

```bash
webterm pair
webterm doctor
webterm devices list
```

参数从 `~/.config/webterm/config` 读（`$XDG_CONFIG_HOME/webterm/config`；
`--config <路径>` 可指定别的位置）。`scripts/install.sh` 会替你写好。

```ini
# 键名【就是 flag 名】，去掉前面的 --
domain     = term.example.com
https-port = 8443
log-level  = info
```

- 命令行参数**覆盖**配置文件，临时改一次不用动文件
- `#` 开头是注释，空行忽略
- 键名写错会**当场报错并指出行号**，不会安静地忽略
- 布尔项写 `no-login-shell = true`，或者只写键名也算 true

刻意不用 TOML/YAML：那要引依赖，而配置只有十来个平铺的键。
键名与 flag 名共用同一套，所以 `webterm serve --help` 就是配置文件的文档，
两者不可能漂移（有测试钉住）。

可以放进配置文件的键，就是 `webterm serve --help` 列出的那些：

`domain` · `data-dir` · `bind` · `http-port` · `https-port` · `no-tls` ·
`trust-proxy` · `shell` · `max-sessions` · `max-conns` ·
`ring-bytes` · `session-env` · `no-altscreen-compat` · `no-login-shell` · `log-level`

> `--dev` 与 `--config` 【不能】写进配置文件：前者是"临时本地跑一下"的开关，
> 写进文件等于把生产配置永久降级；后者会自我循环。

## 跑在非标准端口上

443 被别的服务占了（Xray、别的 web 服务）时，webterm 可以听在别的端口：

```bash
webterm serve --domain term.example.com --https-port 8443
```

`--https-port` 一旦不是 443，**对外 URL 的三个地方都会自动带上端口** ——
配对 URL 与二维码、启动日志、HTTP 跳转的 `Location`。所以扫码就能直接打开，
不需要手工补 `:8443`。

```
webterm 已启动  url=https://term.example.com:8443

  https://term.example.com:8443/pair#<配对码>
```

`webterm pair` 是独立进程，它不知道 serve 用了哪个端口，**要自己带上同一个值**：

```bash
webterm pair --domain term.example.com --https-port 8443
```

`--http-port` 和 `--https-port` **不能相同** —— 它们是两个独立监听（ACME 挑战
与跳转走前者，HTTPS 服务走后者）。写成一样会在启动时直接被拒，
而不是撞到一句让人误以为端口被别人占了的 `address already in use`。

用 `scripts/install.sh` 装的话，端口会写进 systemd 单元，`setcap` 也会跟着调整 ——
两个端口都在 1024 以上时**不做 setcap**（普通用户本来就能绑，白给一个
capability 没有必要）：

```bash
./install.sh --domain term.example.com --https-port 8443 --http-port 8080
# → ExecStart=… serve --domain term.example.com --http-port 8080 --https-port 8443
# → 端口 8080/8443 都不是特权端口，跳过 setcap
```

### 证书还能自动申请吗

能，但要看 80 和 443 的情况 —— **CA 只会连这两个端口**，不会连 8443：

| 情况 | 走哪条挑战 | 结果 |
|---|---|---|
| 80 空着（常见） | HTTP-01 → 80 | ✅ 照常签发与续期 |
| 80 和 443 都不通 | 两条都没戏 | ❌ 只能自己塞证书或套反代 |

> autocert 会先试 TLS-ALPN-01（443），失败再试 HTTP-01（80）。所以
> 「443 被占 + 80 空着」这个组合下会看到第一次尝试失败 —— 那是**预期行为**，
> 最终仍然会通过 HTTP-01 签出来。两条都不通时的诊断见
> [排障](troubleshooting.md#证书--tls)。

### PWA 还能装吗

能。带端口的 `https://` 仍然是 secure context，Service Worker、`manifest.json`
（`start_url` 与 `scope` 都是相对路径）、安装到桌面都不受影响。

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
sudo systemctl disable --now webterm
sudo rm /etc/systemd/system/webterm.service
sudo systemctl daemon-reload
sudo rm /usr/local/bin/webterm
rm -rf ~/.local/share/webterm       # 含设备授权，删了要重新配对
```

**不需要清理 dotfiles** —— webterm 从不修改 `~/.bashrc`，也不往 shell 里注入任何东西，卸载即干净。
