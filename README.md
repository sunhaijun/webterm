# webterm

一个 Go 单二进制的浏览器终端。不是"网页版终端"，而是把终端当数据源、交互范式重新设计过的 Web 应用。

```
scp webterm user@server:  →  ./webterm serve --domain term.example.com  →  扫码 →  开工
```

> 装：`install.sh` 默认取最近的正式 release（`--channel dev` 取 `main` 的滚动构建）。
> **仓库还是私有的**，`raw.githubusercontent.com` 与 `releases/download` 都不带凭据，
> 取脚本和二进制都要 `gh auth login` 或 `GH_TOKEN` —— 命令见 [安装文档](docs/80-ops/install.md)。
> 也可以从源码构建（Go 1.27+ 与 Node 22+）：
> `cd web && npm ci && npm run build && cd .. && CGO_ENABLED=0 go build -o webterm ./cmd/webterm`
> 本地试跑：`./webterm serve --dev`。

## 它解决什么

| 痛点 | webterm 的答案 |
|---|---|
| SSH 断线丢现场 | 服务端环形缓冲 + 序列号，重连只回放增量，屏幕接着长 |
| 终端里中文输入难用 | Composer 模式：独立输入框，IME 组字与终端完全隔离 |
| 手机/平板上没法用 | 响应式布局、功能键条、PWA、会话卡片式切换 |
| 回看输出困难 | 原生滚动 + 全文搜索，不用进 copy-mode |
| 命令记不住、重复敲 | 完整命令历史（含退出码/耗时），一键置顶成快捷命令 |

## 状态

v0.1 的七个里程碑（m0–m7）已全部落地：协议与会话核心、agent 服务、前端骨架、
双模输入、shell 集成、多会话与 PWA、命令历史与快捷命令。

**自动化验证**：Go 单测与集成测试、前端 144 个单测、30 个 Playwright E2E
（含 ★ 字节级连续性）。**真机部分**（真实输入法、软键盘、真实网络切换、
真实证书签发、PWA 安装）仍需按 [手工清单](docs/70-testing/manual-checklist.md)
过一遍。

先读 [`docs/README.md`](docs/README.md)。

## 开发方式

文档驱动 + worktree 分支。任何改动都从改 `docs/` 开始，见 [CLAUDE.md](CLAUDE.md)。
