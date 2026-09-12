# ADR-0017 数字配对码：同一次配对发两把钥匙，二维码之外可以手输

状态：已接受（2026-09-12）。补充 [auth-pairing.md](../../60-security/auth-pairing.md) 的配对流程，不改变 Cookie、设备管理与限速设计。

## 背景

配对码是 32 字节 `crypto/rand` 的 base64url（43 个字符），走 URL fragment，靠终端里的 ASCII 二维码送到手机上。这条路在"手机能扫服务器终端"时很顺；但常见的另一种情形是：**人在手机上、终端在另一块屏幕或另一台电脑上，扫不了码**（远程会话、屏幕共享、只有文字的聊天窗口）。43 个字符的 base64 不可能手输，用户只能把 URL 贴进聊天工具 —— 那正是 T2 想避免的：配对码永久留在聊天记录里。

## 决定

1. **一次配对同时发两把钥匙**：URL 码（不变，32 字节熵，走 fragment + 二维码）和一个 **16 位十进制数字码**（约 53 位熵）。两者哈希后存在同一行 `pairings` 里（`code_hash`、`digits_hash`），**任一把用掉，整行作废** —— 单次有效、5 分钟 TTL、常数时间比较这些性质对两把钥匙一样成立。
2. **显示分组**：终端里打成 `1234-5678-9012-3456`（4-4-4-4，`-` 分隔）；手输时 `-` 和空格都接受，其余字符一律剥掉。
3. **入口**：`/pair` 没有 fragment 时不再报"链接里没有配对码"，而是显示一个数字输入框（`inputmode=numeric`、自动分组、满 16 位才能提交），提交走同一个 `POST /auth/pair`。二维码路径不变。
4. **不用数字码替换 URL 码**。二维码那条路没有理由降熵；数字码只是给"扫不了码"的场景一条不经过聊天工具的路。

## 为什么 16 位数字够用

数字码的敌人是在线枚举，不是离线破解（库里只有哈希，且 5 分钟后连哈希都删）。既有限速（AC-1.6）：每 IP 每分钟 5 次、连续失败指数退避到 5 分钟、**全局每小时 50 次失败就熔断 10 分钟**。所以一个配对码存活的 5 分钟里，全网加起来最多 50 次猜测：命中概率 50 / 10¹⁶ = 5 × 10⁻¹⁵。要把这个概率推到 10⁻⁶ 需要连续开 2 亿次配对码。够了 —— 而且熔断会在 stdout 打告警，人会看见。

比这更短（比如 8 位）就不行了：10⁸ 下同样的 50 次是 5 × 10⁻⁷，考虑到攻击者可以等用户反复开码，不再是可以忽略的数。16 位是"手输还能忍"（4 组 4 位，跟银行卡号一样长）与"熵不必再讨论"的交点。

## 代价与取舍

- `pairings` 表多一列（迁移 0002）；`CreatePairing` 多一个参数。
- 终端输出多三行。stdout 本来就打着完整的 URL 码，数字码不增加新的泄露面。
- 配对页多一个表单。没有 fragment 时的"链接里没有配对码"提示被表单取代 —— 那个提示本来就没给用户任何出路。

## 影响

- 文档：[auth-pairing.md](../../60-security/auth-pairing.md) 流程与「手输数字码」一节；[threat-model.md](../../60-security/threat-model.md) T1 熵一行；[acceptance-criteria.md](../../10-requirements/acceptance-criteria.md) AC-1.4 与新增 AC-1.15；[e2e-scenarios.md](../../70-testing/e2e-scenarios.md) E2E-27；[install.md](../../80-ops/install.md) 配对说明。
- 代码：`internal/store`（迁移 0002、`CreatePairing` / `ConsumePairing`）、`internal/auth`（`NewPairingCodes`、`FormatDigits`、`NormalizeCode`）、`cmd/webterm`（`printPairing`）、`web/src/ui/pair.tsx` + `paircode.ts`、`gate.tsx` 文案。
- 测试：UT-pair-5、IT-pair-4、vitest `paircode.test.ts`、E2E-27。
