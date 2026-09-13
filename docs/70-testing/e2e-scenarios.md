# E2E 场景清单

> 状态：Accepted
>
> Playwright。每个场景标注它验证的验收标准。**改动触及协议、重连、输入或布局时必须更新这份清单**（[CLAUDE.md](../../CLAUDE.md)）。

## 测试夹具

### 启动

```
1. go build 出真二进制（含 go:embed 的前端产物）
2. webterm serve --dev --data-dir <临时目录> --max-sessions 5
   默认 ring-bytes（1 MiB）—— 断线窗口内的输出不会溢出，字节级比较才稳定
   只有 E2E-2c / E2E-4 用 --ring-bytes 65536 单独起一个实例，让 reset 路径可测
3. 从 stdout 抓配对 URL
4. Playwright 打开 URL，完成配对
```

### 确定性输出脚本

`e2e/fixtures/emit.sh` —— 产生固定内容的输出，用于字节级比较：

```bash
#!/bin/bash
# 用法: emit.sh <总行数> [每行延迟ms]
# 内容含：ANSI 颜色、CJK 宽字符、超长行
```

必须**完全确定性**（不含时间戳、不含随机数、不含主机名、不含 `$PWD`），否则字节级比较无意义。

两条容易踩的坑：

- **完成标记必须只出现在输出里。** 写 `echo EMIT-DONE` 的话，被回显的命令行本身就含这个串，等待条件会在命令刚敲完时就满足 —— 测的是回显不是输出。用 `printf 'EMIT-%s\n' DONE`。
- **要测断线期间的行为，就得给每行加延迟**，让输出跨越整个断线窗口。不加的话几千行可能在你把线掐掉之前就全送到了。

### 断开 WebSocket 的手段

```ts
// 方式一：路由层面切断（首选）。装一个可控的中继，随时掐断、随时恢复。
const net = await installWSControl(page)   // e2e/harness.ts
await net.goOffline()
net.goOnline()

// 方式二：CDP 模拟离线
const cdp = await context.newCDPSession(page)
await cdp.send('Network.emulateNetworkConditions', { offline: true, ... })
```

**方式一是首选。** CDP 的 offline 对【已建立】的 WebSocket 不会立刻触发 `onclose` —— 页面会一直以为自己还在线，直到 40 秒后心跳判死。那测的就不是断线了。方式二适合测浏览器 `online` 事件驱动的立即重试。

---

## E2E-1 基础往返

> AC-1.3, AC-1.9, AC-4.1

1. 配对成功，进入主界面
2. Cookie 属性正确（`HttpOnly` / `SameSite=Strict`）
3. 自动创建（或手动创建）一个会话
4. Composer 输入 `echo hello-webterm`，回车
5. 终端出现 `hello-webterm`
6. `stty size` 的输出与前端的 cols/rows 一致

---

## E2E-2 断线续传 ★ 核心

> AC-2.1, AC-2.2, AC-2.3, AC-2.5

### E2E-2a 基准 + 单次断开

1. 跑 `emit.sh 2000`，不断开 → `serialize()` → 基准
2. 新会话，再跑 `emit.sh 2000`，输出进行到约 50% 时切断 WS
3. 等 UI 显示"重连中"→"已恢复"
4. 等输出跑完
5. `serialize()` 与基准**逐字节相等**

### E2E-2b 断开 5 秒（缓冲不溢出）

同上，但断开后 `page.waitForTimeout(5000)` 再允许重连。断言字节一致。

### E2E-2c 断开期间输出超过 ring_bytes → reset

> 用 `--ring-bytes 65536` 的实例。

1. 断开，在断开期间让会话产出 > 64 KiB 输出（`emit.sh 5000`）
2. 重连
3. 断言：
   - `resumed[].status == "reset"`（可通过 UI 提示间接验证）
   - 屏幕出现"历史输出已截断"分隔线
   - **重连后新产生的输出完全正确**（后续 `echo marker-xyz` 能正常显示）
   - 屏幕上没有长串乱码（允许回放起点有少量垃圾字符，见环形缓冲的已知限制）

### E2E-2d 连续快速断开

断开 10 次，每次间隔 300ms。最终字节一致（验证无累积错位）。

### E2E-2e 断点落在着色区间内

让 `emit.sh` 输出一段跨越多帧的同色文本，**在这段中间**断开重连。断言：

- 回放的第一帧 `flags == 0`（`status == "ok"` 时**不得**注入 `ESC[0m`）
- 断点之后的文本颜色与基准一致 —— 这是 AC-2.7 最容易写错的一面

---

## E2E-3 断线期间的输入不丢

> AC-2.4

1. 建立会话，确认在 Composer 模式
2. 切断 WS（不让它立即重连）
3. 在 Composer 里提交三条命令：`echo A1`、`echo A2`、`echo A3`
4. UI 应显示这些输入处于"待发送"状态（而不是静默吞掉）
5. 恢复连接
6. 终端依次出现 `A1`、`A2`、`A3`，**顺序正确、无重复、无丢失**
7. 断言重连过程中**没有出现 `input_gap`**：`welcome.resumed[].in_ack` 必须是断开前的累计值而不是 0（AC-2.12）

变体：断开期间提交超过 64 KiB 的输入 → UI 明确提示"离线输入已满"，不静默丢弃。

---

## E2E-4 缓冲溢出的 reset 路径

> AC-2.6

见 E2E-2c。独立列出是因为它还要验证 UI 侧的表现：清屏发生、提示可见、提示可关闭。

---

## E2E-5 连接状态指示

> AC-2.10

1. 在线 → 绿点
2. 切断 → 橙点 + "重连中 · Ns 后重试"，倒计时递减
3. 恢复 → 绿点 + toast "已恢复 · 补齐 N KB"，3 秒后消失
4. 断言 toast 里的字节数与实际回放量一致（数量级即可）

---

## E2E-6 多会话与未读

> AC-2.11, AC-4.3

1. 创建会话 A、B
2. 在 A 里跑 `emit.sh 100 50`（持续输出）
3. 切到 B
4. A 的列表项出现未读标记（由 `session.updated{head_seq}` > 本地 `out_seq` 推导）
5. 在 B 里 `echo in-b`，正常工作
6. 切回 A：内容**完整**（切走期间的输出全在），未读标记清除
7. A 的滚动位置保持在切走前的位置（除非之前在底部，则跟到底部）

---

## E2E-7 中文 IME 输入

> AC-3.1, AC-3.3

Playwright 可以派发 composition 事件。

### Composer 模式

1. 聚焦 Composer
2. 派发 `compositionstart` → `compositionupdate`（data: `ni`）→ `compositionupdate`（data: `你`）→ `compositionend`（data: `你好`）
3. 断言：**composition 期间没有任何 WebSocket INPUT 帧发出**
4. Composer 内容为 `你好`
5. 组字期间按 `Enter`（`isComposing: true`）→ **不提交**
6. `compositionend` 后按 `Enter` → 提交，终端收到

### Raw 模式

1. 手动切到 Raw
2. 同样派发 composition 事件
3. 断言：`compositionend` 之前零 INPUT 帧；`compositionend` 时**一次**发出 `你好`
4. 组字期间光标位置有内联预览浮层

### Raw 模式 · 切过会话之后（回归）

**每个会话有自己的 xterm 实例，也就有自己的 helper textarea**，而
`store.activate()` 会把上一个会话的 host 从 DOM 摘掉。所以切会话必须
重新挂 `RawIme`。

1. 建第二个会话并切过去
2. 手动切到 Raw，派发 composition 事件
3. 断言：内联预览浮层可见 —— 没重新挂就不会出现。**这条是有效的回归点**
   （已用变异验证：还原成"只挂一次"后它失败）
4. 断言：`compositionend` 之前零 INPUT 帧 —— 留着防回归，但**它测不到本
   bug 的要害**：合成的 `CompositionEvent` 不会触发 xterm 的 `onData`，
   所以「`isComposing` 恒为 false → 组字字节直通 PTY，违反 AC-3.3」这个
   后果只有真输入法能演示（见 [自动化边界](../90-roadmap/milestones.md)）

> 这个 bug 真的存在过（`attachIme` 里的 `if (ime) return` 让它只挂第一个会话），
> 而且只在 CI 上暴露 —— 原来的实现靠 `setInterval(attachIme, 300)` 轮询挂载，
> 本机跑得快正好赶上，CI 上就丢事件。轮询已换成在 `select()` 里确定性挂载。

---

## E2E-8 Composer 提交格式

> AC-3.2

1. 在 Composer 里输入多行内容：
   ```
   echo line1
   echo line2
   ```
2. 提交
3. 拦截 WebSocket 帧，断言 payload 为 `ESC[200~ … ESC[201~ CR`
4. 终端里这两行**作为一整块待编辑的输入**出现，不是被逐条执行

---

## E2E-9 输入模式自动切换

> AC-3.5

1. 停在 prompt → Composer 模式（输入框可见）
2. 提交 `sleep 3` → 120ms 去抖后切到 Raw（输入框仍在，功能键条出现；ADR-0012）
3. 3 秒后命令结束 → 立即切回 Composer
4. 提交 `ls`（瞬间结束）→ **不应该出现 Raw 模式的闪烁**（去抖生效）
5. 点终端区打字 → 直送 PTY，不切模式（ADR-0013：输入按触摸位置判定，没有手动模式开关）

---

## E2E-10 移动端布局与功能键条

> AC-3.8, AC-3.9

在 `viewport: { width: 390, height: 844 }`（iPhone 14）下：

1. 底栏是一条键行：第一个键是互切键 `to-edit`，行尾是 `open-more`；停在 prompt 键区是提示符键集（有 `key-Tab`、没有 `key-Escape`）；`sleep 30` 起来后键区换成通用键集，**前 5 个（`Esc ^C Tab Ctrl ↑`）无需滚动即可见**，且【`^C` 在其中】（ADR-0015）
2. 点 `Ctrl` → 激活态有视觉反馈；再按 `c` → 发出 `0x03`；`Ctrl` 自动取消激活
2b. 直接点 `^C` → 发出 `0x03`，不需要先点 `Ctrl`；Composer 模式下同样直发
3. 长按 `Ctrl` → 锁定态；连续两次组合都带 `Ctrl`；再点解锁
4. 聚焦 Composer（模拟 `visualViewport` 收缩）→ 终端区收缩，功能键条与 Composer 仍完全可见，布局无跳动
5. 断言：`resize` 消息发出，cols/rows 更新
6. 切到横屏（`844 × 390`）→ `short` 布局生效（功能键条 32px、快捷命令条隐藏）
7. **安全区**（PWA 全屏刘海 / Home 指示条）：Chromium 里 `env(safe-area-inset-*)` 恒为 0，所以直接在 `.app` 上覆盖 `--sa-top: 47px`、`--sa-bottom: 34px` → 状态栏顶边落到 47px、键行底边离 `.app` 底边 34px、`.app` 高度不变（JS 写的可视视口高度）、终端正好矮 81px、页面不溢出；再把 `--sa-bottom` 清掉 → 全部复位

> **注**：Playwright 无法真正弹出软键盘。这里通过直接修改容器高度并派发 `visualViewport` resize 事件来模拟。真机验证放在手工清单。

---

## E2E-11 会话生命周期

> AC-4.2, AC-4.5, US-7.3

1. 创建到上限（5 个，夹具里配的）→ 新建按钮禁用 + 显示"会话数已达上限 5"
2. 在某会话里 `exit 1` → 状态变 `exited`，列表项显示 `exit 1`
3. **已退出会话的内容仍可滚动、可搜索、可复制**
4. Composer 收起为提示带：`会话已结束（exit 1）· 重开 · 关闭`
5. 点「重开」→ 在同一 CWD 新建会话
6. 关闭 `running` 会话 → 二次确认
7. 关闭 `exited` 会话 → 无需确认

---

## E2E-12 阅读输出

> AC-5.1, AC-5.2, AC-5.3, AC-5.4

1. 跑 `emit.sh 3000` → 向上滚动能看到早期输出（无需进入任何模式）
2. `Ctrl+F` 搜索一个已知字符串 → 命中数正确、`Enter` 逐个跳转、高亮可见
3. 调整字号 → 生效并持久化（刷新后保持）
4. 选中一段文本，此时有新输出到达 → **选择不被破坏**，自动滚动暂停
5. 复制 → 剪贴板内容正确
6. **回看时暂停跟随**（AC-5.9，桌面与 Pixel 5 各跑一遍）：跑一条持续输出的命令，中途 `__webterm.scrollLines(-N)` 把视口滚上去 → 之后终端缓冲里的行数**不再增长**，`follow-pill` 出现且「新增 N 行」在涨；点提示条 → 全部行一次到齐、每行恰好一次、顺序正确，提示条消失
   - **空闲时回滚也要有提示条**，且必须走**真实的滚动路径**（不是 `scrollLines` 钩子）：命令跑完、没有新输出 → 桌面用 `mouse.wheel` 往上滚，Pixel 5 直接改 `.xterm-viewport.scrollTop`（单指拖动就是这么做的）→ `follow-pill` 出现、文本是「回到底部」；点它 → 视口回到 `baseY`、提示条消失。xterm 对 DOM 驱动的滚动不发 `onScroll`，只用钩子滚的用例测不出这条
7. **渲染器可见**（AC-5.10）：⋯ → 设置 里有 `renderer`，文本是 WebGL 或 Canvas 之一

---

## E2E-13 shell 集成降级

> AC-3.7, AC-7.6, US-7.1

夹具用 `--no-shell-integration`（或指向一个会破坏集成的 `.bashrc`）启动。

1. 会话的 `integration` 变为 `inactive`
2. 顶部出现不打扰的提示：`shell 集成未生效 · 了解原因`
3. **终端照常可用**：能执行命令、能看输出、能滚动
4. 模式固定为 Composer，自动切换不发生
5. 手动切到 Raw → vim 之类的 TUI 能正常操作
6. 历史面板里没有新记录产生，但**旧记录仍可搜索和使用**

---

## E2E-14 命令历史与快捷命令

> AC-6.1, AC-6.4 – AC-6.9

1. 执行 `echo one`、`echo two`、`false` → 历史面板出现三条，退出码分别 0/0/1
2. `false` 那条的退出码用警示色显示
3. 执行 ` echo secret`（**前导空格**）→ 历史里**没有**这条（AC-6.2）
4. 点历史里的 `echo one` → 填入 Composer，光标在末尾，**未执行**
5. `Shift+点击` → 直接执行
6. 点 ☆ 置顶 `echo two` → 出现在置顶区
7. 设置 label 为 `测试二` → 显示 label
8. 拖动排序 → 刷新后顺序保持
9. `Ctrl+K` 命令面板：输入 `ech` → 快捷命令排在前面；输入会话名 → 能切换
10. Composer 里按 `↑` → 翻到 `echo two`；输入 `echo ` 后按 `↑` → 只翻以此开头的
11. 删除单条 → 3 秒撤销 toast，撤销后恢复
12. 清空全部 → 二次确认，告知保留 N 条快捷命令；执行后置顶仍在
13. 移动端视口：快捷命令条可见、可横滑、点击填入、长按执行

---

## E2E-15 设备管理

> AC-1.3, AC-1.11

1. `GET /api/devices` 返回当前设备，`current: true`
2. 用第二个 browser context 完成第二次配对 → 两台设备
3. 从设备一吊销设备二 → **设备二的 WebSocket 在 5 秒内断开**，界面显示"此设备已被吊销"并跳到配对引导页
4. 尝试吊销自己 → 二次确认
5. 一键吊销全部 → 自己也退出

---

## E2E-16 未认证访问

> AC-1.7, AC-1.8

1. 清除 Cookie 后访问 `/` → 静态页正常返回，前端显示"需要配对"引导
2. `GET /api/devices` → 401
3. **`GET /ws` 升级 → 401**（不能只测 REST）
4. 伪造 `Origin: https://evil.com` 的 WS 升级（带有效 Cookie）→ 403
5. 用错误的配对码 `POST /auth/pair` 6 次 → 第 6 次返回 429

---

## E2E-27 手输数字配对码（ADR-0017）

> AC-1.15

`web/e2e/pairdigits.spec.ts`。夹具从 agent stdout 里抓 `dddd-dddd-dddd-dddd`。

1. 打开 `/pair`（没有 fragment）→ 出现数字输入框与「配对」按钮，按钮在不足 16 位时禁用
2. 把数字码**用空格分隔**粘进去 → 输入框显示成 `-` 分组的 16 位；点「配对」→ 跳到 `/`，`conn-text` 为「在线」
3. 同一次配对的 URL 码（二维码那把）此时已作废：另一个 context 打开配对链接 → 「配对码无效或已过期」
4. 输一个 16 位但错误的码 → 401 提示「配对码无效或已过期」，输入框仍在可重试

## E2E-17 PWA

> AC-1.14

1. `manifest.json` 可访问，字段完整
2. Service Worker 注册成功
3. 断网后刷新 → 显示"无法连接到 agent"的明确状态页（不是浏览器的默认错误页，也不假装能用）
4. 断言 Service Worker **没有缓存任何 `/api/*` 或 `/ws` 的响应**

---

---

## E2E-18 agent 重启后不张冠李戴

> AC-2.13

1. 开两个标签页，各自持有会话
2. 重启 agent 进程（会话全部消失，[ADR-0003](../20-architecture/adr/0003-no-tmux.md)）
3. 标签页 A 先重连并新建一个会话 → 它拿到 `sid = 1`
4. 标签页 B 随后重连，`hello` 里带着旧的 `instance_id` 与 `resume{sid:1, out_seq:很大}`
5. 断言：B 拿到的是 `status: "gone"`，UI 提示"会话已结束"，**屏幕上没有把 A 的新会话的输出接到 B 的旧内容后面**

---

## E2E-19 编辑面板 sheet（ADR-0014 互切模型；ADR-0015 键行）

`web/e2e/sheet.spec.ts`，Pixel 5 视口。

1. **档位**：默认终端输入，底栏一条键行（< 70px），`to-edit` 与 `open-more` 可见、没有编辑键；`to-edit` 升半屏（主区高的 35%–60%），`to-terminal` 是 `editkeys` 的第一个键；抓手点一下到全屏（> 80%），全屏时 composer 高度 ≥ `.bottom` 的 70%；`to-terminal` 回终端输入。全程 `.canvas` 的矩形与 `__webterm.size()` 一个字不变
2. **收回的时机**：提交后（harness）回终端；有内容时 `Esc` 只清空、空输入时 `Esc` 收回；命令跑起来（`sleep 30`）是终端输入 + 通用键集（`key-Escape` `key-CtrlC`），`^C` 回到 prompt 后键区换回提示符键集（`key-Escape` 退场、`key-Tab` 仍在）
3. **chips**：`mktemp -d` 造 `src/commands`、`docs`、`src/a.go` 并 `cd` 进去；空输入出现同目录历史、没有路径 chip；敲 `cd s` 出现 `src/`（没有 `docs`），点一下变 `cd src/` 且焦点不丢；`Tab` 编辑键补成 `cd src/commands/`；`|` 插 ` | `，`⌫词` 删词；发送键提交后留在面板、输入框清空
4. **⋯ 菜单**：会话 / 历史 / 命令面板 / 设置从这里进；点外面收起

## E2E-11b 占屏程序自动进控（已随 ADR-0013 移除；占屏改为换键条上下文，见 control.spec）

`web/e2e/control.spec.ts`，Pixel 5 视口。

1. 备用缓冲：裸 `\e[?1049h … \e[?1049l` → 自动进终端、退出回读、不写偏好
2. **主屏全屏程序**：合成"建立 Kitty 键盘协议 `\e[>1u` + 藏光标上移重写、跑完自退"的程序（claude/codex 的机械签名，不切备用缓冲）→ `interactive` 被识别为 true 且 `altScreen` 为 false、自动进终端，退出后自动回读、不写偏好；npm 式多行进度条（无键盘协议）不误触发
3. `less` 占屏：键条换成分页器键，`q` 退出回读
4. 用户手动选终端后，备用缓冲进出都不改它

## E2E-12b 块最大化 / 恢复（已随 ADR-0013 移除）

`web/e2e/readview.spec.ts`。跑 `seq 1 80` 展开块 → 点最大化，`.block-maxwrap` 铺满整屏（高 > 90% 视口、宽 = 视口）、标题栏含命令原文、正文含末尾 `DONE-OK`；点「恢复」→ 覆盖层消失、块仍展开。

## E2E-20 在终端里看 → 定位到该块（已随 ADR-0013 移除）

`web/e2e/locate.spec.ts`，Pixel 5 视口。

1. 跑 `seq 1 150; echo ALPHA-END`、`seq 200 350; echo BETA-END`、`echo GAMMA-LAST` 三块；读视图里展开块 A 点「在终端里看」→ 视图切到终端，**视口顶行正是 `1`**（块 A 输出的第一行），且不是滚到顶；回读再看块 B → 顶行 `200`，且比 A 更靠下
2. 终端视图的「块」面板（⋯ → 块）里点同一动作 → 面板关掉、终端滚到块首行

## E2E-21 软键盘几何：键盘一弹输入控件仍在可视区

`web/e2e/keyboard.spec.ts`，Pixel 5 视口。两种浏览器模型都覆盖（见 [`../40-frontend/layout-responsive.md`](../40-frontend/layout-responsive.md) §高度计算）：

1. **布局视口一起缩**（`resizes-content`）：聚焦 Composer 后把视口从 727 缩到 450 → `.app` 高 450、无 `translateY`、Composer 在 [0,450]；终端视图「⌨ 打字」后同样，键条在 [0,450]
2. **只缩可视视口 + 上推**（iOS Safari / Chrome `resizes-visual`）：假 `visualViewport` 重放"可视 727→400、`offsetTop`→327"，分别在 **Safari 语义（`innerHeight` 跟着变 400）** 与 Chrome 语义（恒 727）下 → `.app` 必须 `translateY(327px)`、顶部 = 327、Composer 在可视区 [327,727]；键盘收起全部复位
3. **普通回弹不补偿**：`offsetTop` 变成 −40 / 60 而高度不变 → `.app` 无 `translateY`（守住拖动抖动的修复）

## E2E-23 转录视图（已随 ADR-0013 移除）

`web/e2e/transcript.spec.ts`，Pixel 5 视口。用 shell 函数冒充 `claude`：键盘协议入栈（占屏）+ 往 `WEBTERM_TRANSCRIPT_HOME`（测试前设成临时目录，agent 与会话 shell 都继承）下的 `.claude/projects/<slug>/e2e.jsonl` 写两行 JSONL，然后 `read` 一行回显、长睡。

1. 起假 claude → 读视图换成转录视图，尾巴条出现程序打的那行；等 1.2 秒仍在读视图（占屏但不自动进终端）；键条 `data-context=claude`
2. 卡片：用户气泡有 prompt；助手卡片里 `h2` / `strong` / `pre code` 都渲出来了；工具摘要 `Bash` + `go test ./...`
3. Composer 填一行回车 → 尾巴条看到程序的 `GOT-…` 回显（整段粘贴 + 回车进了程序 stdin）
4. 点尾巴进终端；键条「读」回来，卡片仍在
5. `^C` 打断 → 命令结束 → 回到块流（转录条目留着，供回放）
6. **刷新页面**（另起一次假 claude）：`GET /api/transcript` 回放 → 转录视图与卡片都回来，用户气泡只有一个（去重）
7. 非 AI 的占屏程序（`printf '\033[>1u'; sleep`）照旧自动进终端，没有转录视图

## E2E-25 底栏键行（ADR-0015）

`web/e2e/inputmodel.spec.ts` 与 `web/e2e/sheet.spec.ts`，Pixel 5 视口。

1. **不盖终端**：停在提示符、`sleep 30` 在跑、进备用缓冲三种情况下，终端态 `.bottom` 的高度都 ≤ `.bottom-slot` 的高度
2. **互切键在行首**：终端态 `to-edit` 是 `.keybar` 的第一个子元素；编辑面板里 `to-terminal` 是 `editkeys` 的第一个子元素；两者高度相同（44px）；面板里没有 `sheet-close`
3. **编辑态并入程序键**：`sleep 30` 在跑时切编辑面板，`editkeys` 里出现 `key-Escape` `key-CtrlC`，页面上只有一条键行（没有 `keybar`）；点 `key-CtrlC` 回到 prompt 后它们退场
4. **主屏占屏程序的键条**：`printf '\033[>1u'; sleep` 在终端态时 `keybar` 的 `data-context` 不是 `shell`（与编辑态一致）

`web/e2e/tablet.spec.ts`，iPad mini（触屏 UA，`hasTouch`）：

5. **横屏 1133×744**：`data-bp=desktop`、侧栏可见（宽 ≥ 200px）；**没有 `modebar`**，有 `term-bar`，`to-edit` 是键行第一个键，`.bottom` ≤ `.bottom-slot`；点 `⋯` → `more-menu` 宽 ≤ 320px 且右缘贴着 `.main` 右缘（≤ 16px）；菜单里「设置」能打开 `settings`
6. **竖屏 744×1133**：`data-bp=tablet`；提示符键集 12 个键全部免滚（`.keybar-scroll` 的 `scrollWidth ≤ clientWidth + 1`）；`to-edit` 升半屏后 `.bottom` 高度在 [190, 420]；`⋯` 菜单宽 ≤ 320px

## E2E-24 双指缩放读（ADR-0013）

`web/e2e/pinch.spec.ts`，Pixel 5 视口。在 `.term` 上派发两指 `touchstart`/`touchmove`/`touchend`：

1. 双指张开 → `__webterm.zoom() > 1`、`.xterm-screen` 有 `scale(...)`、`__webterm.size()`（PTY cols/rows）**不变**；双击复位到 1× 且 transform 清空
2. 捏合（缩小）不放大：`zoom()` 保持 1、transform 为空

## E2E-26 热升级不丢会话（ADR-0016）

`web/e2e/reexec.spec.ts`。夹具给 agent 进程发 `SIGUSR2`（`Agent.reexec()`）——
真二进制原地 exec 同一个文件，PID 不变，stdout 管道照旧。

1. 起一条持续输出的命令（300 行、每行间隔 20ms、最后打 `REEXEC-DONE`），输出中途发 `SIGUSR2`
2. 浏览器只看到一次重连：`conn-text` 短暂离开「在线」后回到「在线」；重连后的 `welcome.resumed[0].status == "ok"`（`instance_id` 没变）
3. 命令跑完后终端里 300 行**每行恰好一次、顺序正确**（不丢不重），`REEXEC-DONE` 在
4. shell 仍活着：再提交一条命令有输出；`webterm reload --probe` 对新进程返回 0，`status` 里的 `generation` 为 1
5. 预检失败路径：把 `--handoff-check-fail` 之类的注入留给 Go 集成测试（IT-handoff-1），E2E 不模拟

## 不在 E2E 覆盖范围（放手工清单）

- 真机中文输入法的实际候选框行为
- 真实软键盘的弹出动画与布局
- 真实网络切换（Wi-Fi ↔ 4G ↔ 隧道）
- 真实 Let's Encrypt 签发
- PWA 真机安装
- 触觉反馈
