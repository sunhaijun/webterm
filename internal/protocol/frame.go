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
const Version = 1

// 二进制帧常量（协议 §3）。
const (
	HeaderSize = 12
	MaxPayload = 256 << 10 // 256 KiB

	TypeOutput uint8 = 0x01 // agent → client
	TypeInput  uint8 = 0x02 // client → agent

	// FlagAttrPrefix：payload 的前 4 字节是 AttrPrefix，属于渲染修正，不计入 seq。
	// 只出现在 reset 回放的第一帧上（协议 §3 / §5.1）。
	FlagAttrPrefix uint8 = 0x01
)

// AttrPrefix 是 reset 回放前置的 SGR reset，用于清除因裁剪而悬空的颜色/属性。
// 这 4 个字节不计入 out_seq —— 记账错了两侧会永久错开 4 字节。
var AttrPrefix = []byte{0x1b, '[', '0', 'm'}

var (
	ErrBadFrame      = errors.New("protocol: bad frame")
	ErrFrameTooLarge = errors.New("protocol: frame too large")
)

// Frame 是一个二进制数据帧。
type Frame struct {
	Type    uint8
	Flags   uint8
	SID     uint16
	Seq     uint64 // 本帧【首个计入 seq 的字节】的 out_seq / in_seq
	Payload []byte
}

// DataLen 返回本帧计入 seq 的字节数。带 FlagAttrPrefix 时前 4 字节不算。
//
// 连续的 OUTPUT 帧必须满足 seq(n+1) == seq(n) + DataLen(n)。
func (f Frame) DataLen() int {
	n := len(f.Payload)
	if f.Flags&FlagAttrPrefix != 0 {
		n -= len(AttrPrefix)
	}
	return n
}

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

// DecodeFrame 解析一个二进制帧。Payload 是 b 的子切片，不拷贝。
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
	case TypeOutput, TypeInput:
	default:
		return Frame{}, ErrBadFrame
	}
	// FlagAttrPrefix 只对 OUTPUT 有意义，且 payload 必须真的以 AttrPrefix 开头。
	if f.Flags&FlagAttrPrefix != 0 {
		if f.Type != TypeOutput || len(f.Payload) < len(AttrPrefix) ||
			string(f.Payload[:len(AttrPrefix)]) != string(AttrPrefix) {
			return Frame{}, ErrBadFrame
		}
	}
	return f, nil
}
