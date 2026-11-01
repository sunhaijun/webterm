// Package protocol implements the Go side of the WebSocket protocol.
//
// docs/30-protocol/websocket-protocol.md is the source of truth. This package
// and web/src/protocol must match it exactly; both run testdata/vectors.json.
package protocol

import (
	"encoding/binary"
	"errors"
)

// Version is the protocol version. Bump it when the binary frame layout
// changes, an existing field changes meaning, or a field is removed (protocol
// §8).
//
// 2: ADR-0026 added the SNAPSHOT frame and removed ATTR_PREFIX and the
// reset / redraw / shell-integration messages.
const Version = 2

// Binary frame constants (protocol §3).
const (
	HeaderSize = 12
	MaxPayload = 256 << 10 // 256 KiB

	TypeOutput   uint8 = 0x01 // agent -> client
	TypeInput    uint8 = 0x02 // client -> agent
	TypeSnapshot uint8 = 0x03 // agent -> client

	// FlagMore marks a SNAPSHOT frame that is not the last of its snapshot.
	// Other bits are reserved: senders set 0, receivers ignore them.
	FlagMore uint8 = 0x01
)

var (
	ErrBadFrame      = errors.New("protocol: bad frame")
	ErrFrameTooLarge = errors.New("protocol: frame too large")
)

// Frame is a binary data frame.
type Frame struct {
	Type  uint8
	Flags uint8
	SID   uint16
	// Seq is the out_seq / in_seq of the first payload byte for OUTPUT /
	// INPUT. For SNAPSHOT it is the out_seq the snapshot represents: the
	// emulator had consumed exactly the first Seq bytes.
	Seq     uint64
	Payload []byte
}

// DataLen returns how many bytes the frame adds to seq: the whole payload for
// OUTPUT / INPUT, and 0 for SNAPSHOT, which is a render instruction generated
// by the agent rather than stream content (protocol §3).
//
// Consecutive OUTPUT frames satisfy seq(n+1) == seq(n) + DataLen(n).
func (f Frame) DataLen() int {
	if f.Type == TypeSnapshot {
		return 0
	}
	return len(f.Payload)
}

// More reports whether f is a snapshot frame with more frames to follow.
func (f Frame) More() bool { return f.Type == TypeSnapshot && f.Flags&FlagMore != 0 }

// FromClient reports whether a client may send this frame type. OUTPUT or
// SNAPSHOT from a client is a bad_frame (protocol §3).
func (f Frame) FromClient() bool { return f.Type == TypeInput }

// AppendFrame encodes f, appends it to dst, and returns the extended slice.
// Reusing dst keeps the send path allocation-free.
func AppendFrame(dst []byte, f Frame) []byte {
	var hdr [HeaderSize]byte
	hdr[0] = f.Type
	hdr[1] = f.Flags
	binary.BigEndian.PutUint16(hdr[2:4], f.SID)
	binary.BigEndian.PutUint64(hdr[4:12], f.Seq)
	dst = append(dst, hdr[:]...)
	return append(dst, f.Payload...)
}

// EncodeFrame encodes a single frame.
func EncodeFrame(f Frame) []byte {
	return AppendFrame(make([]byte, 0, HeaderSize+len(f.Payload)), f)
}

// SnapshotFrames splits a snapshot into SNAPSHOT frames whose payloads fit in
// MaxPayload (protocol §3). All frames share seq; every frame but the last has
// FlagMore set. Empty data returns nil, since a zero-length payload is invalid.
//
// Payloads are subslices of data, not copies.
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

// DecodeFrame parses a binary frame. Payload is a subslice of b, not a copy.
//
// It validates only the frame itself: length, non-empty payload, and a known
// type (unknown types return ErrBadFrame). The receiver checks direction with
// FromClient.
func DecodeFrame(b []byte) (Frame, error) {
	if len(b) < HeaderSize+1 { // a zero-length payload is invalid
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
