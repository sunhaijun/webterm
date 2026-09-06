# systemd 部署

> 状态：Accepted

## 推荐形态：user service + `setcap`

以**普通用户**运行（[`install.md`](install.md#关于-sudo) 的方案 ②）。agent 跑在哪个用户下，攻破它就等于拿到哪个用户的权限 —— 所以不要 root。

```bash
sudo install -m755 webterm /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm
```

> ⚠️ 每次替换二进制后 `setcap` 都要重做（capability 附在文件上，不在路径上）。升级脚本里必须包含这一步。

## `~/.config/systemd/user/webterm.service`

```ini
[Unit]
Description=webterm — browser terminal agent
Documentation=https://github.com/sunhaijun/webterm
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/webterm serve --domain term.example.com
Restart=on-failure
RestartSec=3

# 优雅关闭：给 agent 时间广播"即将重启"并关闭会话
KillSignal=SIGTERM
TimeoutStopSec=15
KillMode=mixed

# 日志
StandardOutput=journal
StandardError=journal
SyslogIdentifier=webterm

[Install]
WantedBy=default.target
```

启用：

```bash
systemctl --user daemon-reload
systemctl --user enable --now webterm

# 让 user service 在用户未登录时也运行（关键，否则 SSH 退出就停了）
sudo loginctl enable-linger $USER
```

**`enable-linger` 必须做。** 没有它，user service 会在你最后一个登录会话结束时被杀掉 —— 而"不用登录就能访问"正是 webterm 的核心价值。

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
systemctl --user status webterm
journalctl --user -u webterm -f
journalctl --user -u webterm --since "1 hour ago"
```

日志里**不会有**配对码、Cookie、命令原文、终端输出（[`../60-security/privacy-history.md`](../60-security/privacy-history.md#日志ac-85)）。

## 首次配对

`webterm pair` 是独立进程，直接跑就行（它和 service 共享同一个 SQLite）：

```bash
webterm pair
```

也可以从 journal 里找 service 启动时打印的配对码（5 分钟内有效）：

```bash
journalctl --user -u webterm --since "5 min ago" | grep -A20 "配对码"
```

## 升级

```bash
systemctl --user stop webterm
sudo install -m755 webterm-new /usr/local/bin/webterm
sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/webterm   # 别忘了
systemctl --user start webterm
```

> ⚠️ 会关闭所有会话（[ADR-0003](../20-architecture/adr/0003-no-tmux.md)）。先在 UI 上确认没有重要任务在跑。

## 系统级 service（不推荐，但如果必须）

如果确实需要 `/etc/systemd/system/webterm.service`（比如没有 linger 权限）：

```ini
[Service]
Type=simple
User=sun                       # ← 必须指定普通用户，绝不用 root
Group=sun
ExecStart=/usr/local/bin/webterm serve --domain term.example.com
Environment=HOME=/home/sun
Environment=XDG_DATA_HOME=/home/sun/.local/share
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15
KillMode=mixed
```

`HOME` 与 `XDG_DATA_HOME` 必须显式设置 —— 否则 agent 会去 `/root` 或 `/` 下找数据目录，会话的 shell 也会拿到错误的 `HOME`。

## 反代/隧道场景

配合 nginx / Caddy / cloudflared 时，`ExecStart` 改成：

```
ExecStart=/usr/local/bin/webterm serve --domain term.example.com \
    --bind 127.0.0.1 --no-tls --http-port 8080 --trust-proxy
```

此时不需要 `setcap`（不绑特权端口）。反代的注意事项（WebSocket 升级头、读超时）见 [`install.md`](install.md#反向代理--隧道场景)。
