# webterm

一个 Go 单二进制的浏览器终端。不是"网页版终端"，而是把终端当数据源、交互范式重新设计过的 Web 应用。

```
scp webterm user@server:  →  ./webterm serve --domain term.example.com  →  扫码 →  开工
```

## 它解决什么

| 痛点 | webterm 的答案 |
|---|---|
| SSH 断线丢现场 | 服务端环形缓冲 + 序列号，重连只回放增量，屏幕接着长 |
| 终端里中文输入难用 | Composer 模式：独立输入框，IME 组字与终端完全隔离 |
| 手机/平板上没法用 | 响应式布局、功能键条、PWA、会话卡片式切换 |
| 回看输出困难 | 原生滚动 + 全文搜索，不用进 copy-mode |
| 命令记不住、重复敲 | 完整命令历史（含退出码/耗时），一键置顶成快捷命令 |

## 状态

需求已收敛，正在建立文档基线。实现尚未开始。

先读 [`docs/README.md`](docs/README.md)。

## 开发方式

文档驱动 + worktree 分支。任何改动都从改 `docs/` 开始，见 [CLAUDE.md](CLAUDE.md)。
