// Package session 管理 PTY 会话：一个 PTY + 一个环形缓冲 + 订阅者集合 +
// OSC 状态机。
//
// 契约见 docs/50-backend/session-manager.md。
//
// Session 不知道 WebSocket 的存在 —— 它只有一个 Subscriber 接口。这让会话
// 逻辑可以在没有网络的情况下单测（IT-session-* / IT-resume-*），也是 m1
// 能在没有前端的情况下证明续传逻辑正确的前提。
package session

// Subscriber 是一个输出接收方。连接层实现它。
type Subscriber interface {
	// ClientID 返回这个订阅者所属标签页的 id。
	// 输入记账按 (client_id, sid) 走，ack 只发给同一个 client。
	ClientID() string

	// Push 推送一段输出。data 是调用方可以安全持有的拷贝。
	//
	// attrPrefix 为 true 时，连接层必须在 data 前插入 protocol.AttrPrefix
	// 并置 protocol.FlagAttrPrefix —— 那 4 个字节【不计入 seq】。它只会在
	// reset 回放的第一帧上出现。
	//
	// 实现【必须非阻塞】：内部有界队列，满则自行断开。阻塞会反压到
	// PTY.Read()，一个慢客户端就能拖慢服务器上真正在跑的活。
	Push(sid uint16, seq uint64, data []byte, attrPrefix bool)

	// Event 推送一条控制消息（*protocol.Prompt、*protocol.CWD、
	// *protocol.CommandStart、*protocol.SessionUpdated…）。同样必须非阻塞。
	Event(msg any)
}
