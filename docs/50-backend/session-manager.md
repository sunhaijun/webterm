# 会话管理

> 状态：Accepted

## 职责边界

| 组件 | 职责 |
|---|---|
| `SessionManager` | `sid` 分配、会话表、上限控制、生命周期编排 |
| `Session` | 一个 PTY + 一个环形缓冲 + 订阅者集合 + OSC 状态机 |
| `Conn` | 一条 WebSocket 连接。持有它对各会话的订阅与 `in_ack` |

**`Session` 不知道 WebSocket 的存在** —— 它只有一个"订阅者"接口。这让会话逻辑可以在没有网络的情况下单测（IT-session-*）。

```go
type Subscriber interface {
    // 推送输出。实现方必须非阻塞（内部有界队列，满则自行断开）。
    Push(sid uint16, seq uint64, data []byte)
    // 控制事件（prompt 状态、cwd、命令生命周期）
    Event(sid uint16, ev Event)
}
```

## 数据结构

```go
type SessionManager struct {
    mu       sync.RWMutex
    sessions map[uint16]*Session
    nextSID  uint16
    maxSess  int              // 默认 20
    store    *store.Store
    cfg      Config
}

type Session struct {
    sid    uint16
    ptmx   *os.File           // PTY master
    cmd    *exec.Cmd
    rcPath string             // 临时 rcfile，销毁时删除

    mu        sync.RWMutex    // 保护以下所有字段
    name      string
    nameManual bool
    cwd       string
    status    Status          // running | exited
    exitCode  *int
    cols, rows uint16
    integration Integration   // pending | active | inactive
    ring      *ringbuf.Buffer // 内部自带 base/head seq
    subs      map[*Conn]struct{}

    osc      *oscparse.Parser  // 流式状态机
    pendCmd  string            // 待结算的命令原文
    curCmdID *int64            // 进行中的 commands 行主键
    curCmdAt time.Time

    inputCh  chan []byte      // 有界，容量 64，满则阻塞发送方（写侧背压）
    done     chan struct{}
}
```

### 锁的规则

- **`ring` 的内容与它的 seq 必须在同一把锁下更新。** 否则续传会算错切片位置 —— 这是最容易出错的地方。
- `Session.mu` 是读写锁：`readLoop` 写（append），订阅者列表读多写少。
- **不要在持有 `Session.mu` 时调用 `Subscriber.Push`。** 先在锁内拷出订阅者列表和数据切片，出锁再推。否则一个慢订阅者会卡住 PTY 读取。

## `sid` 分配

`uint16` 递增，跳过仍在使用的值，回绕后从 1 重新找空位（0 保留为无效值）。

**不复用刚释放的 sid**（至少隔一轮回绕），避免"客户端还没处理完 sid=3 的关闭，新会话又叫 sid=3"这类竞态。

## 三个 goroutine

### `readLoop`

```
for {
    n, err := ptmx.Read(buf)          // buf 32 KiB
    if err != nil { break }           // EIO = shell 退出
    clean, events := osc.Feed(buf[:n])  // 剥离 + 抽取事件

    session.mu.Lock()
    seq := ring.Append(clean)          // 返回本段起始 seq
    subs := copySubs()
    session.mu.Unlock()

    for _, s := range subs { s.Push(sid, seq, clean) }
    for _, ev := range events { handleEvent(ev) }   // 落库 + 广播
}
```

**关键顺序**（[ADR-0006](../20-architecture/adr/0006-agent-side-osc-parsing.md)）：`Feed` 剥离 → `Append` 计数。`out_seq` 永远等于 `clean` 字节的累计数。

`clean` 为空（这一批全是 OSC）时不 append、不推送，但仍处理事件。

### `writeLoop`

```
for data := range inputCh {
    n, err := ptmx.Write(data)
    if err != nil { break }
    conn.addAck(sid, n)                // in_ack += n，节流后发 ack
}
```

`inputCh` 有界（容量 64）。满时阻塞发送方 —— 这是**期望行为**：输入是用户驱动的低频事件，如果 PTY 写不进去（shell 卡住），背压到客户端比丢输入正确。

### `waitLoop`

```
err := cmd.Wait()
session.mu.Lock()
status = Exited
exitCode = extractExitCode(err)
session.mu.Unlock()
close(inputCh)                          // 停止接受输入
broadcast(session.closed / session.updated{status:"exited"})
// ring 保留，不释放（AC-4.5）
os.Remove(rcPath)
```

**`ring` 在 `exited` 后保留**，直到用户显式 `session.close`。这是"构建失败了要回看报错"场景的支撑（AC-4.5）。

## 生命周期

```
（不存在）──create──> running ──shell 退出──> exited ──close──> （销毁）
                        │
                        └──close──> SIGHUP ──2s──> SIGKILL ──> （销毁）
```

### 创建

```
1. 检查上限          → 超出返回 error{session_limit}
2. 校验参数          → cols/rows 必须 > 0 且 <= 1000
3. 生成 rcfile       → shellinit.Render()，0600，运行时目录
4. 解析 cwd          → 默认继承请求里的值，否则 home；必须存在且是目录
5. exec.Command("bash", "-i", "--rcfile", rcPath)
   环境：继承 agent 环境 + TERM=xterm-256color + WEBTERM_SESSION=<sid>
   清理：BASH_ENV、ENV
6. pty.StartWithSize(cmd, &pty.Winsize{...})
7. 起三个 goroutine
8. integration = pending，10 秒定时器
9. 落库无（会话不持久化，见 ADR-0005）
```

`TERM` 固定为 `xterm-256color`。不用 `xterm-kitty` 之类 —— xterm.js 的能力集与 `xterm-256color` 最匹配。

### 关闭

```
running:
  1. syscall.Kill(-pgid, SIGHUP)     // 负 pgid：杀整个进程组
  2. select { <-done | <-time.After(2s) }
  3. 超时 → syscall.Kill(-pgid, SIGKILL)
  4. ptmx.Close()、删 rcfile、释放 ring、从表里摘除
exited:
  直接执行 3–4
```

**必须杀进程组而不是单个进程**（`-pgid`），否则 shell 的子进程会变成孤儿继续跑。`pty.Start` 已经建立了新的会话与进程组（`setsid`）。

## 自动命名（AC-4.4）

```go
func (s *Session) displayName() string {
    if s.nameManual { return s.name }
    if s.cwd == "" { return "shell" }
    if s.cwd == home { return "~" }
    if b := filepath.Base(s.cwd); b != "" && b != "/" { return b }
    return "/"
}
```

收到 `cwd` 事件时：更新 `s.cwd`；若 `!nameManual` 且名字发生变化，广播 `session.updated{name, cwd}`。

**不做重名去重**（不加 `(2)` 后缀）—— 两个都在 `webterm` 目录下的会话本来就该同名。

## 集成状态机（AC-7.6）

```
pending ──收到 OSC 1701;hello──> active
pending ──10 秒超时──────────> inactive
active  ──连续 2 个命令周期没有 133 标记──> inactive
```

"命令周期"的判定：收到 `prompt{state:"running"}`（即 `133;C`）算一个周期开始。如果在 `readLoop` 里观察到大量输出但从未见过 133 标记，无法可靠判定 —— 所以退化为一个简单启发：**从 `active` 转 `inactive` 只在检测到 `OSC 1701;hello` 之后又过了 5 分钟且期间零个 133 标记**。

这个启发不完美（用户可能只是没敲命令），所以：**误判的代价必须低** —— `inactive` 只会让 UI 显示降级提示并停止自动切换模式，不影响终端可用性。如果后续又收到 133 标记，立即转回 `active`。

## 上限与资源

| 项 | 默认 | 配置项 |
|---|---|---|
| 最大会话数 | 20 | `--max-sessions` |
| 每会话环形缓冲 | 1 MiB | `--ring-bytes` |
| 每连接写队列 | 4 MiB | `--conn-queue-bytes` |
| 单帧上限 | 256 KiB | 协议常量，不可配 |
| PTY 读缓冲 | 32 KiB | 常量 |

20 会话 × 1 MiB = 20 MiB 环形缓冲，加上每会话一个 xterm 在客户端侧 —— 内存占用可控。

## 优雅关闭（`SIGTERM`）

```
1. 停止接受新的 WebSocket 连接
2. 向所有连接广播 notice{level:"warn", message:"agent 即将重启，所有会话将结束"}
3. 等 2 秒（让消息送出去）
4. 对所有会话执行关闭流程（SIGHUP → 2s → SIGKILL）
5. 关闭 store，删除所有 rcfile
6. 退出
```

第 2 步很重要：会话必然会丢（[ADR-0003](../20-architecture/adr/0003-no-tmux.md)），至少要让用户知道**为什么**丢的，而不是看到一个莫名的重连失败。

## 崩溃残留清理

agent 启动时：删除运行时目录下所有 `rc-*.bash` 文件（上次崩溃残留）。

不需要清理 PTY 或进程 —— agent 死亡时 PTY master 关闭，shell 收到 `SIGHUP` 自行退出。
