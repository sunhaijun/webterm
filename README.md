# webterm

一个 Go 单二进制的浏览器终端。不是"网页版终端"，而是把终端当数据源、交互范式重新设计过的 Web 应用。

```
云安全组放行 80/443  →  scp webterm server:  →  ssh -t server ./webterm install  →  扫码  →  开工
```

不需要域名（直接用公网 IP），有域名就加 `--domain term.example.com`。
手边没有二进制就先下载：`gh release download --repo sunhaijun/webterm --pattern webterm-linux-amd64 -O webterm && chmod +x webterm`。
详见 [安装文档](docs/80-ops/install.md)；本地试跑：`./webterm serve --dev`。

## 它解决什么

| 痛点 | webterm 的答案 |
|---|---|
| SSH 断线丢现场 | 短断线只补增量、屏幕接着长；断得久或刷新页面，agent 自己持有的终端状态给出完整快照 |
| 终端里中文输入难用 | 输入法组字兜底直送终端；长段中文切到文本输入页，用原生输入框打完再送 |
| 手机/平板上没法用 | Termux 式界面：全屏终端 + 两行固定附加键；手机用底部会话抽屉，PC / Pad 用顶部标签栏；PWA |
| 回看输出困难 | 直接滚动回看，刷新后仍有 2000 行历史，不用进 copy-mode |

## 状态

v0.1 的七个里程碑（m0–m7）已全部落地。m8 在一个 PR 里做两件事：界面按
[ADR-0025](docs/20-architecture/adr/0025-termux-style-ui.md) 整体换成 Termux 式；输出链路按
[ADR-0026](docs/20-architecture/adr/0026-agent-holds-terminal-state.md) 改成 agent 持有终端状态。
shell 集成与命令历史随之删除。

**自动化验证**：Go 单测与集成测试、前端 144 个单测、30 个 Playwright E2E
（含 ★ 字节级连续性）。**真机部分**（真实输入法、软键盘、真实网络切换、
真实证书签发、PWA 安装）仍需按 [手工清单](docs/70-testing/manual-checklist.md)
过一遍。

先读 [`docs/README.md`](docs/README.md)。

## 开发方式

文档驱动 + worktree 分支。任何改动都从改 `docs/` 开始，见 [CLAUDE.md](CLAUDE.md)。
