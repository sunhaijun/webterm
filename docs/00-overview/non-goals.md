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
- 持久化和断线回放由 agent 的环形缓冲负责，tmux 在这里提供不了更好的东西（它只能重画屏幕，给不出增量）。

**代价（重要，已明确接受）：agent 进程重启 = 所有会话消失。**

PTY 的 master fd 由 agent 持有，agent 一死，shell 收到 `SIGHUP` 就没了。所以升级 webterm、重启服务器，会话都保不住。

为什么接受：**"网络断线"（每天多次）和"进程重启"（很少）是两个不同频率的问题。** 用户的真实痛点是前者，而前者被彻底解决了。

未来可能的补法：升级时用 `ExtraFiles` 把 PTY fd 传给新进程做无损 re-exec。属于 v0.3+，不进 v0.1。见 [ADR-0003](../20-architecture/adr/0003-no-tmux.md)。

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

TLS 只有一条生产路径：ACME 自动签发（需要域名 + 公网 IP + 80/443 端口）。

- 自签证书在 iOS 上要装描述文件，体验很差，且会长期成为排障噪音来源。
- 本地开发不需要它：`http://localhost:PORT` 本身就是 secure context，PWA / Service Worker / 剪贴板 API 全都能用。

所以 TLS 代码路径只有两条：`--dev`（localhost 明文）和生产（autocert）。见 [ADR-0004](../20-architecture/adr/0004-acme-only-tls.md)。

### 不支持 bash 以外的 shell（v0.1）

shell 集成脚本只写 bash。zsh 跟进在 v0.2，fish 再说。

用户仍然可以用任何 shell —— 只是没有 shell 集成，会**降级**为：没有命令历史、没有 CWD 显示、没有输入模式自动切换（需手动切）。终端本身完全正常。

### 不做参数化快捷命令模板

快捷命令不是独立实体，就是"被置顶的历史条目"。点击行为统一为**填入 Composer 待编辑**。

因为"选一条相近的历史命令再改两个字"已经完整覆盖了模板参数的场景，而且更快更自由。少一张表、少一套 CRUD、少一个心智模型。见 [ADR-0008](../20-architecture/adr/0008-pinned-history-as-snippets.md)。

### 终端输出不落盘

环形缓冲只在内存里。落盘的只有命令元数据（原文、CWD、退出码、耗时）。

因为输出里可能有密钥、token、日志中的敏感数据。会话录像功能如果将来要做，必须是显式开关 + 明确告知。见 [`../60-security/privacy-history.md`](../60-security/privacy-history.md)。

---

## 二、推迟到 v0.2 的（不是否决，是排期）

| 功能 | 为什么不在 v0.1 |
|---|---|
| 命令块可视化（折叠 / 跳转 / 块内复制） | 渲染层大改。v0.1 先把 shell 集成的**数据**采上来，UI 后做 |
| 文件浏览与上传下载 | 独立的功能面，不影响核心通路的验证 |
| Web Push 通知（长命令跑完提醒） | 依赖命令结束事件（v0.1 已有），但推送订阅是独立工作量 |
| 桌面端分屏 | 布局复杂度高，收益集中在桌面端 —— 而桌面端本来就有本地终端可用 |
| Passkey / WebAuthn 登录 | v0.1 的配对码 + 长效 Cookie 已经够用，Passkey 是体验优化 |
| zsh / fish shell 集成 | 目标环境是 bash |
| 命令历史全文索引（FTS5） | 几万行历史用 `LIKE` 查询也是毫秒级，等真的慢了再说 |

---

## 三、明确不追求的性质

- **不追求兼容所有终端特性**。sixel 图像、终端音频、复杂鼠标协议等，除非有具体需求，否则不做。
- **不追求支持老旧浏览器**。目标是现代 Chrome / Safari / Firefox，可以放心用 `visualViewport`、`ResizeObserver`、CSS `env()`、WebGL。
- **不追求 agent 的横向扩展**。一个 agent 服务一个人的一台机器，没有集群、没有负载均衡。
- **不追求零延迟输入**。不做 mosh 式的本地回显预测（v0.1）。Composer 模式天然规避了逐键往返的延迟问题，这已经覆盖了大部分场景。
