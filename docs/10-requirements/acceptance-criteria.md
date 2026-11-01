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
| AC-2.3 | 重连 / 切回时 client 上报 `out_seq`；`out_seq > 0` 且仍在环形缓冲窗口内时走**增量**：agent 只发 `out_seq` 之后的原始字节，不重发已收到的字节 | UT-ring-1, IT-resume-2 |
| AC-2.4 | 断线期间提交的输入在重连后按原顺序、不重复、不丢失地写入 PTY | E2E-3, IT-resume-3 |
| AC-2.5 | `out_seq` 严格等于会话累计的 PTY 输出字节数：agent 不改写输出流；`SNAPSHOT` 帧不计入 `out_seq` | UT-seq-1 |
| AC-2.6 | **快照路径**（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)）：`out_seq == 0`（第一次打开、刷新）、落出环形缓冲窗口、或订阅时列数变了，agent 发 `SNAPSHOT`（`seq` = 生成时的 `head_seq`，内容 = 当前屏 + 至多 2000 行历史 + 模式），随后从 `seq` 起发 OUTPUT；client `reset` 后写入快照、`out_seq = seq`。**重连（`welcome.resumed[].status == "snapshot"`）与切回（`subscribe`）两条路都满足**；同一份快照拆成多帧时，除最后一帧都带 `MORE`，client 收齐才应用；不显示"历史输出已截断" | E2E-4, E2E-30, IT-sub-2, IT-snapshot-1 |
| AC-2.8 | 心跳：client 每 30 秒发协议级 ping，发出后 10 秒未收到 `pong` 则判死重连；agent 60 秒未收到任何帧则关闭连接 | UT-hb-1, IT-hb-1 |
| AC-2.9 | client 重连采用指数退避（0.5s 起，上限 15s，带抖动），网络恢复事件触发立即重试 | UT-reconnect-1 |
| AC-2.20 | **僵尸连接要被立刻戳穿**（ADR-0020）：`online` 事件 / 页面重新可见时，即使 client 自认在线也立刻发一次 `ping` 探活，**2 秒**内没有 `pong` 就关闭并走重连；线路已断但没有 `onclose` 时（息屏、切网、NAT 回收），从「用户回到前台」到状态条变「重连中」**不超过 5 秒**（改之前最坏 40 秒，期间打字全部写进死 socket 且无任何提示） | UT-hb-2, E2E-33 |
| AC-2.21 | **快照屏幕级一致**（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §10）：对真实程序的录制字节在任意截断点 k（含切在转义序列与多字节字符中间）生成快照，xterm 先吃快照再吃 k 之后的字节，结果与直接吃全部字节逐格一致（字符、宽度、颜色、属性、光标、模式），只允许 ADR-0026 列出的三处已知差异与软换行标记不同 | UT-vterm-golden, UT-snapshot-xterm |
| AC-2.22 | **列数变了重发快照**：`resize` 或 `subscribe` 带来的列数与会话当前不同时，agent 锁内先改模拟器尺寸、生成快照并发给该会话的每个订阅者，锁外才 `TIOCSWINSZ`，程序因 SIGWINCH 重画的字节排在快照之后；只改行数时不发快照 | IT-resize-2, E2E-42 |
| AC-2.23 | **切开的 UTF-8 不丢字**：client 每会话用流式 UTF-8 解码器把字节解成字符串再写入 xterm；一个多字节字符被切在两个 OUTPUT 帧之间（含第 2 字节为 `0x80` 的 `。` `…` `—`）时，终端里照样出现这个字符；收到快照时换新的解码器 | UT-decode-1, E2E-43 |
| AC-2.10 | 连接状态有明确指示：在线 / 重连中（含下次重试倒计时）/ 已恢复（含补齐字节数）。`compact` 在线时不显示，不在线时在终端顶部盖一条横幅；`wide` 在标签栏右侧常驻状态点，不在线时同样出横幅。横幅与 toast **盖在终端上**，出现与消失前后终端行列数不变、不发 `resize`；状态文字（`conn-text`）一直在 DOM 里，在线时只是视觉隐藏，`aria-live` 照常播报 | E2E-5 |
| AC-2.11 | 未订阅的会话在 agent 侧照常缓冲、照常喂给模拟器；切回时按 AC-2.3 / AC-2.6 走增量或快照，不丢画面 | E2E-6, IT-sub-1, E2E-31 |
| AC-2.12 | `in_ack` 按 `(client_id, sid)` 记账并**跨重连存活**：重连后 client 按 `welcome.resumed[].in_ack` 重发，不触发 `input_gap` | IT-resume-3 |
| AC-2.13 | `hello.instance_id` 与 agent 当前值不符时，所有 `resume` 项判 `gone`（防止 agent 重启后 sid 复用导致张冠李戴） | IT-resume-4 |
| AC-2.14 | **热升级不丢会话**（ADR-0016）：agent 收到 `SIGUSR2` / `reexec` 后原地 exec 新二进制，PID 不变；所有会话的 shell 仍在跑、`instance_id` 不变、环形缓冲、**模拟器状态**与 `in_ack` 原样交接，**交接前后同一会话生成的快照逐字节相等**；跨交接的增量续传与 AC-2.1 同标准，未写完的输入不丢不重；预检失败时中止并照常服务，**不自动退化成重启** | IT-handoff-1, UT-vterm-handoff, E2E-26 |
| AC-2.15 | **回放不得回声**：写入 `SNAPSHOT`，以及增量补课（client 侧 `catchup_to` 之前）的字节，都标记为回放；回放期间终端对历史查询（DSR / DA / `CSI ?u` …）的自动应答**不得写进 PTY**，用户输入照常放行。订阅时**尺寸随 `subscribe` 一起发**，不单发 `resize` | E2E-30, E2E-31, E2E-34, UT-replay-1, UT-replay-2 |
| AC-2.24 | **agent 不先于会话被 OOM 杀掉**（ADR-0034）：`install.sh` 装出的是以安装者身份运行的系统服务，agent 进程 `oom_score_adj = -900`、`OOMPolicy=continue`；会话 shell 从第一条用户代码起就是 0（登录 shell 读 profile 期间起的进程也是 0），agent 起完 shell 回到原值；会话里的进程被 OOM 杀掉时 unit 不停、其它会话不受影响；还是用户服务的机器默认热升级、不迁移，`--force-restart` 才迁移，且在 webterm 会话里运行时拒绝迁移 | UT-oom-1, IT-oom-1, UT-install-unit, 手工清单「部署」 |

---

## AC-3 输入（US-3）

| ID | 标准 | 验证 |
|---|---|---|
| AC-3.3 | 终端直输时，composition 期间不向 PTY 写入；`compositionend` 时一次性写入最终文本。**组字状态必须有兜底复位**（ADR-0020）：`blur`，以及捕获阶段一个 `isComposing === false` 的 `keydown`，都立即把 `composing` 置回 false —— 切输入法 / 切窗口时 `compositionend` 可能不来，少了兜底该会话的终端输入会**永久**失效，用户只能刷新页面 | UT-input-2, UT-raw-2, E2E-34 |
| AC-3.17 | **输入路径可观测**（[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md) 推论三）：`__webterm.inputStats()` 按四段给出计数与**最近一次发生的时刻** —— 按键到达页面（**捕获阶段**的 `keydown`）→ 焦点在终端 → xterm 吐出 `onData` → 发给 agent（INPUT 帧），外加被回放门丢掉的数量、未 ack 字节数、当前焦点元素，并给出 `verdict`（断点在哪一段）；**生产构建里也在** | UT-inputstats-1..2, E2E-34 ④ |
| AC-3.14 | 终端直输时**软键盘直接插入的字符**（iOS 中文键盘的全角标点等）必须进 PTY：非组字的 `beforeinput` / `insertText` 由前端自己接管发送并 `preventDefault`，不依赖 xterm 的 keydown/input 启发式；组字路径不受影响，同一段文字不重复发送。**去重只压「已经被另一条路送出去」的那一次且一次性**（`compositionend` 的补发、`keypress` 已送过的字符）；**连打两下同一个字符必须两下都进** —— 按内容 + 时间窗口判重会把第二下静默吃掉（[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)） | UT-raw-1, E2E-7 |
| AC-3.4 | 终端直输与附加键的 `Ctrl+C` / `Ctrl+D` / 方向键 / `Esc` / 功能键正确映射为控制字节，附加键与实体键盘同一编码；方向键与 `Home` / `End` 跟随应用光标键模式（DECCKM 开启时发 `ESC O A` / `ESC O H`），按键时现读不缓存 | UT-keymap-1 |
| AC-3.8 | 软键盘弹出时（`visualViewport` resize），终端区收缩而不被遮挡，附加键贴在键盘上方、完整可见，布局无跳动；形态不变 | E2E-21 |
| AC-3.10 | 文本输入页的 `textarea` 禁用 `autocorrect` / `autocapitalize` / `spellcheck`，以 DOM attribute 的实际值为准（`autocorrect="off"`，不是被框架反射成的 `on`） | UT-input-3, E2E-40 |
| AC-3.11 | 终端尺寸变化时向 agent 发 `resize`，agent 对 PTY 执行 `TIOCSWINSZ`；resize 消息做 100ms 防抖。行列 = 可用尺寸 ÷ **稳定的**字符格尺寸（不随当前行列变，[ADR-0033](../20-architecture/adr/0033-own-fit.md)）：容器尺寸不变时反复量，行列不变；只改高度时列数不变 | IT-resize-1, UT-resize-1, UT-fit-1, E2E-42 |
| AC-3.18 | **附加键**（[ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) §2）：`compact` 恒显示、`wide` 在 `pointer: coarse` 时显示；两行共 14 个键，依次为 `ESC / - HOME ↑ END PGUP` 与 `TAB CTRL ALT ← ↓ → PGDN`，**不随前台程序、提示符状态变**；393px 宽下全部可见、不横向滚动；按键在 `pointerdown` 时 `preventDefault`，按下前后 `document.activeElement` 不变；字节走 `onData` 出口（计入 `inputStats`）；CTRL / ALT 点一下只对下一个键生效（含软键盘输入的下一个字符），长按锁定，再点解锁，激活与锁定有 `data-sticky` 与高亮 | UT-keys-1, E2E-10 |
| AC-3.19 | **文本输入页**：点 ✎ 或在键区左右滑动切换，切换前后终端行列数不变、不发 `resize`；回车：组字中不处理，有内容 = 内容走 `term.paste()`（对端开了括号粘贴就包裹，换行转 `CR`）、**紧跟一个 `\r`**、清空，空 = 发 `\r`，回车不在框里插入换行；都走 `onData`（计入 `inputStats`）；发完留在文本页且焦点不变（[ADR-0027](../20-architecture/adr/0027-text-page-enter-submits.md)）；文本框四边都有边框，整个落在附加键槽内 | UT-textinput-1, E2E-40 |
| AC-3.20 | **点按终端**：前台程序开了鼠标跟踪时点击交给 xterm 上报；没开时切换软键盘（终端有焦点则失焦，没有则聚焦），聚焦发生在这次触摸的处理函数里；位移 ≥ 10px 的是拖动，不算点 | E2E-10 |
| AC-3.21 | **触屏纵向拖**（[ADR-0029](../20-architecture/adr/0029-touch-drag-to-wheel.md)、[ADR-0032](../20-architecture/adr/0032-drag-wheel-per-row.md)）：前台程序开了鼠标跟踪时，位移满 10px 且纵向占优的拖动转成滚轮：**手指每移动一行高发一次**（从起点开始累计，零头留到下一帧），一拖动就发、不等任何往返；一次 `touchmove` 最多 3 次、超出的丢掉；手指向下 = 滚轮向上，上报的行列是手指所在格，编码按程序的协议；程序一次滚几行由程序定（步长 N 的程序，手指拖 k 行内容走约 k × N 行）；转换期间 `touchmove` 被 `preventDefault`；横向拖与「点一下」不发滚轮。没开鼠标跟踪时不变：主屏是 xterm 的触摸滚动，备用屏不动、不发方向键 | UT-touch-1, E2E-44 |
| AC-3.22 | **文本输入页跟着会话走**（[ADR-0036](../20-architecture/adr/0036-text-page-per-session.md)）：每个会话各记自己停在哪一页（键位 / 文本）和草稿；切换会话时附加键槽换成新会话的页、文本框换成新会话的草稿，切回原样恢复；新会话从键位页、空草稿开始；会话关闭时草稿丢弃；回车只发到当前会话、只清当前会话的草稿；组字中切换先提交组字再存草稿 | UT-textinput-2, E2E-40 |

---

## AC-4 多会话（US-4）

| ID | 标准 | 验证 |
|---|---|---|
| AC-4.1 | 可同时存在多个会话，各自独立 PTY、独立缓冲、独立序列号 | IT-session-1 |
| AC-4.2 | 会话数达上限（默认 20，可配）时 `session.create` 返回 `session_limit` 错误，UI 显示提示 | IT-session-2, E2E-11 |
| AC-4.3 | 未订阅会话产生输出时，agent 发 `session.updated{head_seq}`；client 按 `head_seq > out_seq` 显示未读标记。**节流吞掉的那条必须补发最新值**（协议 §6.3）—— 输出一阵一阵的时候，最后一条被吞掉就意味着未读永远不亮 | E2E-6, IT-unread-1 |
| AC-4.4 | 会话默认名为其 CWD 的 basename；CWD 由 agent 每秒读一次 `/proc/<前台进程组>/cwd`，变了才发 `session.updated`，任何 shell 都适用；手动改名后停止自动更新，改成空字符串恢复 | IT-session-3, UT-name-1 |
| AC-4.5 | shell 退出后会话状态变 `exited` 并携带退出码；缓冲内容保留可查看。终端末尾出现一行本地提示 `[进程已结束（退出码 N）· 按 Enter 关闭]`：它在最后一段输出**之后**、不改变 `outSeq`；在该会话里按 `Enter`（或文本输入页回车）关闭会话；agent 的"已退出"消息排在最后一个 OUTPUT 之后并带 `head_seq`，client 在 `out_seq` 追到它之后才写提示行；刷新或重连拿到快照后（提示行不在 agent 的模拟器里）按会话状态再写一次，始终**只有一行** | IT-session-4, E2E-11 |
| AC-4.6 | 关闭会话时先送 `SIGHUP`，2 秒后仍存活则 `SIGKILL`，并释放 PTY 与缓冲 | IT-session-5 |
| AC-4.8 | **焦点跟着会话走**（ADR-0020）：切会话时 `activate()` 把上一个会话的 DOM 摘掉，焦点会落回 `body`；切换前（从抽屉切换时以**打开抽屉之前**为准）焦点在终端里**或文本框里**的，切换后必须还给**新会话的输入处**（它停在文本页就是文本框，否则是终端，[ADR-0036](../20-architecture/adr/0036-text-page-per-session.md)），**非触摸设备无条件还**。少了这一步，用 `Ctrl+Shift+↑/↓`、标签栏或抽屉切过去之后打字彻底没反应，且没有任何提示 | E2E-34, E2E-40 |
| AC-4.9 | **当前会话一眼可辨**：当前标签 / 抽屉里的当前行 = 强调色（下划线或左条）+ 强调色底色 + `aria-current="true"`，与 hover（中性灰）在同一屏上分得开。当前会话变化（点选、`Ctrl+Shift+↑/↓`、关掉当前会话后自动切）时把它**滚进可视区**，整个已可见则不动，不用 `smooth` | E2E-35 |
| AC-4.10 | **会话切换两种形态**（[ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) §4）：`compact` 上附加键左列的会话按钮（圆角方框里写会话数，随新建 / 关闭即时更新）打开底部会话抽屉，任一非当前会话未读时按钮带红点；抽屉底部是「+ 新会话」与设置（⚙）；抽屉可由点遮罩、选中会话、`Esc`、✕、系统返回键关闭；系统返回键只关抽屉、不离开页面，反复开关不让历史记录累积（`history.length` 至多比初始多 1）。`wide` 上标签栏常驻：点标签切换、✕ 与中键关闭、双击改名、`+` 新建，右键 / 长按弹出会话菜单（改名 · 保持接收 · 关闭），最右是连接状态点与设置（⚙）；切换不改终端几何。**标签按可用宽度等分**（[ADR-0031](../20-architecture/adr/0031-tabs-equal-width.md)）：每个一样宽，最宽 240px、最窄 120px；放不下时标签保持 120px、标签条横向滚动，鼠标滚轮在标签条上纵向滚即横向滚动它。**`+` 不在滚动的标签条里**（[ADR-0035](../20-architecture/adr/0035-tabbar-new-button-pinned.md)）：放得下时跟在最后一个标签后面，放不下时停在标签条右边、始终整个可见；与标签条之间留 12px（触屏 16px）不可点的间隔；`+` 与连接状态点的垂直中心相差 ≤ 0.5px | E2E-28, E2E-41 |
| AC-4.11 | **关闭确认用自己的浮层**（[ADR-0038](../20-architecture/adr/0038-close-confirm-sheet.md)）：关闭 `running` 会话前弹 `close-confirm`，不用 `window.confirm()`；`compact` 是贴底 sheet、`wide` 是居中浮窗；标题含会话名，正文一句，底部「取消」（`close-cancel`）与「关闭」（`close-ok`，警示色）等宽、留白同会话抽屉底部；打开时焦点在「关闭」上，`Enter` 确认、`Esc` 取消；点遮罩 / ✕ / 下滑 / 取消都不关会话。从会话抽屉打开时叠在抽屉上，确认或取消后抽屉仍在，`Esc` 只关最上面一层。确认或取消后按打开之前的焦点恢复（在打字或非触摸设备 → 还给当前会话的输入处），确认时先还焦点再发 `session.close`；确认浮层开着时会话从列表里消失，浮层随之关闭。`exited` 会话直接关、不确认。**关闭中**（已发 `session.close`、未收到 `session.closed`）的会话不再发输入（含焦点上报）与 `resize`，它的 `unknown_session` 错误不弹 toast（ADR-0038 §5）；浮层按钮上的 `Enter` 不漏进终端 | UT-close-1, E2E-11, E2E-28, E2E-41 |
| AC-4.12 | **手机会话列表左滑出按钮**（[ADR-0039](../20-architecture/adr/0039-drawer-row-swipe-actions.md)）：抽屉里一行左滑（横向 > 10px 且横向占优）露出「保持接收 / 改名 / 关闭」三个按钮（`row-pin` / `row-rename` / `row-close`，各 72px），过半松手停在打开、否则弹回，打开的行右滑关上；纵向滑动照常滚动列表；长按一行同样打开；同一时间只开一行，点别处或点开着那行的正文只关不切换。改名打开一张叠在抽屉上的小 sheet（`rename-sheet`，输入框 `rename-input` 16px、选中全部，`rename-ok` / `rename-cancel`），`Enter` 保存、留空恢复自动命名，失焦不算取消。**浮层跟着可视区**：`.app` 是 fixed 浮层的包含块，sheet 贴着键盘上沿，高度按可见区的百分比算（最大 80%，会话抽屉最小 50%）；键盘弹起时不再额外留 Home 指示条的高度 | UT-swipe-1, E2E-28 |
| AC-4.13 | **拖动排序**（[ADR-0040](../20-architecture/adr/0040-session-order-drag.md)）：`wide` 标签用鼠标按住横移 > 5px 开始拖（触屏长按后不松手移动），`compact` 抽屉按住一行右端的拖动柄（`session-<sid>-grip`）纵向拖；被拖项跟手、其余让位，松手插到指针处，位置没变不发消息，拖完的那次 `click` 不切会话，`Esc` 取消；靠近可滚动区边缘 32px 内自动滚。顺序存在 agent：client 发 `session.move{sid, before}`，agent 广播 `session.order{sids}`；`welcome.sessions[]` 按显示顺序给出，新建排最后；**刷新后、另一台设备上、热升级之后顺序都一样**。`[n]`、`Ctrl+Shift+↑/↓`、关掉当前会话后切到的相邻会话都按当前顺序 | UT-order-1, IT-order-1, IT-handoff-1, E2E-45 |

---

## AC-5 阅读输出（US-5）

| ID | 标准 | 验证 |
|---|---|---|
| AC-5.1 | scrollback 至少 5000 行，滚动不进入任何模式 | E2E-12 |
| AC-5.3 | **外观只有两项设置**（[ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md)）：**主题**三选一（跟随系统 / 浅色 / 深色，默认跟随系统，存 `webterm.theme`），**终端字号** 10–24px（默认 14px，存 `webterm.fontSize`，**不按形态分**）；改了立刻生效、刷新后保留，读不到存储或值不合法时用默认值。主题：界面与 xterm 一起换、不用刷新；跟随系统时系统切换深浅色也一样；首次渲染之前就打上（配对页同样）。字号：所有 xterm 实例一起换，**重新 `fit()` 并补一条 `resize`**（字符格变了而容器没变，`ResizeObserver` 不会响）。字体固定为系统等宽栈（`--font-mono`），不可设置；`Ctrl+Shift+,` 不拦截、交给终端。入口：`wide` 是标签栏最右的 ⚙，`compact` 是会话抽屉底部的 ⚙；界面上不写说明文字 | UT-look-1, UT-prefs-1, E2E-12 |
| AC-5.4 | 选中文本后有新输出到达，选区不被破坏（xterm 的选区按缓冲区坐标记） | E2E-12 |
| AC-5.11 | **浮层**（会话抽屉、设置）共用 `Drawer` 原语，**按形态分两种**（[ADR-0037](../20-architecture/adr/0037-settings-theme-and-font-size.md) §4）：`compact` 是贴底整宽的 sheet（抓手 + 标题栏 + ✕，可下滑关），`wide` 是居中浮窗；点遮罩 / `Esc` / ✕ 都能关；打开时焦点进浮层；浮层 `fixed` 覆盖，**不改终端几何、不发 resize**。**会话抽屉高度至少为视口的 50%**（最多 80%），多出的高度给列表，底部一行贴着 sheet 底部；**底部一行留白**：按钮与 sheet 底边（不含安全区时）之间 ≥ 16px、与左右边 16px，按钮之间 12px；没有底部一行的 sheet 内容与底边之间同样 ≥ 16px。关掉设置后，打开前焦点在终端（或文本输入页）里的、或非触摸设备，焦点回到那里 | E2E-28, E2E-41 |
| AC-5.14 | **刷新之后仍能往回拖**：刷新页面后订阅走快照，能滚回刷新前缓冲的**最后 2000 行**（不足 2000 行则全部），内容与刷新前逐行一致且**只出现一份**；浏览器不存任何本地快照（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)） | IT-snapshot-1, E2E-36 |
| AC-5.18 | **形态**（[ADR-0025](../20-architecture/adr/0025-termux-style-ui.md) §1）：`.app[data-form]` 由屏幕短边决定，`< 600px` 为 `compact`，否则 `wide`；`compact` 没有标签栏、有会话按钮，`wide` 有标签栏、没有会话按钮；可视视口变化（软键盘弹出、旋转）不改变形态 | UT-form-1, E2E-39 |

---

## AC-7 会话环境（US-7）

| ID | 标准 | 验证 |
|---|---|---|
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
