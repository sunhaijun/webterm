# ADR-0004 TLS 只做 ACME 一档

> 状态：Accepted · 2026-09-06
> 补充：[ADR-0044](0044-ip-address-certificates.md)（2026-10-31）—— Let's Encrypt 开始签 IP 证书后，`--domain` 也接受公网 IPv4，不需要域名也能部署。下文「否决 sslip.io 兜底」仍然成立：IP 证书比借别人的域名更直接。

## 背景

曾考虑三档 TLS 策略：(1) 有域名走 ACME，(2) 无域名走 `sslip.io` 泛解析域名拿证书，(3) 纯内网用自签证书。

实际部署环境确认为：**有公网 IP、有域名、80/443 可用**。

## 决策

**生产环境只支持 ACME 自动签发（`golang.org/x/crypto/acme/autocert`）。删除自签证书与 `sslip.io` 兜底逻辑。**

TLS 代码路径只有两条：

| 模式 | 命令 | 监听 | 说明 |
|---|---|---|---|
| 生产 | `webterm serve --domain X` | `:80`（ACME HTTP-01 + 跳转 HTTPS）、`:443` | 自动签发与续期 |
| 生产（换端口） | 加 `--https-port 8443` | `:80`、`:8443` | 443 被别的服务占时。签发走 80 上的 HTTP-01；对外 URL 会带上端口 |
| 开发 | `webterm serve --dev` | `127.0.0.1:8080` 明文 | `localhost` 本身是 secure context |

## 为什么 TLS 是硬性要求，不是可选项

不只是传输安全。**没有 secure context，一半产品需求直接死掉**：

| 能力 | 需要 secure context |
|---|---|
| PWA 安装到主屏 / Service Worker | 必须 |
| Clipboard API（复制输出） | 必须 |
| Web Push（长命令跑完提醒，v0.2） | 必须 |

关键点：`localhost` 算 secure context，但 `http://192.168.1.10:8080` **不算**。所以远程访问必须上 TLS，没有"内网就不用了"这个选项。

## 否决自签证书

- iOS 上要装配置描述文件才能信任，体验很差
- 会成为长期的排障噪音来源（"为什么手机上打不开" → 十次里九次是证书）
- **本地开发根本不需要它**：`http://localhost:PORT` 已经是 secure context

## 否决 sslip.io 兜底

`1-2-3-4.sslip.io` 这类泛解析域名能解析到对应 IP，因此确实可以正常签发 Let's Encrypt 证书 —— 技术上可行，是个不错的"没域名也能有 HTTPS"的路子。

**但当前环境有域名**，为一个不存在的场景保留一条代码路径是纯粹的成本。如果将来真的需要，再写新 ADR。

## 实现要点

- `autocert.Manager` 的 `HostPolicy` 严格限定为 `--domain` 的值，**不允许通配** —— 否则会被用来给任意域名申请证书
- 证书缓存目录 `~/.local/share/webterm/certs`，权限 `0700`
- `:80` 除了 ACME 的 `/.well-known/acme-challenge/` 之外，一律 301 到 HTTPS
- HSTS：`Strict-Transport-Security: max-age=31536000`（`--dev` 下不发）
- **失败时给人看得懂的错误**（US-7.2 / AC-1.13）。至少覆盖这几种：
  - 80 端口被占用 → 提示查 `ss -lntp`，说明 HTTP-01 挑战需要 80
  - DNS 未指向本机 → 打印解析结果与本机公网 IP 的对比
  - Let's Encrypt 限流 → 说明限流窗口，建议先用 `--acme-staging` 调通
- 提供 `--acme-staging` 开关，用 Let's Encrypt staging 环境调试部署，避免撞正式环境的限流（**已由 [ADR-0044](0044-ip-address-certificates.md) §3 删除**：它和正式证书共用缓存，用了反而会让正式服务发 staging 证书；装前自检改为直接签正式证书）
- 保留 `--bind` 与 `--no-tls`（仅允许绑定到回环或私有地址），用于用户自己套反向代理/隧道的场景 —— 见 [ADR-0002](0002-self-contained-binary.md)

## 后果

- 部署前置条件变成硬要求：**必须有域名、必须能解析到本机、80/443 必须可用**（域名一条已由 ADR-0044 放宽为「域名或公网 IPv4」）。这些写进 [`../../80-ops/install.md`](../../80-ops/install.md) 的前置检查，并由 `webterm doctor` 子命令在启动前主动检测。
- 测试用本地 ACME 服务器（pebble）验证签发流程（IT-tls-1），不打真实 Let's Encrypt。
