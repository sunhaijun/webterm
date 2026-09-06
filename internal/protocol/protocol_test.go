package protocol_test

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/sunhaijun/webterm/internal/protocol"
)

type vectors struct {
	BinaryFrames []struct {
		Name    string `json:"name"`
		Hex     string `json:"hex"`
		Decoded struct {
			Type       uint8  `json:"type"`
			Flags      uint8  `json:"flags"`
			SID        uint16 `json:"sid"`
			Seq        uint64 `json:"seq"`
			PayloadHex string `json:"payload_hex"`
		} `json:"decoded"`
		DataLen int `json:"data_len"`
	} `json:"binary_frames"`
	InvalidFrames []struct {
		Name        string `json:"name"`
		Hex         string `json:"hex"`
		ExpectError string `json:"expect_error"`
	} `json:"invalid_frames"`
	ControlMessages []struct {
		Name string          `json:"name"`
		JSON json.RawMessage `json:"json"`
	} `json:"control_messages"`
	UnknownMessages []struct {
		Name string          `json:"name"`
		JSON json.RawMessage `json:"json"`
	} `json:"unknown_messages"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// 协议向量：与前端共用同一份 fixture，防止两侧实现漂移（协议 §9）。
func TestVectorsBinaryFrames(t *testing.T) {
	for _, tc := range loadVectors(t).BinaryFrames {
		t.Run(tc.Name, func(t *testing.T) {
			raw, err := hex.DecodeString(tc.Hex)
			if err != nil {
				t.Fatal(err)
			}
			f, err := protocol.DecodeFrame(raw)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			wantPayload, _ := hex.DecodeString(tc.Decoded.PayloadHex)
			got := protocol.Frame{Type: f.Type, Flags: f.Flags, SID: f.SID, Seq: f.Seq, Payload: f.Payload}
			want := protocol.Frame{
				Type: tc.Decoded.Type, Flags: tc.Decoded.Flags,
				SID: tc.Decoded.SID, Seq: tc.Decoded.Seq, Payload: wantPayload,
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("decoded\n got %+v\nwant %+v", got, want)
			}
			if f.DataLen() != tc.DataLen {
				t.Errorf("DataLen = %d, want %d", f.DataLen(), tc.DataLen)
			}
			// 往返：重新编码必须逐字节还原
			if re := hex.EncodeToString(protocol.EncodeFrame(f)); re != tc.Hex {
				t.Errorf("re-encode = %s, want %s", re, tc.Hex)
			}
		})
	}
}

func TestVectorsInvalidFrames(t *testing.T) {
	for _, tc := range loadVectors(t).InvalidFrames {
		t.Run(tc.Name, func(t *testing.T) {
			raw, err := hex.DecodeString(tc.Hex)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := protocol.DecodeFrame(raw); err == nil {
				t.Fatalf("expected %s, got nil", tc.ExpectError)
			}
		})
	}
}

// 控制消息：解析 → 重新编码 → 语义等价（字段顺序无关）。
func TestVectorsControlMessages(t *testing.T) {
	for _, tc := range loadVectors(t).ControlMessages {
		t.Run(tc.Name, func(t *testing.T) {
			msg, err := protocol.Decode(tc.JSON)
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			out, err := protocol.Encode(msg)
			if err != nil {
				t.Fatalf("encode: %v", err)
			}
			var want, got map[string]any
			_ = json.Unmarshal(tc.JSON, &want)
			_ = json.Unmarshal(out, &got)
			for k, wv := range want {
				gv, ok := got[k]
				if !ok {
					t.Errorf("字段 %q 在往返后丢失", k)
					continue
				}
				if !reflect.DeepEqual(gv, wv) {
					t.Errorf("字段 %q = %#v, want %#v", k, gv, wv)
				}
			}
		})
	}
}

// 未知 t 值必须以 ErrUnknownType 报出来，让调用方【忽略】而不是关连接（协议 §4）。
func TestVectorsUnknownMessagesAreIgnorable(t *testing.T) {
	for _, tc := range loadVectors(t).UnknownMessages {
		t.Run(tc.Name, func(t *testing.T) {
			_, err := protocol.Decode(tc.JSON)
			var unknown *protocol.ErrUnknownType
			if !asErr(err, &unknown) {
				t.Fatalf("err = %v, want *ErrUnknownType", err)
			}
		})
	}
}

func asErr[T error](err error, target *T) bool {
	if e, ok := err.(T); ok {
		*target = e
		return true
	}
	return false
}

// 帧编解码往返：覆盖向量之外的边界组合。
func TestFrameRoundTrip(t *testing.T) {
	cases := []protocol.Frame{
		{Type: protocol.TypeOutput, SID: 0, Seq: 0, Payload: []byte{0}},
		{Type: protocol.TypeInput, SID: 65535, Seq: ^uint64(0), Payload: []byte{0xff}},
		{Type: protocol.TypeOutput, SID: 1, Seq: 1, Payload: make([]byte, protocol.MaxPayload)},
		{
			Type: protocol.TypeOutput, Flags: protocol.FlagAttrPrefix, SID: 9, Seq: 42,
			Payload: append(append([]byte{}, protocol.AttrPrefix...), "x"...),
		},
	}
	for i, want := range cases {
		got, err := protocol.DecodeFrame(protocol.EncodeFrame(want))
		if err != nil {
			t.Fatalf("case %d: %v", i, err)
		}
		if got.Type != want.Type || got.Flags != want.Flags || got.SID != want.SID ||
			got.Seq != want.Seq || string(got.Payload) != string(want.Payload) {
			t.Errorf("case %d: round-trip mismatch", i)
		}
	}
}

func TestFrameTooLarge(t *testing.T) {
	big := protocol.EncodeFrame(protocol.Frame{
		Type: protocol.TypeOutput, SID: 1, Payload: make([]byte, protocol.MaxPayload+1),
	})
	if _, err := protocol.DecodeFrame(big); err != protocol.ErrFrameTooLarge {
		t.Fatalf("err = %v, want ErrFrameTooLarge", err)
	}
}

// AttrPrefix 的 4 个字节不计入 seq —— 算错了两侧会永久错开 4 字节。
func TestAttrPrefixNotCountedInSeq(t *testing.T) {
	data := []byte("hello")
	f := protocol.Frame{
		Type:    protocol.TypeOutput,
		Flags:   protocol.FlagAttrPrefix,
		SID:     1,
		Seq:     1000,
		Payload: append(append([]byte{}, protocol.AttrPrefix...), data...),
	}
	if f.DataLen() != len(data) {
		t.Fatalf("DataLen = %d, want %d", f.DataLen(), len(data))
	}
	// 下一帧的 seq 必须接在 1000 + 5 上，而不是 1000 + 9
	if next := f.Seq + uint64(f.DataLen()); next != 1005 {
		t.Fatalf("next seq = %d, want 1005", next)
	}
}

func TestEncodeFillsTypeTag(t *testing.T) {
	b, err := protocol.Encode(&protocol.Prompt{SID: 1, State: protocol.PromptRunning})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["t"] != protocol.TPrompt {
		t.Fatalf("t = %v, want %q", m["t"], protocol.TPrompt)
	}
}

// session.updated 只带发生变化的字段 —— 没设的字段不能出现在 JSON 里。
func TestSessionUpdatedOmitsUnchangedFields(t *testing.T) {
	head := uint64(491337)
	b, err := protocol.Encode(&protocol.SessionUpdated{SID: 2, HeadSeq: &head})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if len(m) != 3 { // t, sid, head_seq
		t.Fatalf("字段数 = %d (%v), want 3", len(m), m)
	}
}
