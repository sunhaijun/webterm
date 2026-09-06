# 会话交互

> 状态：Accepted

## 会话在 client 侧的表示

```ts
type Session = {
  sid: number
  name: string
  nameIsManual: boolean
  cwd: string | null
  status: 'running' | 'exited'
  exitCode: number | null
  cols: number; rows: number
  integration: 'pending' | 'active' | 'inactive'
  unread: boolean
  createdAt: number

  // 本地状态，不来自服务端
  term: Terminal            // xterm 实例，切走时不销毁
  outSeq: number            // 已接收的累计输出字节数
  inSeqNext: number         // 下一个要分配的输入序号
  pending: PendingInput[]   // 未 ack 的输入
  inputMode: { mode: 'composer' | 'raw'; locked: boolean }
  lastPromptState: 'input' | 'running' | 'done' | null
}
```

**关键：切走的会话不销毁 xterm 实例。** 只把它的 DOM 从容器里摘下来（或用 `display:none` 的容器缓存）。这样切回去时不需要重放缓冲，屏幕内容、滚动位置、选中状态全部保持。

代价是内存：每个 xterm 实例带 5000 行 scrollback。20 个会话上限下可接受。如果实测有压力，策略是对**最久未访问**的会话销毁实例并在切回时通过 `subscribe{out_seq: base_seq}` 走 reset 路径重建 —— 但这是优化，v0.1 不做。

## 订阅策略

**只对当前可见会话 `subscribe`。**

```
切换到会话 X:
  1. unsubscribe(当前会话)
  2. subscribe(X, out_seq: X.outSeq)
  3. 挂载 X.term 的 DOM
  4. X.unread = false
  5. fit() → resize(X)
```

后台会话在 agent 侧照常运行和缓冲。切过去时用 `subscribe{out_seq}` 补齐增量（协议上与 `resume` 同源，见 [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md#52-重连续传流程)）。

**这是移动端的关键优化**：后台会话在跑 `tail -f` 时，未订阅意味着那些字节根本不过网络。

### 例外：不能盲目 unsubscribe

如果只订阅可见会话，那么切走期间超过 `ring_bytes` 的输出就会走 reset（丢历史）。对于"我切走去看别的，回来想看完整构建日志"这个场景是有损的。

**折中**：允许用户对某个会话开启"保持接收"（pin 订阅）。开启后即使切走也保持 `subscribe`，代价是流量。默认关闭，UI 上是会话卡片的一个小图标。

## 未读标记（AC-4.3）

- agent 对未订阅会话产生输出时发 `session.updated{unread:true}`（每会话最多 1s 一条）
- client 在会话列表/卡片/细条上显示未读点
- 切换到该会话时清除
- **`exited` 状态也算一种"需要注意"**：会话退出时（尤其非零退出码）显示带退出码的标记，用不同颜色区分于普通未读

## 自动命名（AC-4.4）

```
name = nameIsManual ? 手动名 : (cwd ? basename(cwd) : "shell")
```

- `cwd` 为 home 目录时显示 `~`
- basename 为空（`/`）时显示 `/`
- 重名时**不做去重后缀** —— 两个都在 `webterm` 目录下的会话本来就该同名，靠顺序和 CWD 全路径区分。加 `(2)` 只会让人困惑
- 手动改名后 `nameIsManual = true`，停止跟随 CWD。改成空字符串则恢复自动

## 各端切换交互（AC-4.2）

### desktop：常驻侧栏

```
● webterm    ~/github/webterm
○ api      ● ~/srv/api              ← 未读点
○ logs       ~/var/log
✕ build      exit 1                 ← 已退出
─────────────────────
+ 新会话
```

- 点击切换
- `Ctrl+Shift+↑/↓` 上下切换（不用 `Ctrl+1..9`：浏览器占用；不用 `Alt+数字`：TUI 的 Meta 键会用到）
- `Ctrl/Cmd+K` 命令面板里也能模糊搜索会话
- 右键/`⋯` 菜单：重命名、保持接收、关闭

### tablet：覆盖式抽屉

同 desktop 的列表，从左边缘滑出或点按钮。**打开时终端不重排**（覆盖 + 遮罩），避免每次开关都触发 resize。

### phone：底部 sheet + 滑动

**底部 sheet**（点顶部细条打开）：

```
┌─────────────────────────────────┐
│ ●  webterm      ~/github/webterm│
│    $ go test ./...              │  ← 最后 3 行输出预览
│    ok  webterm/internal/ring    │
│─────────────────────────────────│
│ ●  api       ● ~/srv/api        │  ← 未读
│    2026/09/06 12:03 listening   │
│─────────────────────────────────│
│ ✕  build        exit 1          │
│─────────────────────────────────│
│           + 新会话              │
└─────────────────────────────────┘
```

卡片式，带输出预览 —— 这样不用切进去就知道哪个会话在干什么。这是手机上的关键体验：小屏幕上标签页太小，卡片才点得准。

**左右滑动切换**：在终端区水平滑动切到相邻会话。

- 需要与 xterm 的文本选择区分：**只在滑动起点距左右边缘 24px 内**才认定为切换手势，中间区域的水平拖动仍是文本选择
- 阈值：位移 > 80px 或速度 > 0.5 px/ms
- 切换时有横向位移动画（`prefers-reduced-motion` 下省略）

## 新建会话

- `cwd` 默认继承**当前会话**的 CWD（比"总是 home"实用得多 —— 通常是想在同一个项目里再开一个）
- 没有当前会话时用 home
- `cols`/`rows` 用当前终端尺寸
- 创建后自动切换过去
- 达到上限时（AC-4.2）新建按钮变为禁用态并显示 `会话数已达上限 20`，不是点了没反应（US-7.3）

## 关闭会话

| 会话状态 | 行为 |
|---|---|
| `running` | **需要二次确认**（"会话内可能有正在跑的程序"），确认后发 `session.close` |
| `exited` | 直接关闭，无需确认（内容已经没了活的进程） |

关闭后切换到相邻会话；没有其它会话时显示空状态页（带"新建会话"按钮）。

## 已退出会话的保留（AC-4.5）

shell 退出后：

- 状态变 `exited`，卡片/列表项显示 `exit <code>`（非零用警示色）
- **缓冲内容保留可查看、可滚动、可搜索、可复制**
- Composer 收起为一条提示带：`会话已结束（exit 1）· 重开 · 关闭`
- 「重开」= 在同一个 `cwd` 新建会话（不是复活旧的 —— 那不可能）

这个设计是为了"构建失败了，我要回看最后的报错"这个高频场景。标签直接消失是最糟的行为。

## 连接状态指示（AC-2.10）

顶部细条上的一个圆点 + 文字（phone 的 `short` 布局下只有圆点）：

| 状态 | 显示 |
|---|---|
| 在线 | 绿点。RTT > 300ms 时附 `320ms` |
| 重连中 | 橙点脉冲 + `重连中 · 3s 后重试`（倒计时实时更新） |
| 已恢复 | 绿点 + 短暂 toast：`已恢复 · 补齐 48 KB`，3 秒后消失 |
| 缓冲截断 | 会话内顶部插入一条分隔线：`── 历史输出已截断 ──`（AC-2.6） |
| 会话已结束（gone） | toast：`会话已结束（agent 可能已重启）` |

「补齐 N KB」这个信息看起来多余，但它让用户**确信没丢东西** —— 这是"永不断线"这个承诺的可见证据。

## 搜索（AC-5.2）

`Ctrl/Cmd+F` 打开搜索框（移动端从 `⋯` 菜单进）。用 xterm 的 `SearchAddon`：

- 实时显示命中数与当前位置（`3 / 17`）
- `Enter` / `Shift+Enter` 前后跳转
- 大小写敏感开关、整词匹配开关
- `Esc` 关闭并恢复滚动位置
- **只搜当前会话的 scrollback**（不是跨会话，也不是命令历史 —— 那是命令面板的事）
