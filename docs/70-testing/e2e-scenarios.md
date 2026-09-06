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
2. 提交 `sleep 3` → 120ms 去抖后切到 Raw（输入框收起）
3. 3 秒后命令结束 → 立即切回 Composer
4. 提交 `ls`（瞬间结束）→ **不应该出现 Raw 模式的闪烁**（去抖生效）
5. 手动点模式切换 → `locked` 生效，之后的 `prompt` 消息不再改变模式
6. 点"解锁自动" → 立即按当前 prompt 状态重算

---

## E2E-10 移动端布局与功能键条

> AC-3.8, AC-3.9

在 `viewport: { width: 390, height: 844 }`（iPhone 14）下：

1. 功能键条可见，前 8 个键无需滚动
2. 点 `Ctrl` → 激活态有视觉反馈；再按 `c` → 发出 `0x03`；`Ctrl` 自动取消激活
3. 长按 `Ctrl` → 锁定态；连续两次组合都带 `Ctrl`；再点解锁
4. 聚焦 Composer（模拟 `visualViewport` 收缩）→ 终端区收缩，功能键条与 Composer 仍完全可见，布局无跳动
5. 断言：`resize` 消息发出，cols/rows 更新
6. 切到横屏（`844 × 390`）→ `short` 布局生效（功能键条 32px、快捷命令条隐藏）

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

## 不在 E2E 覆盖范围（放手工清单）

- 真机中文输入法的实际候选框行为
- 真实软键盘的弹出动画与布局
- 真实网络切换（Wi-Fi ↔ 4G ↔ 隧道）
- 真实 Let's Encrypt 签发
- PWA 真机安装
- 触觉反馈
