// Package session 管理 PTY 会话：一个 PTY + 一个环形缓冲 + 一个终端模拟器 +
// 订阅者集合。
//
// 契约见 docs/50-backend/session-manager.md 与 ADR-0026。
//
// Session 不知道 WebSocket 的存在 —— 它只有一个 Subscriber 接口。这让会话
// 逻辑可以在没有网络的情况下单测（IT-session-* / IT-resume-*）。
package session

// Subscriber 是一个输出接收方。连接层实现它。
//
// 三个推送方法【必须非阻塞】：内部有界队列，满则自行断开。阻塞会反压到
// PTY.Read()，一个慢客户端就能拖慢服务器上真正在跑的活。
//
// 同一会话的 Push / Snapshot 都在会话锁内调用（见 Session.consume 的注释），
// 所以它们到达订阅者的先后就是协议上的先后 —— 实现只需按调用顺序入队。
type Subscriber interface {
	// ClientID 返回这个订阅者所属标签页的 id。
	// 输入记账按 (client_id, sid) 走，ack 只发给同一个 client。
	ClientID() string

	// Push 推送一段原始输出（OUTPUT 帧）。seq 是 data 首字节的 out_seq，
	// data 是调用方可以安全持有的拷贝。
	Push(sid uint16, seq uint64, data []byte)

	// Snapshot 推送一份快照（SNAPSHOT 帧）。seq 是快照对应的 out_seq，data
	// 不计入 seq。连接层按单帧上限拆分，同一份快照的帧必须连续入队（协议 §3）。
	Snapshot(sid uint16, seq uint64, data []byte)

	// Event 推送一条控制消息（*protocol.SessionUpdated、*protocol.Ack…）。
	Event(msg any)
}
