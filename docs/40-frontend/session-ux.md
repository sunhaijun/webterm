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
  createdAt: number

  // 本地状态，不来自服务端
  term: Terminal            // xterm 实例，切走时不销毁
  outSeq: number            // 已接收的累计输出字节数
  headSeq: number           // agent 侧该会话的累计产出字节数（未读 = headSeq > outSeq）
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
  4. （未读随 outSeq 追上 headSeq 自动消失）
  5. fit() → resize(X)
```

后台会话在 agent 侧照常运行和缓冲。切过去时用 `subscribe{out_seq}` 补齐增量（协议上与 `resume` 同源，见 [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md#52-重连续传流程)）。

**这是移动端的关键优化**：后台会话在跑 `tail -f` 时，未订阅意味着那些字节根本不过网络。

### 例外：不能盲目 unsubscribe

如果只订阅可见会话，那么切走期间超过 `ring_bytes` 的输出就会走 reset（丢历史）。对于"我切走去看别的，回来想看完整构建日志"这个场景是有损的。

**折中**：允许用户对某个会话开启"保持接收"（pin 订阅）。开启后即使切走也保持 `subscribe`，代价是流量。默认关闭，UI 上是会话卡片的一个小图标。

## 未读标记（AC-4.3）

- **未读是 client 推导出来的，不是服务端状态**：`unread = headSeq > outSeq`
- agent 对未订阅会话产生输出时发 `session.updated{head_seq}`（每会话最多 1s 一条）
- 之所以不让服务端存一个 `unread` 布尔量：未读天然是 per-client 的，两个标签页会互相清对方的未读
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

## 回看时暂停跟随（AC-5.9）

滚动缓冲完全在浏览器里（xterm 5000 行），往上滚不跟服务端交互。卡的是另一件事：用户在读旧输出，底下 claude 的 spinner、`tail -f`、构建日志还在每秒几十帧地进来，每帧都要解析、标脏、渲染，和滚动抢主线程。所以：

- **视口一离开底部，实时帧只入队不写 xterm**（`web/src/term/outputqueue.ts`）。判定用 `onScroll`：`viewportY < buffer.baseY` 即滚上去了。备用缓冲（vim / less）没有 scrollback，永远算贴底。
- 终端右下角出现提示条 **「已暂停跟随 · 新增 N 行 ↓」**（`data-testid="follow-pill"`；没有换行的整屏重绘显示「有新输出」）。点它 = `scrollToBottom()`。
- **回到底部一次写完**：顺序不变、一个字节不丢。序号与 ack 在连接层收到时就记好了，跟这里写不写无关（续传的字节级一致性不受影响）。触发写入的时刻：用户滚到底、点提示条、**输入**（xterm `scrollOnUserInput` 会滚到底）、占屏程序启动（`applyInteractive` 滚到底）、回放帧到达（回放前先把队列排空，保证顺序）。
- **上限**：暂停期间攒到 2 MiB 或 4000 行就强制写入 —— 再多也会被 scrollback 裁掉；强制写入不动视口。
- **回放帧不暂停也不合并**：它是一段有界的补课。`terminal.reset()`（reset 续传）时清空队列 —— 屏幕要按服务端缓冲重建。
- 贴底时的实时帧也走这个队列，**同一帧内到达的多个包合成一次 `write`**：解析与渲染次数按帧算而不是按包算。

- **判定自愈**：每一帧实时输出到达时按真实视口位置（`viewportY >= baseY`）校正一次跟随状态，不单靠 `onScroll` —— 它可能漏、可能报中间位置。点提示条走 `store.follow()`：`scrollToBottom()` 在已经贴底时不发 `onScroll`，所以要显式恢复跟随。

多端：手机 / 平板的单指滚动走的也是 xterm 视口，判定与提示一致；提示条在 `.canvas` 里绝对定位，落在底部键行之上、不被双指缩放的 transform 影响；编辑面板升起时会盖住它 —— 那时用户在写不在读。

**不开 `smoothScrollDuration`**。试过 80ms：xterm 5.5 的平滑滚动用 DOM `scrollTop` 动画实现，持续输出时和它自己的 `syncScrollArea` 打架，程序化 `scrollLines` 会被吞掉或只动一格，`onScroll` 报的位置与最终视口对不上。滚轮按行跳的台阶感是小事，跟随判定出错是大事。

## 渲染器可见（AC-5.10）

WebGL 加载失败或上下文丢失时静默回退到 canvas（AC-5.5），以前从界面上看不出来。设置面板里显示「渲染 WebGL / Canvas」（`data-testid="renderer"`），滚动明显更卡时先看这一眼。

## 搜索（AC-5.2）

`Ctrl/Cmd+F` 打开搜索框（移动端从 `⋯` 菜单进）。用 xterm 的 `SearchAddon`：

- 实时显示命中数与当前位置（`3 / 17`）
- `Enter` / `Shift+Enter` 前后跳转
- 大小写敏感开关、整词匹配开关
- `Esc` 关闭并恢复滚动位置
- **只搜当前会话的 scrollback**（不是跨会话，也不是命令历史 —— 那是命令面板的事）
