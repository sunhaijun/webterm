# systemd 部署

> 状态：Accepted。从 [ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md) 起改为系统服务。

## 推荐形态：系统服务，以普通用户运行

单元放在 `/etc/systemd/system/`，`User=` 写你自己。agent 和会话都以普通用户运行（[`install.md`](install.md#关于-sudo) 的方案 ②）：agent 跑在哪个用户下，攻破它就等于拿到哪个用户的权限，所以**绝不以 root 运行**。root 只在安装时用，用来写单元和 setcap。

**为什么不用用户服务**（`~/.config/systemd/user/`）：因为 OOM 优先级，见下面的「[OOM 优先级](#oom-优先级)」。用户服务的 `oom_score_adj` 最低只能到 100，默认是 200，内存一紧张就比登录会话先被杀，agent 一死，所有会话跟着没了。系统服务能把 agent 设成 -900、把会话设回 0。

```bash
sudo install -m755 webterm /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm
```

> ⚠️ 每次替换二进制后 `setcap` 都要重做（capability 附在文件上，不在路径上）。升级脚本里必须包含这一步。

> `scripts/install.sh` 会替你生成这个单元。手工部署可以用仓库里的模板 [`deploy/webterm.service`](../../deploy/webterm.service)，改掉 `User=` / `Group=`、uid 和 `--domain` 就能用。

## `/etc/systemd/system/webterm.service`

```ini
[Unit]
Description=webterm — browser terminal agent
Documentation=https://github.com/sunhaijun/webterm
After=network-online.target user@1000.service
Wants=network-online.target user@1000.service

[Service]
Type=simple
User=sun
Group=sun
ExecStart=/usr/local/bin/webterm serve --domain term.example.com
Restart=on-failure
RestartSec=3

# 会话里的 systemctl --user / journalctl --user / 走 D-Bus 的工具要用（ADR-0034 §4）
Environment=XDG_RUNTIME_DIR=/run/user/1000
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus

# OOM：agent 最后才被挑；会话里的进程被杀只死它自己（ADR-0034 §2）
OOMScoreAdjust=-900
OOMPolicy=continue

# 热升级（ADR-0016）：reload = 原地 exec 新二进制，会话保留
ExecReload=/bin/kill -USR2 $MAINPID

# 优雅关闭：给 agent 时间广播"即将重启"并关闭会话
KillSignal=SIGTERM
TimeoutStopSec=15
KillMode=mixed

StandardOutput=journal
StandardError=journal
SyslogIdentifier=webterm

[Install]
WantedBy=multi-user.target
```

把 `sun` 和 `1000` 换成你的用户名和 `id -u`。uid **不能写成 `%U`**：系统单元里它是 PID 1 的 UID（0），不随 `User=` 变。

`HOME` / `USER` / `LOGNAME` / `SHELL` 不用写，systemd 按 `User=` 自动设置。`PATH` 与 `LANG` 与用户管理器一致。用户管理器里通过 `environment.d` 加进去的其它变量（比如 `SSH_AUTH_SOCK`）不会带过来；会话是登录 shell，需要的变量写进 `~/.profile`。

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webterm
sudo loginctl enable-linger $USER
```

**`enable-linger` 还是要做。** 系统服务本身不靠它：开机自启、退出登录照常运行。但你的用户管理器（`user@<uid>.service`）要靠它常驻。没有 linger，最后一个登录会话一结束，logind 就会停掉用户管理器，webterm 会话里的 `systemctl --user` 和用户总线随之失效。

## OOM 优先级

内存不够时，内核挑 `oom_score_adj` 加内存占比最高的进程杀掉。

| | `oom_score_adj` | 内存吃紧时 |
|---|---|---|
| agent 主进程 | **-900** | 排在所有普通进程之后 |
| 会话里的 shell 与它起的一切 | **0** | 与 SSH 登录、tmux 的 pane 一样公平竞争 |
| 用户服务（systemd 默认） | 200 | 最先被杀 |

agent 起 shell 的那一下会先把自己临时调到 0，fork 完立刻调回 -900，所以会话从第一条用户代码起就是 0（[session-manager.md](../50-backend/session-manager.md#创建)）。`OOMPolicy=continue` 让会话里某个进程被杀时只死它自己。默认的 `stop` 会让 systemd 把整个 unit 停掉，所有会话一起死。

检查：

```bash
cat /proc/$(systemctl show webterm -p MainPID --value)/oom_score_adj   # -900
cat /proc/self/oom_score_adj                                          # 在 webterm 会话里跑：0
```

查有没有被 OOM 杀过：

```bash
systemctl show webterm -p NRestarts          # 自动重启过几次，不需要 sudo
sudo journalctl -u webterm | grep -i oom     # systemd 的记录在系统日志里，要 sudo
```

## 从用户服务迁移

ADR-0034 之前装的机器跑的是用户服务。照常 `webterm update` 时，它只换二进制并热升级用户服务，会话保留，最后提示可以迁移。迁移这样做：

```bash
webterm update --force-restart
```

它会停用并删除用户单元，写入系统单元，再启动。**迁移那一次会关掉所有会话**：从用户管理器搬到 PID 1 等于换一个进程，热交接跨不过去。tmux 这类不在 webterm 里的会话不受影响。

**从 SSH 跑，别在 webterm 的会话里跑。** 停用户服务会连带杀掉正在跑这条命令的会话，迁移就断在半路了。脚本发现自己在 webterm 的 cgroup 里时会拒绝迁移。

## 没有 sudo 时：用户服务

装不了系统服务的机器（没有 sudo），可以手写一个用户服务。代价是上面说的 OOM 优先级：最低只能到 100，比登录会话先被杀。

`~/.config/systemd/user/webterm.service`：

```ini
[Service]
Type=simple
ExecStart=%h/.local/bin/webterm serve --domain term.example.com --bind 127.0.0.1 --no-tls --http-port 8080 --trust-proxy
Restart=on-failure
RestartSec=3
OOMScoreAdjust=100      # 用户服务能到的最低值
OOMPolicy=continue
ExecReload=/bin/kill -USR2 $MAINPID
KillSignal=SIGTERM
TimeoutStopSec=15
KillMode=mixed

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now webterm
```

没有 sudo 就绑不了 80/443，所以上面是反代 / 隧道的写法。没有 linger 的话，退出登录后服务就会停。linger 多数发行版要管理员开（`sudo loginctl enable-linger <用户>`）。

## 关于沙箱化选项

systemd 提供 `ProtectHome=` / `ProtectSystem=` / `PrivateTmp=` / `NoNewPrivileges=` 等加固选项。

**webterm 明确不使用它们**，因为：

- `ProtectHome` / `ProtectSystem` 会让会话里的 shell 也受限 —— 而用户开 webterm 就是为了操作自己的文件
- `NoNewPrivileges=yes` 会让 `sudo` 失效
- `PrivateTmp=yes` 会让会话里的程序看不到系统 `/tmp`，与用户预期不符

**沙箱化 shell 是自欺欺人**（[`../60-security/threat-model.md`](../60-security/threat-model.md#明确不做的安全措施)）：用户本来就有这台机器的 shell 权限，webterm 不该假装能限制它。真正的防线是"不让未授权者进来"。

唯一保留的加固是**以普通用户运行**（而非 root），这个是真实有效的。

## 查看状态与日志

```bash
systemctl status webterm
journalctl -u webterm -f                      # agent 自己的日志，不需要 sudo
journalctl -u webterm --since "1 hour ago"
sudo journalctl -u webterm                    # 连同 systemd 的记录：启停、OOM、崩溃重启
```

agent 以你的 UID 写日志，journald 按 UID 把它放进你自己的日志文件，所以不加 sudo 也能读。systemd 关于这个 unit 的记录是 PID 1 写的，在系统日志里，要 sudo 或者在 `adm` 组里才能看到。

日志里**不会有**配对码、Cookie、用户输入、终端输出（[`../60-security/privacy-history.md`](../60-security/privacy-history.md#日志ac-85)）。

## 首次配对

`webterm pair` 是独立进程，直接跑就行（它和 service 共享同一个 SQLite）：

```bash
webterm pair
```

也可以从 journal 里找 service 启动时打印的配对码（5 分钟内有效）：

```bash
journalctl -u webterm --since "5 min ago" | grep -A20 "配对码"
```

## 升级

```bash
sudo install -m755 webterm-new /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm   # 别忘了
webterm reload    # 热升级：原地 exec 新二进制，会话保留（ADR-0016）；不需要 sudo
```

`webterm reload` 走本机的控制 socket，和单元归哪个 systemd 管无关。它让 agent 预检新二进制、交接会话、原地 exec，PID 不变，还会等新进程接手、支持 `--when-idle`。`sudo systemctl reload webterm` 也行：单元里 `ExecReload=/bin/kill -USR2 $MAINPID`，效果相同。

预检失败时 agent 照常服务，并在日志里说明原因。那时要么修好再 reload，要么接受丢会话：

```bash
sudo systemctl restart webterm   # 老路：关闭所有会话（ADR-0003）
```

> 注意：升级前的老版本 agent 不认 `SIGUSR2`（默认动作是终止），对它只能 restart。
> `install.sh` / `webterm update` 会先探测再决定走哪条路。

## 换端口（443 被别的服务占了）

```
ExecStart=/usr/local/bin/webterm serve --domain term.example.com --https-port 8443
```

`setcap` **仍然需要** —— `--http-port` 默认还是 80，那是特权端口。
两个端口都换到 1024 以上就不需要了。

`scripts/install.sh` 的 `--https-port` / `--http-port` 会把这些写进单元，
并按真实端口决定要不要 `setcap`。详见 [`install.md`](install.md#跑在非标准端口上)。

## 反代/隧道场景

配合 nginx / Caddy / cloudflared 时，`ExecStart` 改成：

```
ExecStart=/usr/local/bin/webterm serve --domain term.example.com \
    --bind 127.0.0.1 --no-tls --http-port 8080 --trust-proxy
```

此时不需要 `setcap`（不绑特权端口）。反代的注意事项（WebSocket 升级头、读超时）见 [`install.md`](install.md#反向代理--隧道场景)。
