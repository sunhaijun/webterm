# ADR-0016 热升级：原地 re-exec 交接会话，升级不丢会话

> **§5 的空闲判定已被 [ADR-0026](0026-agent-holds-terminal-state.md) §6 改写**：不再看提示符状态，改看 PTY 的前台进程组是不是 shell 自己。§4 交接内容里的 oscparse / termstate 换成了终端模拟器状态，交接格式升到 schema 2：新二进制能读 schema 1（没有模拟器状态时把环形缓冲喂进新模拟器尽力还原），反过来降级到旧二进制时预检会拒绝。

状态：已接受（2026-09-12）。**兑现 [ADR-0003](0003-no-tmux.md) 留下的补法**（"升级时把 PTY 的 fd 传给新进程，交接会话元数据与环形缓冲，实现无损 re-exec"）。ADR-0003 的其余决定不变：不用 tmux，agent 自持 PTY。

## 背景

会话丢失的机制只有一个：shell 的控制终端是 agent 持有的 PTY master fd。agent 进程退出，fd 关闭，内核给 shell 发 `SIGHUP`。所以「升级不丢会话」等价于「PTY master fd 在升级过程中始终有人拿着」。

ADR-0003 接受"升级即丢会话"的理由是频率低。实际用下来，`webterm update` 是顺手就跑的事，而会话里常挂着 claude / ssh / 长构建 —— 每次升级都要先清场，升级就被拖着不做。

协议层已经有一半答案：断线重连走 `hello{instance_id, resume:[{sid, out_seq}]}`，agent 从环形缓冲按序号补发，字节级一致（AC-2.1）。只要升级后的进程还认得旧的 `instance_id`、手里还有同一份环形缓冲和 PTY，客户端的重连路径原样可用，前端一行不改。

## 决定

### 1. 原地 re-exec（路线 A），不拆进程

同一个进程用新二进制替换自己的映像：`syscall.Exec`。PID 不变，各会话的 shell 仍是它的子进程（`Wait` 照常拿退出码），PTY fd 与监听 socket 靠 exec 继承，会话状态通过一个只在内存里的文件（`memfd`）交接。这是 nginx、HAProxy、systemd 自身都在用的模式。

```
webterm update / webterm reload / systemctl --user reload webterm（SIGUSR2）
        │
旧进程  ① 预检：以子进程跑【新二进制】`webterm handoff-check`，喂它一份不含缓冲的元数据快照，
        │     验 schema 能读。读不了 → 放弃升级，服务照常，明确报错（不自动退化成 restart）
        ② 冻结：拒新 WebSocket；用读 / 写超时打断每个会话的 readLoop / writeLoop 并停在安全点，
        │     输入队列里未写完的字节原样带走
        ③ 快照 → memfd（只在内存，不落盘，守住不变式 3）
        ④ 广播 notice「正在热升级，会话保留，稍后自动重连」，关闭所有 WebSocket
        ⑤ 清掉 ptmx / 监听 / memfd 的 CLOEXEC，syscall.Exec(新二进制 serve …原参数… --handoff-fd N)
        ▼                                                           ← PID 不变
新进程  ⑥ 从 memfd 重建 Manager 与各 Session：os.NewFile 接回 ptmx，net.FileListener 接回监听，
        │     环形缓冲、序号、instance_id、每 client 的 in_ack 原样恢复；os.FindProcess(pid) 接回 shell
        ⑦ 恢复 readLoop / writeLoop / waitLoop，开始服务
客户端  ⑧ 重连 → hello 带旧的 instance_id 与 out_seq → resumed.status = ok → 补发缺的字节
```

用户看到的：状态灯闪一下，一两秒后输出接着来，正在跑的 vim、claude、ssh 都还在原处。浏览器不刷新，xterm 状态完全不动。

### 2. 交接的状态

| 类别 | 内容 | 怎么交接 |
|---|---|---|
| 内核对象 | 每会话 ptmx fd、HTTP / HTTPS 监听 fd、memfd 本身 | 清 `FD_CLOEXEC` 后随 exec 继承，快照里只记 fd 号 |
| 进程 | shell 的 pid | 同 PID exec 后仍是子进程；`os.FindProcess(pid).Wait()` 照常拿退出码 |
| 续传核心 | 环形缓冲的字节与 `base_seq`、每 client 的 `inQueued` / `inAck`、Manager 的 `instance_id` 与 `nextSID` | 原样序列化 |
| 会话元数据 | sid、name、cwd、status、exitCode、cols / rows、integration、promptState、helloSeen、createdAt、rcPath | 序列化 |
| 解析中间态 | OSC 解析器可能停在半条序列上（状态、编号、负载缓冲）、pendCmd、curCmdID / curCmdAt | 序列化解析器状态；命令 id 是 SQLite 主键，跨进程有效 |
| 输入队列 | 已入队未写进 PTY 的字节（连同 client id） | 原样带走，新进程重新入队；记账不变 |
| 不用交接 | 设备授权、配对、命令历史、证书缓存、设置 | 本来就在 SQLite / 磁盘 |
| 丢弃 | WebSocket 连接、活性探针状态、限速器 | 客户端重连时重建；探针重新武装 |

快照 schema 带版本号（`schema: 1`）。新二进制必须能读上一版；不能读就在预检那一步失败，exec 不会发生。**预检是这条路的安全带**：exec 之后没有回头路，所有兼容性问题必须在 exec 之前暴露。

### 3. 失败策略：中止，不静默退化

预检失败、`memfd` 建不出来、exec 返回错误，一律**解冻并照常服务**，日志与 notice 明说原因；`webterm update` 以非零退出。想接受丢会话，用 `webterm update --force-restart`（走 ADR-0003 的老路：`systemctl restart`）。无人值守时静默退化成 restart 会把这个功能的意义抵消掉 —— 用户以为会话保住了，回来发现全没了。

唯一没有安全带的窗口：exec 成功但新进程在恢复阶段崩溃。预检把 schema 错误挡在前面，剩下的靠 systemd `Restart=on-failure` 把服务拉回来（那种情况下会话丢失）。这个窄窗口可以接受。

### 4. 触发与控制通道

- agent 在 `<data-dir>/run/agent.sock`（0600）监听一个本机控制 socket，一行 JSON 请求一行 JSON 应答：`status`（版本、pid、代数、会话数、忙碌会话数、是否支持交接）与 `reexec`。
- `webterm reload [--when-idle] [--timeout]`：通过 socket 发 `reexec`，等新进程的代数 +1 且版本变了才返回 0。`--probe` 只探测运行中的 agent 支不支持交接，`install.sh` 据此决定走热升级还是老路。
- `SIGUSR2` 等价于 `reexec`；systemd 单元加 `ExecReload=/bin/kill -USR2 $MAINPID`，`systemctl --user reload webterm` 就是热升级。
- `webterm update` 与 `install.sh`：运行中的 agent 支持交接时，装完二进制、重做 setcap 后调 `webterm reload` 而不是 `systemctl restart`；不支持（老版本）或 `--force-restart` 时走老路并保留原来的"将关闭会话"提示。

### 5. `--when-idle`（路线 C，顺手做）

`webterm update --when-idle` / `webterm reload --when-idle`：等所有会话都停在提示符（`promptState != running`）再动。热升级本身不杀任何东西，这个开关的价值在老路（restart）上：至少不会杀掉正在跑的东西。集成失效的会话看不出忙不忙，按空闲算，并在输出里注明。

### 6. 不做的

- **不拆成前台 + 会话宿主两个进程（路线 B）**。B 多解决一个"前台崩溃不丢会话"，代价是所有终端字节多一次跨进程拷贝、两个进程的生命周期、续传逻辑搬家。当前痛点是升级不是崩溃；B 留作 v0.3+ 的候选，且宿主自己升级时仍要用本 ADR 的机制。
- **不承诺机器重启后会话存活**。shell 是操作系统进程，机器一重启谁也救不了。
- **agent 自身崩溃仍丢会话**。被 OOM 杀掉的概率由 [ADR-0034](0034-system-service-oom-priority.md) 压低（agent -900、会话 0、`OOMPolicy=continue`）。

## 代价与取舍

- Session 多了"冻结"这个状态和一套导出 / 恢复代码（约数百行），每个新增的会话字段都要问一句"要不要进快照"。`handoff.Session` 结构体就是那张清单。
- 快照 schema 是新的兼容面。规则：只加字段不删字段，新进程对缺失字段取零值；不兼容的改动升 `schema` 号并在 `handoff-check` 里拒绝。
- 冻结窗口内（通常 < 100ms）PTY 输出堆在内核缓冲里，前台程序若疯狂输出可能短暂阻塞 —— 与网络卡一下无异。
- `--handoff-fd` 与 `handoff-check` 是内部接口，不进用户文档的主路径。

## 影响

- 文档：[session-manager.md](../../50-backend/session-manager.md) 新增「热升级交接」；[ring-buffer.md](../../50-backend/ring-buffer.md) 导出 / 恢复的不变式；[websocket-protocol.md](../../30-protocol/websocket-protocol.md) §5.2 注明 `instance_id` 跨交接不变；[install.md](../../80-ops/install.md) / [systemd.md](../../80-ops/systemd.md) 升级章节改写；[acceptance-criteria.md](../../10-requirements/acceptance-criteria.md) 新增 AC-2.14；[e2e-scenarios.md](../../70-testing/e2e-scenarios.md) 新增 E2E-26；[milestones.md](../../90-roadmap/milestones.md) 把「无损升级」从 v0.3+ 候选划掉。
- 代码：新包 `internal/handoff`（快照类型、memfd 读写、预检、exec）；`internal/session`（`cmd` 改为 `*os.Process`、`Freeze` / `Thaw` / `Export` / `Restore`、`Busy`）；`internal/ringbuf`（`Export` / `Restore`）；`internal/oscparse`（`Export` / `Restore`）；`internal/agent`（监听 fd 导出与继承、控制 socket）；`cmd/webterm`（`serve --handoff-fd`、`SIGUSR2`、`handoff-check`、`reload`、`update --when-idle --force-restart`）；`scripts/install.sh`（探测 → reload / restart 两条路、`ExecReload`）；`deploy/webterm.service`。
- 测试：单测 ringbuf / oscparse / handoff 往返；集成 `TestHandoffByteLevelContinuity`（真 PTY 跑着输出，中途 Freeze → Export → 新 Manager Restore，序列化结果与不交接逐字节一致，shell 仍活着，未写完的输入不丢不重）；E2E-26（真二进制收 `SIGUSR2` 原地 exec，浏览器只见重连，输出不丢不重，`resumed.status == ok`，shell 仍可用）。
