// Package protocol 是 WebSocket 协议的 Go 侧实现。
//
// 契约见 docs/30-protocol/websocket-protocol.md —— 那篇文档是唯一事实来源，
// 本包与 web/src/protocol 必须严格对应，两侧都跑 testdata/vectors.json。
package protocol

import (
	"encoding/binary"
	"errors"
)

// 版本号。二进制帧布局变更、已有字段语义变更、删除字段时必须递增（协议 §8）。
// 2：ADR-0026 —— 新增 SNAPSHOT 帧，删除 ATTR_PREFIX 与 reset / redraw / shell 集成的消息。
const Version = 2

// 二进制帧常量（协议 §3）。
const (
	HeaderSize = 12
	MaxPayload = 256 << 10 // 256 KiB

	TypeOutput   uint8 = 0x01 // agent → client
	TypeInput    uint8 = 0x02 // client → agent
	TypeSnapshot uint8 = 0x03 // agent → client

	// FlagMore：同一份快照后面还有帧（仅 SNAPSHOT）。其余位保留：发送方填 0，接收方忽略。
	FlagMore uint8 = 0x01
)

var (
	ErrBadFrame      = errors.New("protocol: bad frame")
	ErrFrameTooLarge = errors.New("protocol: frame too large")
)

// Frame 是一个二进制数据帧。
type Frame struct {
	Type  uint8
	Flags uint8
	SID   uint16
	// Seq：OUTPUT / INPUT 是本帧【首字节】的 out_seq / in_seq；
	// SNAPSHOT 是这份快照对应的 out_seq（模拟器恰好吃完了前 Seq 个字节）。
	Seq     uint64
	Payload []byte
}

// DataLen 返回本帧计入 seq 的字节数：OUTPUT / INPUT 是整个 payload，
// SNAPSHOT 是 0 —— 快照是 agent 生成的渲染指令，不是流内容（协议 §3）。
//
// 连续的 OUTPUT 帧必须满足 seq(n+1) == seq(n) + DataLen(n)。
func (f Frame) DataLen() int {
	if f.Type == TypeSnapshot {
		return 0
	}
	return len(f.Payload)
}

// More 报告这是不是一份快照里的非最后一帧。
func (f Frame) More() bool { return f.Type == TypeSnapshot && f.Flags&FlagMore != 0 }

// FromClient 报告这个 type 是不是 client 可以发的。client 发来 OUTPUT /
// SNAPSHOT → bad_frame（协议 §3）。
func (f Frame) FromClient() bool { return f.Type == TypeInput }

// AppendFrame 把 f 编码后追加到 dst，返回扩展后的切片。
// 复用 dst 可以让发送路径零分配。
func AppendFrame(dst []byte, f Frame) []byte {
	var hdr [HeaderSize]byte
	hdr[0] = f.Type
	hdr[1] = f.Flags
	binary.BigEndian.PutUint16(hdr[2:4], f.SID)
	binary.BigEndian.PutUint64(hdr[4:12], f.Seq)
	dst = append(dst, hdr[:]...)
	return append(dst, f.Payload...)
}

// EncodeFrame 编码单个帧。
func EncodeFrame(f Frame) []byte {
	return AppendFrame(make([]byte, 0, HeaderSize+len(f.Payload)), f)
}

// SnapshotFrames 把一份快照切成 payload 不超过 MaxPayload 的 SNAPSHOT 帧
// （协议 §3）：所有帧 seq 相同，除最后一帧外都置 FlagMore。data 为空时返回
// nil —— payload 长度为 0 的帧是非法的。
//
// 返回的帧 Payload 是 data 的子切片，不拷贝。
func SnapshotFrames(sid uint16, seq uint64, data []byte) []Frame {
	if len(data) == 0 {
		return nil
	}
	out := make([]Frame, 0, (len(data)+MaxPayload-1)/MaxPayload)
	for off := 0; off < len(data); off += MaxPayload {
		end := min(off+MaxPayload, len(data))
		f := Frame{Type: TypeSnapshot, SID: sid, Seq: seq, Payload: data[off:end]}
		if end < len(data) {
			f.Flags = FlagMore
		}
		out = append(out, f)
	}
	return out
}

// DecodeFrame 解析一个二进制帧。Payload 是 b 的子切片，不拷贝。
//
// 只校验帧本身：长度、payload 非空、type 是已知值（未知 → ErrBadFrame）。
// 方向对不对由接收方用 FromClient 判断。
func DecodeFrame(b []byte) (Frame, error) {
	if len(b) < HeaderSize+1 { // payload 长度为 0 的帧是非法的
		return Frame{}, ErrBadFrame
	}
	if len(b)-HeaderSize > MaxPayload {
		return Frame{}, ErrFrameTooLarge
	}
	f := Frame{
		Type:    b[0],
		Flags:   b[1],
		SID:     binary.BigEndian.Uint16(b[2:4]),
		Seq:     binary.BigEndian.Uint64(b[4:12]),
		Payload: b[HeaderSize:],
	}
	switch f.Type {
	case TypeOutput, TypeInput, TypeSnapshot:
	default:
		return Frame{}, ErrBadFrame
	}
	return f, nil
}
