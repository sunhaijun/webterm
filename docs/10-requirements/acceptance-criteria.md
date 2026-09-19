# 验收标准

> 状态：Accepted

每条标准必须**可自动化验证**，并在 [`../70-testing/e2e-scenarios.md`](../70-testing/e2e-scenarios.md) 或 Go 测试里有对应实现。
`验证` 列的编号规则：`UT-*` = Go/Vitest 单测，`IT-*` = Go 集成测试，`E2E-*` = Playwright。

写不出验证方式的条目不允许进入这份文档。

---

## AC-1 部署与认证（US-1）

| ID | 标准 | 验证 |
|---|---|---|
| AC-1.1 | `webterm serve --domain X` 在 80/443 可达且 DNS 正确的环境下，能自动获得证书并提供 HTTPS 服务（端口默认 443，可用 `--https-port` 改）；启动时主动预热一次证书（把续期定时器挂上，不依赖有没有流量）；到期前 `min(30 天, 有效期/3)` 自动续期。续期只需 80 或 443 之一从公网可达（HTTP-01 走 80，TLS-ALPN-01 走 443）| IT-tls-1（本地假 ACME CA，见 [strategy.md 的「为什么不用 pebble」](../70-testing/strategy.md#为什么不用-pebble)）|
| AC-1.2 | `webterm serve --dev` 在 `http://127.0.0.1:8080` 提供服务，不申请证书 | IT-tls-2 |
| AC-1.3 | 首次启动若无已授权设备，stdout 打印配对 URL 和 ASCII 二维码 | IT-pair-1 |
| AC-1.4 | 配对码：单次有效，用过即废；5 分钟过期；URL 码 32 字节熵；比较为常数时间。同一次配对还发一个 16 位十进制数字码（ADR-0017），两把钥匙哈希存同一行，**任一把用掉整行作废**，TTL 与比较规则相同 | UT-pair-1..5 |
| AC-1.5 | 配对码通过 URL **fragment** 传递，服务端访问日志中不出现配对码 | IT-pair-2 |
| AC-1.6 | 配对失败 5 次/分钟/IP 后进入退避；退避期间返回 429 | IT-pair-3 |
| AC-1.7 | 除 `/pair`、静态资源、`/healthz` 外，所有路由无有效 Cookie 时返回 401，**包括 WebSocket 升级** | IT-auth-1 |
| AC-1.8 | WebSocket 升级校验 `Origin` 与服务域名一致，不一致返回 403 | IT-auth-2 |
| AC-1.9 | 会话 Cookie 为 `HttpOnly; Secure; SameSite=Strict; Path=/`；`--dev` 下允许缺省 `Secure` | IT-auth-3 |
| AC-1.10 | DB 中存的是 Cookie token 的哈希，不是原文 | UT-auth-1 |
| AC-1.11 | 吊销设备后，该设备的下一次请求（含已建立的 WebSocket）在 5 秒内被断开并要求重新配对 | IT-auth-4 |
| AC-1.12 | DB 文件权限为 `0600` | IT-store-1 |
| AC-1.13 | 证书申请失败时 stdout 给出「原因 + 怎么修」（至少覆盖：80 被占、DNS 未指向本机、ACME 限流），不是 Go error 堆栈；`webterm doctor` 逐项检查同样的前置条件（US-7.2） | IT-tls-3 |
| AC-1.15 | 手输配对（ADR-0017）：终端把数字码打成 `dddd-dddd-dddd-dddd`；`GET /pair` 无 fragment 时显示数字输入框（`inputmode=numeric`，边输边 4 位分组，满 16 位才能提交），空格与 `-` 都接受；提交走同一个 `POST /auth/pair`，服务端剥掉分隔符后匹配数字码；输错 / 过期 → 401 提示，输入框保留可重试 | IT-pair-4, E2E-27 |
| AC-1.14 | PWA：`manifest.json` 字段完整、Service Worker 注册成功、`display: standalone`；SW **只缓存静态壳**，不缓存 `/api/*` 与 `/ws`；离线时显示明确状态页（US-1.4） | E2E-17 |

---

## AC-2 断线续传（US-2）★ 核心

| ID | 标准 | 验证 |
|---|---|---|
| AC-2.1 | **字节级连续性**：同一段输出脚本跑两遍，第二遍在中途强制断开并重连；两次结束时 xterm 缓冲区的序列化结果**逐字节一致** | E2E-2 ★ |
| AC-2.2 | 断线期间会话不暂停：PTY 继续运行，环形缓冲继续累积 | IT-resume-1 |
| AC-2.3 | 重连时 client 上报 `out_seq`，agent 仅回放 `out_seq` 之后的字节，不重发已收到的字节 | UT-ring-1, IT-resume-2 |
| AC-2.4 | 断线期间提交的输入在重连后按原顺序、不重复、不丢失地写入 PTY | E2E-3, IT-resume-3 |
| AC-2.5 | `out_seq` 严格等于 agent 已发送的累计字节数；剥离 OSC 之后才计数 | UT-seq-1 |
| AC-2.6 | client 的 `out_seq < base_seq` 时 agent 判 `reset`。**会话在主屏**：client 先清屏再写入缓冲现存内容，并显示"历史输出已截断"提示；**会话在备用屏**：改走 `redraw`（AC-2.16）。**重连（`welcome.resumed[].status`）与切回（`subscribe`）两条路都要满足**；清屏由帧上的 `ATTR_PREFIX` 驱动（协议 §3），不依赖控制消息先到，所以同一段回放收到两次也只是重建两次，不会叠在旧内容后面 | E2E-4, E2E-30, UT-ring-2, IT-sub-2, UT-replay-1 |
| AC-2.7 | 环形缓冲裁剪优先在 `\n` 边界（64 KiB 窗口内找不到则硬裁）；`ESC[0m` 属性修正**只在 reset 回放时**前置，且不计入 `out_seq`（增量续传时注入会破坏 AC-2.1） | UT-ring-3, UT-ring-4 |
| AC-2.8 | 心跳：client 每 30 秒发协议级 ping，发出后 10 秒未收到 `pong` 则判死重连；agent 60 秒未收到任何帧则关闭连接 | UT-hb-1, IT-hb-1 |
| AC-2.9 | client 重连采用指数退避（0.5s 起，上限 15s，带抖动），网络恢复事件触发立即重试 | UT-reconnect-1 |
| AC-2.20 | **僵尸连接要被立刻戳穿**（ADR-0020）：`online` 事件 / 页面重新可见时，即使 client 自认在线也立刻发一次 `ping` 探活，**2 秒**内没有 `pong` 就关闭并走重连；线路已断但没有 `onclose` 时（息屏、切网、NAT 回收），从「用户回到前台」到状态条变「重连中」**不超过 5 秒**（改之前最坏 40 秒，期间打字全部写进死 socket 且无任何提示） | UT-hb-2, E2E-33 |
| AC-2.10 | 连接状态在 UI 上有明确指示：在线 / 重连中（含下次重试倒计时）/ 已恢复（含补齐字节数） | E2E-5 |
| AC-2.11 | 未订阅的会话在 agent 侧照常缓冲；切回时通过 resume 补齐，不丢输出。**例外是备用屏会话**（ADR-0019）：切回补的是"当前屏"而不是历史字节 —— 备用屏没有 scrollback，那段字节用户本来也翻不到 | E2E-6, IT-sub-1, E2E-31 |
| AC-2.12 | `in_ack` 按 `(client_id, sid)` 记账并**跨重连存活**：重连后 client 按 `welcome.resumed[].in_ack` 重发，不触发 `input_gap` | IT-resume-3 |
| AC-2.13 | `hello.instance_id` 与 agent 当前值不符时，所有 `resume` 项判 `gone`（防止 agent 重启后 sid 复用导致张冠李戴） | IT-resume-4 |
| AC-2.14 | **热升级不丢会话**（ADR-0016）：agent 收到 `SIGUSR2` / `reexec` 后原地 exec 新二进制，PID 不变；所有会话的 shell 仍在跑、`instance_id` 不变、环形缓冲与 `in_ack` 原样交接；跨交接的字节级连续性与 AC-2.1 同标准（中途交接与不交接的序列化结果逐字节一致），未写完的输入不丢不重；预检失败时中止并照常服务，**不自动退化成重启** | IT-handoff-1, UT-ring-10, UT-osc-restore, E2E-26 |
| AC-2.15 | **回放不得回声**：重连续传与**切回补课**的字节都标记为回放（client 侧 `catchup_to`，协议 §5.2）；回放期间终端对历史里那些查询（DSR / DA / `CSI ?u` …）的自动应答**不得写进 PTY**。切会话时**尺寸随 `subscribe` 一起发**（`cols`/`rows` 就在这条消息里，不单发 `resize`）：排在后面会让积压按旧尺寸排版，排在前面会让程序的整屏重画落在 `redraw.seq` 之前被跳过 | E2E-30, E2E-31, E2E-34, UT-replay-1, UT-replay-2 |
| AC-2.16 | **备用屏不回放历史，改为重画**（ADR-0019）：会话当前在备用屏而又要 reset 时，agent 发 `redraw{seq, modes}` 代替字节回放，随后逼出一次整屏重画（尺寸变了就直接 `TIOCSWINSZ`，没变就抖一下 winsize）。client 清屏 → 写 `modes` → `out_seq` 跳到 `seq`，**不显示"历史输出已截断"**。切走使积压超过 `ring_bytes` 后切回，终端显示的是该程序**当前**的完整一屏，scrollback 里不出现它界面的任何副本 | UT-termstate-*, IT-redraw-1, E2E-31 |
| AC-2.17 | 同一场景下切回所传字节 < 8 KiB（改之前是整个 `ring_bytes`）；`modes` 不计入 `out_seq` | IT-redraw-2, E2E-31 |
| AC-2.18 | 程序在 300ms 内没有重画（`head_seq` 没超过 `redraw.seq`）时退回主屏那条路（`ATTR_PREFIX` + 窗口内容），屏幕不留空白 | IT-redraw-3 |
| AC-2.19 | 粘性模式观察器**只读**：观察前后的字节逐字节相等；状态进热升级快照，交接后备用屏判定不丢；`?2026`（同步输出）**绝不恢复** | UT-termstate-*, IT-handoff-2 |

---

## AC-3 输入（US-3）

| ID | 标准 | 验证 |
|---|---|---|
| AC-3.1 | Composer 模式下，IME composition 事件不触发任何向 PTY 的写入；只有提交动作才写入 | E2E-7 |
| AC-3.2 | Composer 提交：含换行时以 bracketed paste 包裹（不被逐条执行），单行与空输入不包裹；一律以 `CR` 结尾 | UT-input-1, E2E-8 |
| AC-3.3 | Raw 模式下，composition 期间不向 PTY 写入；`compositionend` 时一次性写入最终文本。**组字状态必须有兜底复位**（ADR-0020）：`blur`，以及捕获阶段一个 `isComposing === false` 的 `keydown`，都立即把 `composing` 置回 false —— 切输入法 / 切窗口时 `compositionend` 可能不来，少了兜底该会话的终端输入会**永久**失效，用户只能刷新页面 | UT-input-2, UT-raw-2, E2E-34 |
| AC-3.14 | Raw 模式下**软键盘直接插入的字符**（iOS 中文键盘的全角标点等）必须进 PTY：非组字的 `beforeinput` / `insertText` 由前端自己接管发送并 `preventDefault`，不依赖 xterm 的 keydown/input 启发式；组字路径不受影响，同一段文字不重复发送 | UT-raw-1, E2E-7 |
| AC-3.4 | Raw 模式下 `Ctrl+C` / `Ctrl+D` / 方向键 / `Esc` / 功能键正确映射为控制字节 | UT-keymap-1 |
| AC-3.5（ADR-0013：仅内部，无 UI） | 输入模式随 shell 集成的 prompt 状态自动切换：`B`→Composer，`C`→Raw，`D`→Composer | UT-mode-1, E2E-9 |
| ~~AC-3.6（ADR-0013 取代：无手动锁定）~~ | 用户手动切换模式后进入"锁定"状态，自动切换暂停，直到用户解锁 | UT-mode-2 |
| AC-3.7 | shell 集成不可用时，模式默认为 Composer 且自动切换禁用，UI 显示降级提示 | E2E-13 |
| AC-3.8 | 软键盘弹出时（`visualViewport` resize），终端可视区与功能键条不被遮挡，布局无跳动 | E2E-10 |
| AC-3.9 | 底栏是**一条键行**（ADR-0015）：行首互切键 · 横向滚动的键区 · 行尾 `⋯`（编辑面板里行尾是「发送」）。键区：停在提示符给 `Tab ↑ ↓ ^C ^L \| ~ / - _ ← →`；命令在跑 / 降级给 `Esc ^C Tab Ctrl ↑ ↓ ← → Alt ^D ^Z ^L \| ~ / - _ Home End PgUp PgDn`；占屏按前台程序换。`Ctrl`/`Alt` 为粘滞修饰键，`^C`/`^D`/`^Z`/`^L` 一按直发控制码。**命令在跑时 `^C` 必须在免滚动的前 5 个里**（393px 宽；互切键与 `⋯` 并进同一行后免滚区从 8 个减到 5 个）—— 它是唯一的通用脱困键，而粘滞 `Ctrl` 在软键盘没弹出时（Raw 模式看 top）根本按不出组合 | E2E-10, E2E-25 |
| AC-3.10 | 输入元素禁用 `autocorrect` / `autocapitalize` / `spellcheck` | UT-input-3 |
| AC-3.11 | 终端尺寸变化时向 agent 发 `resize`，agent 对 PTY 执行 `TIOCSWINSZ`；resize 消息做 100ms 防抖 | IT-resize-1, UT-resize-1 |
| AC-3.12 | **终端是唯一显示面**（ADR-0013）：xterm 始终铺满、始终可见；命令在跑（Raw）时 Composer 不隐藏，提交 = 整段 `xterm.paste()` + 回车，「发送」长按 = 只粘贴不回车；占屏（备用缓冲 / 富键盘协议 / DECCKM / 鼠标）**不切视图**，只把键条换成对应上下文（less→分页器、top→top、claude/codex→AI 无 `q`、其余→通用 TUI）并给出「⌨ 打字」入口；占屏时不显示「没有集成」横幅；npm/cargo 多行进度条不误判 | UT-interactive-1, UT-keymap-ai, E2E-11 |
| ~~AC-3.12（旧）~~ | ~~读视图的底栏是三档写态 sheet（收起 / 半屏 / 全屏）：碰输入框升半屏，把手点一下到全屏，拖到底、提交或空输入时 `Esc` 收起且输入框失焦；**三档之间 `.canvas` 几何与 PTY 尺寸不变**（sheet 盖在块流上，不挤画布） | E2E-19 |
| AC-3.13 | **双指缩放读**（ADR-0013）：PTY 固定 43 列；双指放大是纯视觉 transform（只作用在 `.xterm-screen`，不 fit、不发 resize、PTY 尺寸不变），单指平移，缩回 1× 或双击 / 换命令 / 切会话复位 | UT-pinch, E2E-24 |
| ~~AC-3.13（旧）~~ | ~~sheet 打开时有面向"写"的编辑键条 `Tab ↑ ↓ ← → ⌫词 \| ~ / - _ " ' $ ⇤ ⇥` + 发送；`Tab` 有路径 chip 时补第一个；按键不抢输入框焦点 | UT-keymap-2, E2E-19 |
| AC-3.14 | **底栏键行不盖终端**（ADR-0015）：终端态 `.bottom` 的高度 ≤ `.bottom-slot`（56px；`short` 40px），停在提示符 / 命令在跑 / 占屏 / 降级都一样；互切键是两种态键行的**第一个键**、同尺寸（44px 高）；终端态 claude / codex 等主屏占屏程序拿到的键条与编辑态一致（按 `interactive` 判定）；编辑面板头部只有抓手、没有「收起」，全屏时输入框高度 ≥ 面板高度的 70%，chips 为空不占高度；编辑态命令在跑时键行里有 `Esc ^C`，没有第二条键条；**触摸设备在 ≥ 1024px（iPad 横屏）也是键行而不是经典底栏**（侧栏仍常驻）；tablet / desktop 的 ⋯ 是锚在键行行尾上方、宽 ≤ 320px 的弹出菜单；半屏高度 ≤ 420px | E2E-25 |
| ~~AC-3.14（旧，ADR-0013 取代）~~ | 读视图下前台出现**占屏程序**时自动切到终端视图、退出后自动回读；占屏 = 备用缓冲激活 **或程序进入全屏输入模式**（富键盘 Kitty `\e[>…u` / modifyOtherKeys `\e[>…m`、应用光标键 DECCKM `\e[?1h`（top）、鼠标跟踪，或同步输出 2026）—— 覆盖 claude / codex / top / vim；**npm / cargo / docker 等多行进度条（藏光标 + 上移重绘但不进入输入模式）不误触发**；重连后从 xterm 当前模式补判（top 运行中刷新不卡）；自动切换不写偏好，手动切过不再自动回 | UT-interactive-1, E2E-11b |
| ~~AC-3.15（ADR-0013 取代）~~ | 命令在跑（Raw）时读视图**仍是同一个 Composer**：提交 = 整段 `xterm.paste()`（按前台程序的括号粘贴模式包裹）+ 回车，sheet 可升起编辑长文；「发送」长按 = 只粘贴不回车；前台是 claude / codex 时键条换成 `Esc ^C Enter ⇧Tab / ↑ ↓ Tab Ctrl`（无 `q`，`⇧Tab` 发 `ESC [ Z`）；**占屏程序里不显示「没有集成」横幅** | UT-keymap-ai, E2E-11b, E2E-19 |
| ~~AC-3.16（ADR-0013 取代）~~ | 前台是 claude / codex 时读视图是**转录视图**：对话卡片（用户 / 助手 Markdown / 工具摘要）原生滚动选择缩放、贴底跟随、「↓ 新内容」；底部**终端尾巴**（xterm 末 8 行纯文本，300ms 节流）点它进终端；数据来自 WS `transcript` + `GET /api/transcript` 回放（刷新后仍在）；命令结束回块流；**AI CLI 占屏不自动进终端**，vim / less / top 照旧 | UT-markdown, UT-transcriptstore, E2E-23 |

---

## AC-4 多会话（US-4）

| ID | 标准 | 验证 |
|---|---|---|
| AC-4.1 | 可同时存在多个会话，各自独立 PTY、独立缓冲、独立序列号 | IT-session-1 |
| AC-4.2 | 会话数达上限（默认 20，可配）时 `session.create` 返回 `session_limit` 错误，UI 显示提示 | IT-session-2, E2E-11 |
| AC-4.3 | 未订阅会话产生输出时，agent 发 `session.updated{head_seq}`；client 按 `head_seq > out_seq` 显示未读标记。**节流吞掉的那条必须补发最新值**（协议 §6.3）—— 输出一阵一阵的时候，最后一条被吞掉就意味着未读永远不亮 | E2E-6, IT-unread-1 |
| AC-4.4 | 会话默认名为其 CWD 的 basename，CWD 变化时自动更新；手动改名后停止自动更新 | IT-session-3, UT-name-1 |
| AC-4.5 | shell 退出后会话状态变 `exited` 并携带退出码；缓冲内容保留可查看，直到用户显式关闭 | IT-session-4, E2E-11 |
| AC-4.6 | 关闭会话时先送 `SIGHUP`，2 秒后仍存活则 `SIGKILL`，并释放 PTY 与缓冲 | IT-session-5 |
| AC-4.8 | **焦点跟着会话走**（ADR-0020）：切会话时 `activate()` 把上一个会话的 DOM 摘掉，焦点会落回 `body`；切换前焦点在终端里的，切换后必须还给新会话的终端，**桌面（非触摸）无条件还给终端**。少了这一步，用 `Ctrl+Shift+↑/↓`、横滑或会话列表切过去之后打字彻底没反应，且没有任何提示 | E2E-34 |
| AC-4.7 | **左右滑动切会话**：终端区单指横向拖（轴锁：前 12px 横向占优才接管，放大态不接管）位移 > 80px 或速度 > 0.5 px/ms（另加 24px 位移下限）时切到相邻会话，左滑下一个 / 右滑上一个、到头回绕；只有一个会话时不接管。切换是纯 CSS 位移动画，**不 fit、不发 resize**，PTY 尺寸不变 | UT-swipe-1, E2E-29 |
| AC-4.9 | **会话列表的选中态一眼可辨**：选中项 = 强调色左条 + 强调色底色 + `aria-current="true"`，与 hover（中性灰）在同一屏上分得开；三档（侧栏 / 抽屉 / sheet）共用这一套。选中项变化（点选、`Ctrl+Shift+↑/↓`、横滑、关掉当前会话后自动切）时把它**滚进列表可视区**，整条已可见则不动，不用 `smooth` | UT-reveal-1, E2E-35 |

---

## AC-5 阅读输出（US-5）

| ID | 标准 | 验证 |
|---|---|---|
| AC-5.1 | scrollback 至少 5000 行，滚动不进入任何模式 | E2E-12 |
| AC-5.2 | 搜索命中数与跳转正确，支持大小写敏感切换 | E2E-12 |
| AC-5.3 | 字号可调，设置持久化到 localStorage；各断点有独立默认值；**改完要重新 `fit()` 并补一条 `resize`** —— cell 尺寸变了而容器没变，`ResizeObserver` 不会响，漏发就是客户端与 PTY 的 cols/rows 分家 | UT-font-1, E2E-12 |
| AC-5.4 | 选中文本时自动滚动暂停，选择不被破坏 | E2E-12 |
| AC-5.5 | 渲染使用 WebGL addon；WebGL 不可用时回退到 canvas 且不报错 | UT-render-1 |
| AC-5.9 | **回看时暂停跟随**：视口离开底部（滚轮 / 触屏拖动 / 拖滚动条 / 程序化滚动，一律按真实视口位置判定）后实时输出只入队不写终端；右下角**立刻**出现提示条 —— 还没有新输出时写「回到底部 ↓」，有新输出后写「已暂停跟随 · 新增 N 行 ↓」（计数是暂停以来的总量，强制写入不清零）；回到底部 / 点提示 / 输入 / 占屏程序启动 / 回放到达时一次写完，顺序不变、不丢不重；暂停期间队列攒到 2 MiB 或 4000 行后转入**分片慢写**（每帧一小块，不再一次性 drain，[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)）；备用缓冲不暂停；跟随状态每帧按真实视口位置自愈。贴底时同一帧的多个包合成一次写入。不开 xterm 平滑滚动（与持续输出打架） | UT-queue-1, E2E-12 |
| AC-5.10 | 设置面板显示当前渲染器（WebGL / Canvas） | E2E-12 |
| AC-5.11 | **次要界面共用一个浮层**（ADR-0018）：会话 / 历史 / 设置在触屏上都是贴底整宽 sheet（抓手 + 标题栏 + ✕），桌面上都是居中浮窗；点遮罩 / `Esc` / ✕ /（触屏）下滑都能关；打开时焦点进浮层；浮层 `fixed` 覆盖，**不改终端几何、不发 resize** | E2E-28 |
| AC-5.12 | **desktop 侧栏可拖宽 / 可收起**：拖右缘分隔条**预览**新边界（分隔条跟手，**拖动期间栅格列不变、侧栏与终端都不重排**，ADR-0021），松手落宽度（200–480px，上限再受窗口宽 40% 约束；触屏最小 260px）；**预览位置 = 松手结果**，夹紧 / 吸附回 240 / 拖过门槛收起在拖动中就看得见；点一下分隔条或 `Ctrl+Shift+B` 收起 / 展开，收起后终端满屏且左缘仍留可拖的把手；键盘步进仍是即时改宽；宽度与收起状态持久化到 `localStorage`，且**只在 desktop 生效**（phone / tablet 的会话仍是浮层）；**拖动全程不重算 cols/rows、不发 `resize`，松手后只发一条** | UT-sidebar-1, E2E-32 |
| AC-5.13 | **终端字体可选**（[ADR-0023](../20-architecture/adr/0023-terminal-font-list.md)）：一份硬编码的等宽优选清单，用 canvas `measureText` 与 `monospace` / `serif` / `sans-serif` 三条基线比宽度，**只列本机真的装了的**（三条都一样宽 = 没装）；每项是一整段 stack，尾巴恒为 CJK 等宽 + `monospace`；选择存 `webterm.font.family`（存 id、全局一份、**不按断点分**）；改字体后所有 xterm 实例一起换、重新 `fit()`、补一条 `resize`；探测不可用（拿不到 2d 上下文）时退化成只有「系统默认」，不报错；面板里写明连字不生效（WebGL 渲染器） | UT-font-1, E2E-12 |
| AC-5.14 | **刷新之后仍能往回拖**（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)）：刷新页面后能滚回刷新前缓冲的**最后 2000 行**（不足 2000 行则全部），恢复的内容与刷新前逐行一致且整段内容**只出现一份**；快照与 `out_seq` 同刻生成，任一步失败就整条不存；`instance_id` 不匹配 / 超过 24h / 备用屏会话 → 不用也不存；**配对失效或设备被吊销后本地快照必须清除** | UT-snap-1..4, E2E-36 |
| AC-5.15 | **拖动跟手**（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)）：触屏纵向拖每帧至多一次 `scrollTop` 写入，拖动期间**无 > 50 ms 长任务**；松手有惯性，碰到边界或再次触摸立刻停；`prefers-reduced-motion` 下不做惯性 | UT-scroll-1, E2E-37 |
| AC-5.16 | **大块写入有预算**（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)）：回放 / 快照恢复 / 回看期间的强制写入共用一个带预算的写入器，每帧 ≤ 64 KiB，**顺序不变、不丢不重**，期间用户输入不被丢弃 | UT-writer-1..3, E2E-37 |
| AC-5.17 | **备用屏的回滚交给程序**（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)）：备用缓冲且 `mouseTrackingMode !== 'none'` 时，纵向拖按行步长转成滚轮上报并有节流上限（每 16 ms ≤ 3 行）；**没开鼠标跟踪时不发任何按键**（绝不退化成 PageUp / 方向键）；**转发过滚轮之后必须有看得见的出口** —— 首次转发后若用户打字而屏幕 ~1.5s 内一个字节没变，提示条写明「按 `Esc` / `q` 退出程序的滚动模式」（每会话至多一次），因为滚轮上报可能把程序推进另一种模式（tmux 的 copy-mode），那时输入去向变了而 webterm 无从得知（[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)） | UT-scroll-2, E2E-38 |
| ~~AC-5.7（ADR-0013 取代）~~ | 读视图里展开的块可**最大化**铺满整屏细看（可滚动、含末尾输出）、点「恢复」回内联；「块」面板同样支持 | E2E-12b |
| ~~AC-5.8（ADR-0013 取代）~~ | 读视图里**最新一条命令的块自动展开**（一眼看到最新输出）；切到更新的命令时上一条自动展开的收起，只留最新一条 —— 失败的块与用户手动展开过的不被自动收起 | E2E-12c |
| ~~AC-5.6（ADR-0013 取代）~~ | 块的「在终端里看」切到终端视图并**滚到该块输出的第一行**：agent 发 `command.start/end` 先于对应输出帧（IT-order-1），client 写入时按 `out_seq` 切帧、切口处登记 xterm marker；marker 已滚出 scrollback 时退回按命令原文搜索，再不行滚到底 | UT-marks-1, IT-order-1, E2E-20 |

---

## AC-6 命令历史与快捷命令（US-6）

| ID | 标准 | 验证 |
|---|---|---|
| AC-6.1 | 每条执行的命令产生一条记录，含原文、CWD、开始时间、退出码、耗时、所属会话名；**连续两次执行同一条命令产生两条记录** | IT-shell-1 |
| AC-6.2 | 以空格开头的命令不产生记录 | IT-shell-2 |
| AC-6.3 | 历史可按原文子串和 CWD 过滤，按时间倒序**游标分页**（翻页期间新增记录不导致漏行/重行） | UT-store-1 |
| AC-6.4 | 点击历史条目将其原文填入 Composer，光标置于末尾，不自动执行 | E2E-14 |
| AC-6.5 | 置顶操作把 `pinned` 置为 true 并分配 `pin_order`；置顶列表按 `pin_order` 排序 | UT-store-2, E2E-14 |
| AC-6.6 | 快捷命令可设置 `label`、可拖动排序、可取消置顶；改动即时持久化 | E2E-14 |
| AC-6.7 | 移动端底部快捷按钮条展示 `pinned` 列表，可横向滚动，点击填入 Composer | E2E-14 |
| AC-6.9 | 可删除单条历史；可清空全部历史（需二次确认） | UT-store-3, E2E-14 |
| AC-6.10 | 历史记录数超过上限（默认 50000）时按时间淘汰最旧的**非置顶**记录；置顶记录永不淘汰 | UT-store-4 |
| AC-6.11 | 写态 sheet 的 chips：空输入 = 快捷命令 + 同目录历史；有输入 = 光标 token 的真实路径补全（`GET /api/fs`：目录在前、隐藏项按需、目录不存在即空列表、与 shell 同权限）+ 前缀历史；点路径 chip 只替换光标所在 token | UT-fs-1, IT-fs-1, UT-complete-1, E2E-19 |
| ~~AC-6.8（[ADR-0022](../20-architecture/adr/0022-drop-command-palette.md) 移除）~~ | ~~命令面板（`Ctrl/Cmd+K`）可模糊搜索会话、快捷命令、历史，回车执行对应动作~~。面板已彻底删除，`Ctrl/Cmd+K` 归还终端（readline 的「删到行尾」） | — |

---

## AC-7 shell 集成（US-6/US-7）

| ID | 标准 | 验证 |
|---|---|---|
| AC-7.1 | 会话启动时通过临时 rcfile 注入集成，**用户无需修改任何 dotfile** | IT-shell-3 |
| AC-7.2 | 集成脚本在用户配置**之后**安装钩子，不覆盖用户的 `PS1` / `PROMPT_COMMAND` / 已有 `DEBUG` trap | IT-shell-4 |
| AC-7.3 | 登录模式下只加载 profile 链（`~/.bash_profile` → `~/.bash_login` → `~/.profile`，取第一个存在的）；非登录模式下只加载 `~/.bashrc`。不重复加载 | IT-shell-5 |
| AC-7.4 | agent 剥离所有 webterm 相关 OSC 序列，client 收到的字节流中不含它们 | UT-osc-1 |
| AC-7.5 | OSC 解析器正确处理跨读边界分片、`BEL` 与 `ST` 两种终止符、超长负载（截断保护）、畸形负载（忽略不崩溃）、无关 OSC 原样透传 | UT-osc-2..9 |
| AC-7.6 | 集成握手（`OSC 1701;hello`）10 秒内未收到时，会话标记 `integration: inactive`，UI 显示降级提示 | IT-shell-6, E2E-13 |
| AC-7.7 | 集成脚本执行失败或语法错误不导致 shell 启动失败（终端仍可用） | IT-shell-7 |
| AC-7.8 | **会话环境注入**（[ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md)）：`--session-env KEY=VAL`（可重复）注入到会话 PTY；内置清单（把已知全屏 TUI 拉回主屏，目前只有 `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`）默认生效、可用 `--no-altscreen-compat` 关掉；**用户已经设过的同名变量不被覆盖**，`--session-env` 优先于内置清单；`TERM` / `WEBTERM_SESSION` 由 webterm 定死，`--session-env` 给这两个键**在解析时就报错**（不静默忽略）；配置文件与命令行的 `session-env` 是**合并**，同名键后出现的胜出（于是命令行照样压过配置文件） | IT-sessionenv-1..3 |

---

## AC-8 工程约束

| ID | 标准 | 验证 |
|---|---|---|
| AC-8.1 | `CGO_ENABLED=0 go build` 成功产出可执行文件；`ldd` 显示 not a dynamic executable | CI |
| AC-8.2 | 前端产物由 `go:embed` 嵌入，运行时不读取外部静态文件 | IT-embed-1 |
| AC-8.3 | `go vet ./...` 与 `golangci-lint run` 无告警 | CI |
| AC-8.4 | 终端输出内容不出现在任何落盘文件中（DB、日志） | IT-privacy-1 |
| AC-8.5 | 日志不包含配对码、Cookie token、命令原文 | IT-privacy-2 |
| AC-8.6 | 连接读写两侧的队列都不阻塞：会话输入队列满 → `input_stalled` 关连接；连接写队列满 → 关连接。任一情况下**其它会话的 PTY 不受影响** | IT-queue-1..2 |
