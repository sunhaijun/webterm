# ADR-0002 自包含单二进制，不依赖外部平台

> 状态：Accepted · 2026-09-06

## 背景

初始方案是 Cloudflare 全家桶：Pages 托管前端 + Tunnel 打通内网 + Access 做身份认证。看起来能"免费拿到认证 + 无入站端口"。

## 决策

**一个 Go 二进制就是完整的服务。** 它用 `go:embed` 自带前端资源，自己终结 TLS，自己做认证，自己管会话。不依赖 Cloudflare、不依赖反向代理、不依赖外部数据库、不依赖额外进程。

```
./webterm serve --domain term.example.com
```

## 否决 Cloudflare 方案的理由

### 1. 跨域认证是个实打实的坑

Pages 在 `app.example.com`，agent 经 Tunnel 暴露在 `term.example.com` —— WebSocket 就是跨域的。Cloudflare Access 靠 `CF_Authorization` Cookie 鉴权，跨站场景下 WebSocket 握手会被 302 到登录页然后**静默失败**，极难排查。

而"用同一个域名"做不到：DNS 只能解析到一个源，不能同时指向 Pages 和 Tunnel。

### 2. 它让完整的自动化测试变得不可能

需求里有明确的"自动化测试"要求，而核心功能是**断线重连**。要验证它，测试必须能精确控制 WebSocket 的断开时机。链路上只要有 Tunnel/Access 这样的外部组件，端到端测试就只能测半条链路。

这条是决定性的：**可测性是架构属性，不是附加项。**

### 3. 三个外部依赖换来的东西可以自己做

| Cloudflare 提供 | 我们自己的方案 |
|---|---|
| Access 身份认证 | 配对码 + 长效设备 Cookie（单用户场景足够，见 [ADR-0004](0004-acme-only-tls.md) 相邻的认证设计） |
| Tunnel 无入站端口 | 需要开 443。这是真实的代价，见下 |
| Pages CDN 分发前端 | 前端几百 KB，从 agent 直接发，无感 |
| WAF / DDoS 防护 | 失去了。这是真实的代价，见下 |

## 后果

**正面**：
- **同源**：没有 CORS、没有跨站 Cookie、没有 WebSocket 握手被重定向的问题
- 没有中间层的 idle 超时和按时长计费
- 延迟最低
- 部署 = `scp` + 跑起来。无配置面板、无 DNS 托管迁移
- **完整链路可在 CI 内启动**，端到端测试（含掐断 WebSocket 验证续传）可以真做

**负面（真实代价，已接受）**：
- **需要暴露 443 到公网**。缓解措施见 [`../../60-security/threat-model.md`](../../60-security/threat-model.md)：强制认证前置、配对码限速与退避、支持 `--bind 127.0.0.1`（配合 SSH 隧道或用户自己套的隧道）。
- **失去 WAF / DDoS 防护**。缓解：路由面极小（静态资源 + 少量 REST + 一个 WS），无未认证的动态入口，认证前的处理成本极低。

## 关键性质：这个决定不烧桥

agent 本质上就是一个提供 HTTP + WebSocket 的普通服务。将来想套 Cloudflare Tunnel、Tailscale、nginx、frp，都是**零代码改动的外部编排**：

```
./webterm serve --bind 127.0.0.1:8080 --no-tls   # 然后让隧道/代理接管
```

所以现在选最简的，将来不后悔。为此必须保留 `--bind` 和 `--no-tls`（仅限非公网监听）这两个开关，并在反向代理场景下正确处理 `X-Forwarded-For`（用于限速）与 `Origin` 校验。
