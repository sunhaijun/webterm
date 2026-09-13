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
  2. 挂载 X.term 的 DOM → fit()
  3. resize(X, 新尺寸)              ← 必须早于 subscribe，且【不防抖】
  4. subscribe(X, out_seq: X.outSeq)
  5. （未读随 outSeq 追上 headSeq 自动消失）
```

**第 3 步的位置是有讲究的。** `fit()` 一调用，xterm 就已经是新尺寸了；这时候先 `subscribe`，agent 回放的是**按旧尺寸排版**的积压 —— 全屏程序的绝对定位与超宽行的折行位置全部对不上，屏幕花掉，而且要等到下一次整屏重绘才自愈。`resize` 排在前面，agent 先把 PTY 调到新尺寸（程序收到 SIGWINCH 自己重画），回放与渲染才在同一套几何下。防抖也要去掉：防抖是给连续拖动用的，切会话是单次事件，晚 100ms 就晚在了 `subscribe` 后面。

后台会话在 agent 侧照常运行和缓冲。切过去时用 `subscribe{out_seq}` 补齐增量（协议上与 `resume` 同源，见 [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md#52-重连续传流程)）。

**这是移动端的关键优化**：后台会话在跑 `tail -f` 时，未订阅意味着那些字节根本不过网络。

### 例外：不能盲目 unsubscribe

如果只订阅可见会话，那么切走期间超过 `ring_bytes` 的输出就会走 reset（丢历史）。对于"我切走去看别的，回来想看完整构建日志"这个场景是有损的。

**走 reset 时必须清屏重建，不能接在旧内容后面。** 这条路上客户端手里还留着切走前的那一屏，而 agent 回放的是缓冲窗口里一段**接不上**的内容 —— 直接写进去就是在旧屏幕后面叠一份，来回切几次叠几份（"很多份 logo"的由来）。清屏由回放帧上的 `ATTR_PREFIX` 驱动（协议 §3），`reset` 消息只负责"历史输出已截断"那条提示。备用屏程序（claude / vim / top）在这条路上还有更深的问题，见 [ADR-0019](../20-architecture/adr/0019-altscreen-redraw-not-replay.md)。

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

### tablet / phone：底部浮层

同 desktop 的列表，装在与历史 / 命令面板 / 设置同一个 `Drawer` 壳里（[ADR-0018](../20-architecture/adr/0018-one-drawer-primitive.md)）：点顶部细条或 ⋯ → 会话打开，贴底、整宽、带抓手，点遮罩 / `Esc` / ✕ / 下滑都能关。**打开时终端不重排**（`fixed` 覆盖 + 遮罩），避免每次开关都触发 resize。

平板上它**也从底部出来**，不是左侧抽屉 —— ⋯ 菜单里四项打开的是同一种东西，位置不该按项目变。

```
┌─────────────── ═══ ─────────────┐
│ 会话                          ✕ │
├─────────────────────────────────┤
│ ●  webterm      ~/github/webterm│
│ ●  api       ● ~/srv/api        │  ← 未读
│ ✕  build        exit 1          │
│ ─────────────────────────────── │
│           + 新会话              │
└─────────────────────────────────┘
```

**一行一个会话**，和 desktop 侧栏同一份列表（状态点 · 名字 · CWD / 退出码 · 未读点 · ⇵ ✎ ✕）。触屏下行高 52px、三个图标常显且各有 44×44 的命中区。

> **不做卡片式列表。** 早先的设计是卡片 + 每个会话最后 3 行输出预览（"不切进去就知道哪个在干什么"）。它要求 client 持有非活动会话的输出，而**只订阅当前会话**是移动端最关键的省流优化（见上面 [§订阅策略](#订阅策略)）—— 为了预览把所有会话的字节都拉过来，代价和收益不成比例。未读点已经回答了"哪个会话有动静"这个问题。

### 左右滑动切换（AC-4.7）

在终端区单指水平滑动切到相邻会话：**左滑 = 下一个，右滑 = 上一个**，到头回绕（与 `Ctrl+Shift+↑/↓` 的 `step(±1)` 同一套顺序）。

终端区的单指手势现在有三种用途，靠**轴锁**仲裁 —— 前 12px 谁占优谁拿走整段手势，锁定后不再改判：

| 条件 | 手势 | 动作 |
|---|---|---|
| 1×，纵向占优 | 单指上下拖 | 滚 scrollback（`.xterm-viewport.scrollTop`） |
| 1×，横向占优 | 单指左右拖 | **切会话**（本节） |
| 放大态（> 1×） | 单指拖 | 平移放大后的画面（横向也不切会话） |
| 任意 | 双指 | 缩放（[ADR-0013](../20-architecture/adr/0013-terminal-only.md) §4） |

- **阈值**：位移 > 80px **或**速度 > 0.5 px/ms；速度这条另加 24px 的位移下限，免得一次轻微的甩动就切走
- **只有一个会话时不接管横向手势**（没有可切的目标，别给假反馈）
- **动画**：拖动时当前终端跟着手指横移（纯 CSS `transform`，**不 fit、不发 resize**）；松手切换后新终端从手指来的方向接着滑进来（160ms），没过阈值则弹回。`prefers-reduced-motion` 下整段省略：不跟手、不滑入，只做切换
- **不再有"起点距边缘 24px 内才算"这条**。它原本是为了和 xterm 的文本选择共存，而 [ADR-0013](../20-architecture/adr/0013-terminal-only.md) 之后 `.term` 是 `touch-action: none`、单指手势全部由 `pinch.ts` 接管，触屏上本来就选不了文本；何况 24px 边缘区正是 iOS Safari 标签页里系统返回手势的地盘，抢不过也不该抢

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

- **视口一离开底部，实时帧只入队不写 xterm**（`web/src/term/outputqueue.ts`）。判定只有一个标准：`viewportY < baseY` 即滚上去了。备用缓冲（vim / less）没有 scrollback，永远算贴底。
- **怎么知道视口动了**：两路都听。xterm 的 `onScroll` 只在**程序化**滚动时来（`scrollLines` / `scrollToBottom`、以及输出把缓冲推着走）；滚轮、触屏拖动、拖滚动条这些 **DOM 驱动的滚动它不报** —— xterm 5.5 的 Viewport 把它们一律标成 `suppressScrollEvent`。所以另外监听 `.xterm-viewport` 的 DOM `scroll` 事件（终端 `open()` 之后才有这个元素）。两路回调都不看事件本身带的位置，只按当时的真实视口位置判定 —— 单靠 `onScroll` 的版本 e2e 能过（用的是程序化 `scrollLines`）而真机不过，教训在此。
- 终端右下角的提示条（`data-testid="follow-pill"`）**视口一离开底部就出现，与有没有新输出无关**：还没有新输出时写 **「回到底部 ↓」**；有新输出后写 **「已暂停跟随 · 新增 N 行 ↓」**（没有换行的整屏重绘写「有新输出」）。用户滚上去读完旧输出，总要有个一键回底的东西，不能只在输出流动时才给。点它 = `scrollToBottom()`。
- **回到底部一次写完**：顺序不变、一个字节不丢。序号与 ack 在连接层收到时就记好了，跟这里写不写无关（续传的字节级一致性不受影响）。触发写入的时刻：用户滚到底、点提示条、**输入**（xterm `scrollOnUserInput` 会滚到底）、占屏程序启动（`applyInteractive` 滚到底）、回放帧到达（回放前先把队列排空，保证顺序）。
- **上限**：暂停期间队列攒到 2 MiB 或 4000 行就强制写入 —— 再多也会被 scrollback 裁掉；强制写入不动视口。提示条的计数是**暂停以来的新增总量**，强制写入不清零 —— 那些行用户还没看到，提示条也不该因此闪一下变成「回到底部」。
- **回放帧不暂停也不合并**：它是一段有界的补课。`terminal.reset()`（reset 续传）时清空队列并恢复跟随 —— 屏幕要按服务端缓冲重建，重建完视口在底部。
- 贴底时的实时帧也走这个队列，**同一帧内到达的多个包合成一次 `write`**：解析与渲染次数按帧算而不是按包算。

- **判定自愈**：每一帧实时输出到达时按真实视口位置（`viewportY >= baseY`）再校正一次跟随状态，不单靠两路滚动回调 —— 它们可能漏、可能报中间位置。点提示条走 `store.follow()`：`scrollToBottom()` 在已经贴底时不发 `onScroll`，所以要显式恢复跟随。

多端：手机 / 平板的单指滚动是 `pinch.ts` 直接改 `.xterm-viewport` 的 `scrollTop`，走的正是上面说的 DOM `scroll` 那一路，判定与提示和桌面一致；提示条在 `.canvas` 里绝对定位，落在底部键行之上、不被双指缩放的 transform 影响；编辑面板升起时会盖住它 —— 那时用户在写不在读。

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
