# 非目标与已接受的取舍

> 状态：Accepted

这篇文档比愿景更重要。它记录**我们主动砍掉了什么、为什么砍、代价是什么**。
遇到"要不要加个 X"的讨论时，先来这里看 X 是不是已经被否决过。

---

## 一、明确不做的事

### 不做 SSH 客户端

链路上没有 SSH。目标机器装 agent，浏览器直连 agent，agent 直接 fork PTY。

- **不在浏览器/Worker 里实现 SSH**：把 SSH 传输层加密和认证塞进 JS/WASM，代码量和攻击面都不可接受。
- **不做 SSH 中转 hub**：那会引入"在 hub 上管理目标机器凭据"这个大问题，并且多一跳延迟。

代价：**每台想访问的机器都要装一个二进制。** 接受。
未来：agent 内可以加 SSH 出站能力，用于跳到没装 agent 的机器（见 [ADR-0001](../20-architecture/adr/0001-agent-first-no-ssh.md)），不在 v0.1。

### 不依赖 tmux

会话由 agent 自己持有 PTY 管理，不套 tmux。

- tmux 的 window/pane 模型如果透传到 Web，我们会连它那套交互一起继承过来。
- 断线续传由 agent 自己负责：环形缓冲补增量，agent 侧的终端模拟器出快照（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)）—— 也就是 tmux 的那份屏幕状态，只是不带它的 window/pane 模型。

**代价（重要，已明确接受）：agent 进程重启 = 所有会话消失。**

PTY 的 master fd 由 agent 持有，agent 一死，shell 收到 `SIGHUP` 就没了。所以升级 webterm、重启服务器，会话都保不住。

为什么接受：**"网络断线"（每天多次）和"进程重启"（很少）是两个不同频率的问题。** 用户的真实痛点是前者，而前者被彻底解决了。

升级不在此列：热升级原地 re-exec，把 PTY fd、环形缓冲与模拟器状态交给新进程，会话不丢（[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)）。真正的进程重启仍然丢会话，见 [ADR-0003](../20-architecture/adr/0003-no-tmux.md)。

### 不依赖 Cloudflare（或任何外部平台）

早期方案是 Cloudflare Pages + Tunnel + Access。已否决。

- 它带来三个外部依赖（tunnel 进程、Access 配置、DNS 托管）和一个跨域认证的坑（Access 靠 Cookie，跨站 WebSocket 握手会被 302 到登录页后静默失败）。
- 它让"完整链路的自动化测试"变得不可能。

**这个决定不烧桥**：agent 本质上是个普通的 HTTP + WebSocket 服务，将来想套 Cloudflare Tunnel / Tailscale / nginx / frp 都是零代码改动的外部编排。见 [ADR-0002](../20-architecture/adr/0002-self-contained-binary.md)。

### 不做多用户

单用户、多设备。没有账号体系、没有权限模型、没有会话归属。

代价：不能给同事开账号。接受 —— 这是个人工具，多用户会把认证、授权、审计的复杂度翻好几倍。
未来：v0.3+ 再说，届时数据模型需要迁移。

### 不做自签证书

TLS 只有一条生产路径：ACME 自动签发（需要域名 + 公网 IP，且 80 或 443 至少有一个从公网可达 —— HTTP-01 走 80，TLS-ALPN-01 走 443）。

- 自签证书在 iOS 上要装描述文件，体验很差，且会长期成为排障噪音来源。
- 本地开发不需要它：`http://localhost:PORT` 本身就是 secure context，PWA / Service Worker / 剪贴板 API 全都能用。

所以 TLS 代码路径只有两条：`--dev`（localhost 明文）和生产（autocert）。见 [ADR-0004](../20-architecture/adr/0004-acme-only-tls.md)。

### 终端输出不落盘

环形缓冲与 agent 侧的终端模拟器都只在内存里。落盘的只有设备与认证数据，不记命令历史。

因为输出里可能有密钥、token、日志中的敏感数据。会话录像功能如果将来要做，必须是显式开关 + 明确告知。见 [`../60-security/privacy-history.md`](../60-security/privacy-history.md)。

---

## 二、推迟到 v0.2 的（不是否决，是排期）

| 功能 | 为什么不在 v0.1 |
|---|---|
| 文件浏览与上传下载 | 独立的功能面，不影响核心通路的验证 |
| 桌面端分屏 | 布局复杂度高，收益集中在桌面端 —— 而桌面端本来就有本地终端可用 |
| Passkey / WebAuthn 登录 | v0.1 的配对码 + 长效 Cookie 已经够用，Passkey 是体验优化 |

---

## 三、明确不追求的性质

- **不追求兼容所有终端特性**。sixel 图像、终端音频、复杂鼠标协议等，除非有具体需求，否则不做。
- **不追求支持老旧浏览器**。目标是现代 Chrome / Safari / Firefox，可以放心用 `visualViewport`、`ResizeObserver`、CSS `env()`。
- **不追求 agent 的横向扩展**。一个 agent 服务一个人的一台机器，没有集群、没有负载均衡。
- **不追求零延迟输入**。不做 mosh 式的本地回显预测（v0.1）。慢网下的长段输入可以用文本输入页在本地打完一次送出，规避逐键往返。
