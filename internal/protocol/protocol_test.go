package protocol_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strconv"
	"testing"

	"github.com/sunhaijun/webterm/internal/protocol"
)

type vectors struct {
	BinaryFrames []struct {
		Name    string `json:"name"`
		Hex     string `json:"hex"`
		Decoded struct {
			Type  uint8  `json:"type"`
			Flags uint8  `json:"flags"`
			SID   uint16 `json:"sid"`
			// seq 在 fixture 里是【字符串】：它是 uint64，超过 2^53 的值
			// 过不了 JS 的 JSON.parse，而这份 fixture 要给两侧共用。
			Seq        string `json:"seq"`
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
			wantSeq, err := strconv.ParseUint(tc.Decoded.Seq, 10, 64)
			if err != nil {
				t.Fatalf("fixture 里的 seq 不是合法的 uint64: %v", err)
			}
			got := protocol.Frame{Type: f.Type, Flags: f.Flags, SID: f.SID, Seq: f.Seq, Payload: f.Payload}
			want := protocol.Frame{
				Type: tc.Decoded.Type, Flags: tc.Decoded.Flags,
				SID: tc.Decoded.SID, Seq: wantSeq, Payload: wantPayload,
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
		{Type: protocol.TypeSnapshot, Flags: protocol.FlagMore, SID: 9, Seq: 42, Payload: []byte("\x1b[H")},
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

// 快照字节不计入 seq（协议 §3）：OUTPUT 的 DataLen 是 payload 长度，SNAPSHOT 是 0。
func TestSnapshotNotCountedInSeq(t *testing.T) {
	out := protocol.Frame{Type: protocol.TypeOutput, SID: 1, Seq: 1000, Payload: []byte("hello")}
	if out.DataLen() != 5 {
		t.Fatalf("OUTPUT DataLen = %d, want 5", out.DataLen())
	}
	snap := protocol.Frame{Type: protocol.TypeSnapshot, SID: 1, Seq: 1000, Payload: []byte("\x1b[H\x1b[2Jxx")}
	if snap.DataLen() != 0 {
		t.Fatalf("SNAPSHOT DataLen = %d, want 0 —— 快照是渲染指令，不是流内容", snap.DataLen())
	}
}

// 方向：client 只能发 INPUT（协议 §3）。
func TestFrameDirection(t *testing.T) {
	for typ, want := range map[uint8]bool{
		protocol.TypeInput: true, protocol.TypeOutput: false, protocol.TypeSnapshot: false,
	} {
		if got := (protocol.Frame{Type: typ}).FromClient(); got != want {
			t.Errorf("type %#x FromClient = %v, want %v", typ, got, want)
		}
	}
}

// 快照分帧（协议 §3）：超过单帧上限就拆，所有帧 seq 相同，除最后一帧外都带 MORE，
// 拼起来就是原快照。
func TestSnapshotFrames(t *testing.T) {
	if fs := protocol.SnapshotFrames(1, 7, nil); fs != nil {
		t.Fatalf("空快照应当不产生帧（payload 为 0 的帧非法），得到 %d 帧", len(fs))
	}
	for _, n := range []int{1, protocol.MaxPayload - 1, protocol.MaxPayload, protocol.MaxPayload + 1, 2*protocol.MaxPayload + 17} {
		data := make([]byte, n)
		for i := range data {
			data[i] = byte(i * 7)
		}
		fs := protocol.SnapshotFrames(3, 99, data)
		want := (n + protocol.MaxPayload - 1) / protocol.MaxPayload
		if len(fs) != want {
			t.Fatalf("n=%d：%d 帧，want %d", n, len(fs), want)
		}
		var joined []byte
		for i, f := range fs {
			if f.Type != protocol.TypeSnapshot || f.SID != 3 || f.Seq != 99 {
				t.Fatalf("n=%d 帧 %d：头不对 %+v", n, i, f)
			}
			if len(f.Payload) == 0 || len(f.Payload) > protocol.MaxPayload {
				t.Fatalf("n=%d 帧 %d：payload %d 字节", n, i, len(f.Payload))
			}
			last := i == len(fs)-1
			if f.More() == last {
				t.Fatalf("n=%d 帧 %d：MORE=%v，最后一帧才该清零", n, i, f.More())
			}
			// 编码后能被解出来
			if _, err := protocol.DecodeFrame(protocol.EncodeFrame(f)); err != nil {
				t.Fatalf("n=%d 帧 %d：%v", n, i, err)
			}
			joined = append(joined, f.Payload...)
		}
		if !bytes.Equal(joined, data) {
			t.Fatalf("n=%d：拼起来不是原快照", n)
		}
	}
}

func TestEncodeFillsTypeTag(t *testing.T) {
	b, err := protocol.Encode(&protocol.Ack{SID: 1, InAck: 3})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["t"] != protocol.TAck {
		t.Fatalf("t = %v, want %q", m["t"], protocol.TAck)
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

// v2 删掉的消息（reset / redraw / cwd / prompt / command.*）收到时必须当未知类型
// 忽略 —— 前向兼容的规则同样适用于"别人还在发、我已经不认了"的消息。
func TestRemovedMessagesAreUnknown(t *testing.T) {
	for _, typ := range []string{"reset", "redraw", "cwd", "prompt", "command.start", "command.end"} {
		_, err := protocol.Decode([]byte(`{"t":"` + typ + `","sid":1}`))
		var unknown *protocol.ErrUnknownType
		if !asErr(err, &unknown) {
			t.Errorf("%s: err = %v, want *ErrUnknownType", typ, err)
		}
	}
}

// 会话快照里不再有 shell 集成的字段（协议 v2）。
func TestSessionInfoHasNoIntegrationFields(t *testing.T) {
	b, err := json.Marshal(protocol.SessionInfo{SID: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"integration", "prompt_state", "unmarked_input"} {
		if bytes.Contains(b, []byte(`"`+k+`"`)) {
			t.Errorf("SessionInfo 里还有 %s", k)
		}
	}
}

// session.move 的 before 为 null 时照样写出来（协议 §4.1）；session.order 只有
// 发起方的副本带 req_id，其余连接的副本里不能出现这个字段（ADR-0040）。
func TestSessionMoveAndOrderShape(t *testing.T) {
	b, err := protocol.Encode(&protocol.SessionMove{ReqID: "r5", SID: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"before":null`)) {
		t.Errorf("before 为 null 时没写出来: %s", b)
	}

	b, err = protocol.Encode(&protocol.SessionOrder{SIDs: []uint16{3, 1, 2}})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["req_id"]; ok || len(m) != 2 { // t, sids
		t.Errorf("广播副本 = %s, want 只有 t 与 sids", b)
	}
	if !bytes.Contains(b, []byte(`"sids":[3,1,2]`)) {
		t.Errorf("sids 不是数字数组: %s", b)
	}
}
