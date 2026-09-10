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
| AC-1.4 | 配对码：单次有效，用过即废；5 分钟过期；32 字节熵；比较为常数时间 | UT-pair-1..4 |
| AC-1.5 | 配对码通过 URL **fragment** 传递，服务端访问日志中不出现配对码 | IT-pair-2 |
| AC-1.6 | 配对失败 5 次/分钟/IP 后进入退避；退避期间返回 429 | IT-pair-3 |
| AC-1.7 | 除 `/pair`、静态资源、`/healthz` 外，所有路由无有效 Cookie 时返回 401，**包括 WebSocket 升级** | IT-auth-1 |
| AC-1.8 | WebSocket 升级校验 `Origin` 与服务域名一致，不一致返回 403 | IT-auth-2 |
| AC-1.9 | 会话 Cookie 为 `HttpOnly; Secure; SameSite=Strict; Path=/`；`--dev` 下允许缺省 `Secure` | IT-auth-3 |
| AC-1.10 | DB 中存的是 Cookie token 的哈希，不是原文 | UT-auth-1 |
| AC-1.11 | 吊销设备后，该设备的下一次请求（含已建立的 WebSocket）在 5 秒内被断开并要求重新配对 | IT-auth-4 |
| AC-1.12 | DB 文件权限为 `0600` | IT-store-1 |
| AC-1.13 | 证书申请失败时 stdout 给出「原因 + 怎么修」（至少覆盖：80 被占、DNS 未指向本机、ACME 限流），不是 Go error 堆栈；`webterm doctor` 逐项检查同样的前置条件（US-7.2） | IT-tls-3 |
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
| AC-2.6 | client 的 `out_seq < base_seq` 时 agent 判 `reset`，client 先清屏再写入缓冲现存内容，并显示"历史输出已截断"提示 | E2E-4, UT-ring-2 |
| AC-2.7 | 环形缓冲裁剪优先在 `\n` 边界（64 KiB 窗口内找不到则硬裁）；`ESC[0m` 属性修正**只在 reset 回放时**前置，且不计入 `out_seq`（增量续传时注入会破坏 AC-2.1） | UT-ring-3, UT-ring-4 |
| AC-2.8 | 心跳：client 每 30 秒发协议级 ping；agent 60 秒未收到任何帧则关闭连接 | UT-hb-1, IT-hb-1 |
| AC-2.9 | client 重连采用指数退避（0.5s 起，上限 15s，带抖动），网络恢复事件触发立即重试 | UT-reconnect-1 |
| AC-2.10 | 连接状态在 UI 上有明确指示：在线 / 重连中（含下次重试倒计时）/ 已恢复（含补齐字节数） | E2E-5 |
| AC-2.11 | 未订阅的会话在 agent 侧照常缓冲；切回时通过 resume 补齐，不丢输出 | E2E-6, IT-sub-1 |
| AC-2.12 | `in_ack` 按 `(client_id, sid)` 记账并**跨重连存活**：重连后 client 按 `welcome.resumed[].in_ack` 重发，不触发 `input_gap` | IT-resume-3 |
| AC-2.13 | `hello.instance_id` 与 agent 当前值不符时，所有 `resume` 项判 `gone`（防止 agent 重启后 sid 复用导致张冠李戴） | IT-resume-4 |

---

## AC-3 输入（US-3）

| ID | 标准 | 验证 |
|---|---|---|
| AC-3.1 | Composer 模式下，IME composition 事件不触发任何向 PTY 的写入；只有提交动作才写入 | E2E-7 |
| AC-3.2 | Composer 提交：含换行时以 bracketed paste 包裹（不被逐条执行），单行与空输入不包裹；一律以 `CR` 结尾 | UT-input-1, E2E-8 |
| AC-3.3 | Raw 模式下，composition 期间不向 PTY 写入；`compositionend` 时一次性写入最终文本 | UT-input-2, E2E-7 |
| AC-3.4 | Raw 模式下 `Ctrl+C` / `Ctrl+D` / 方向键 / `Esc` / 功能键正确映射为控制字节 | UT-keymap-1 |
| AC-3.5 | 输入模式随 shell 集成的 prompt 状态自动切换：`B`→Composer，`C`→Raw，`D`→Composer | UT-mode-1, E2E-9 |
| AC-3.6 | 用户手动切换模式后进入"锁定"状态，自动切换暂停，直到用户解锁 | UT-mode-2 |
| AC-3.7 | shell 集成不可用时，模式默认为 Composer 且自动切换禁用，UI 显示降级提示 | E2E-13 |
| AC-3.8 | 软键盘弹出时（`visualViewport` resize），终端可视区与功能键条不被遮挡，布局无跳动 | E2E-10 |
| AC-3.9 | 功能键条包含 `Esc ^C Tab Ctrl ↑ ↓ ← → Alt ^D ^Z ^L \| ~ / - _ Home End PgUp PgDn` 且可横向滚动；`Ctrl`/`Alt` 为粘滞修饰键，`^C`/`^D`/`^Z`/`^L` 一按直发控制码。**`^C` 必须在免滚动的前 8 个里** —— 它是唯一的通用脱困键，而粘滞 `Ctrl` 在软键盘没弹出时（Raw 模式看 top）根本按不出组合 | E2E-10 |
| AC-3.10 | 输入元素禁用 `autocorrect` / `autocapitalize` / `spellcheck` | UT-input-3 |
| AC-3.11 | 终端尺寸变化时向 agent 发 `resize`，agent 对 PTY 执行 `TIOCSWINSZ`；resize 消息做 100ms 防抖 | IT-resize-1, UT-resize-1 |
| AC-3.12 | **终端是唯一显示面**（ADR-0013）：xterm 始终铺满、始终可见；命令在跑（Raw）时 Composer 不隐藏，提交 = 整段 `xterm.paste()` + 回车，「发送」长按 = 只粘贴不回车；占屏（备用缓冲 / 富键盘协议 / DECCKM / 鼠标）**不切视图**，只把键条换成对应上下文（less→分页器、top→top、claude/codex→AI 无 `q`、其余→通用 TUI）并给出「⌨ 打字」入口；占屏时不显示「没有集成」横幅；npm/cargo 多行进度条不误判 | UT-interactive-1, UT-keymap-ai, E2E-11 |
| ~~AC-3.12（旧）~~ | ~~读视图的底栏是三档写态 sheet（收起 / 半屏 / 全屏）：碰输入框升半屏，把手点一下到全屏，拖到底、提交或空输入时 `Esc` 收起且输入框失焦；**三档之间 `.canvas` 几何与 PTY 尺寸不变**（sheet 盖在块流上，不挤画布） | E2E-19 |
| AC-3.13 | **双指缩放读**（ADR-0013）：PTY 固定 43 列；双指放大是纯视觉 transform（只作用在 `.xterm-screen`，不 fit、不发 resize、PTY 尺寸不变），单指平移，缩回 1× 或双击 / 换命令 / 切会话复位 | UT-pinch, E2E-24 |
| ~~AC-3.13（旧）~~ | ~~sheet 打开时有面向"写"的编辑键条 `Tab ↑ ↓ ← → ⌫词 \| ~ / - _ " ' $ ⇤ ⇥` + 发送；`Tab` 有路径 chip 时补第一个；按键不抢输入框焦点 | UT-keymap-2, E2E-19 |
| ~~AC-3.14（ADR-0013 取代）~~ | 读视图下前台出现**占屏程序**时自动切到终端视图、退出后自动回读；占屏 = 备用缓冲激活 **或程序进入全屏输入模式**（富键盘 Kitty `\e[>…u` / modifyOtherKeys `\e[>…m`、应用光标键 DECCKM `\e[?1h`（top）、鼠标跟踪，或同步输出 2026）—— 覆盖 claude / codex / top / vim；**npm / cargo / docker 等多行进度条（藏光标 + 上移重绘但不进入输入模式）不误触发**；重连后从 xterm 当前模式补判（top 运行中刷新不卡）；自动切换不写偏好，手动切过不再自动回 | UT-interactive-1, E2E-11b |
| ~~AC-3.15（ADR-0013 取代）~~ | 命令在跑（Raw）时读视图**仍是同一个 Composer**：提交 = 整段 `xterm.paste()`（按前台程序的括号粘贴模式包裹）+ 回车，sheet 可升起编辑长文；「发送」长按 = 只粘贴不回车；前台是 claude / codex 时键条换成 `Esc ^C Enter ⇧Tab / ↑ ↓ Tab Ctrl`（无 `q`，`⇧Tab` 发 `ESC [ Z`）；**占屏程序里不显示「没有集成」横幅** | UT-keymap-ai, E2E-11b, E2E-19 |
| ~~AC-3.16（ADR-0013 取代）~~ | 前台是 claude / codex 时读视图是**转录视图**：对话卡片（用户 / 助手 Markdown / 工具摘要）原生滚动选择缩放、贴底跟随、「↓ 新内容」；底部**终端尾巴**（xterm 末 8 行纯文本，300ms 节流）点它进终端；数据来自 WS `transcript` + `GET /api/transcript` 回放（刷新后仍在）；命令结束回块流；**AI CLI 占屏不自动进终端**，vim / less / top 照旧 | UT-markdown, UT-transcriptstore, E2E-23 |

---

## AC-4 多会话（US-4）

| ID | 标准 | 验证 |
|---|---|---|
| AC-4.1 | 可同时存在多个会话，各自独立 PTY、独立缓冲、独立序列号 | IT-session-1 |
| AC-4.2 | 会话数达上限（默认 20，可配）时 `session.create` 返回 `session_limit` 错误，UI 显示提示 | IT-session-2, E2E-11 |
| AC-4.3 | 未订阅会话产生输出时，agent 发 `session.updated{head_seq}`；client 按 `head_seq > out_seq` 显示未读标记 | E2E-6 |
| AC-4.4 | 会话默认名为其 CWD 的 basename，CWD 变化时自动更新；手动改名后停止自动更新 | IT-session-3, UT-name-1 |
| AC-4.5 | shell 退出后会话状态变 `exited` 并携带退出码；缓冲内容保留可查看，直到用户显式关闭 | IT-session-4, E2E-11 |
| AC-4.6 | 关闭会话时先送 `SIGHUP`，2 秒后仍存活则 `SIGKILL`，并释放 PTY 与缓冲 | IT-session-5 |

---

## AC-5 阅读输出（US-5）

| ID | 标准 | 验证 |
|---|---|---|
| AC-5.1 | scrollback 至少 5000 行，滚动不进入任何模式 | E2E-12 |
| AC-5.2 | 搜索命中数与跳转正确，支持大小写敏感切换 | E2E-12 |
| AC-5.3 | 字号可调，设置持久化到 localStorage；各断点有独立默认值 | E2E-12 |
| AC-5.4 | 选中文本时自动滚动暂停，选择不被破坏 | E2E-12 |
| AC-5.5 | 渲染使用 WebGL addon；WebGL 不可用时回退到 canvas 且不报错 | UT-render-1 |
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
| AC-6.8 | 命令面板（`Ctrl/Cmd+K`）可模糊搜索会话、快捷命令、历史，回车执行对应动作 | E2E-14 |
| AC-6.9 | 可删除单条历史；可清空全部历史（需二次确认） | UT-store-3, E2E-14 |
| AC-6.10 | 历史记录数超过上限（默认 50000）时按时间淘汰最旧的**非置顶**记录；置顶记录永不淘汰 | UT-store-4 |
| AC-6.11 | 写态 sheet 的 chips：空输入 = 快捷命令 + 同目录历史；有输入 = 光标 token 的真实路径补全（`GET /api/fs`：目录在前、隐藏项按需、目录不存在即空列表、与 shell 同权限）+ 前缀历史；点路径 chip 只替换光标所在 token | UT-fs-1, IT-fs-1, UT-complete-1, E2E-19 |

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
