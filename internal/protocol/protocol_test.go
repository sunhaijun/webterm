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
			// seq is a string in the fixture: it is a uint64, and values
			// above 2^53 do not survive JSON.parse on the JS side.
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

// The vectors are shared with the frontend so the two implementations cannot
// drift (protocol §9).
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
				t.Fatalf("fixture seq is not a valid uint64: %v", err)
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
			// Round trip: re-encoding must reproduce the exact bytes.
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

// Control messages: decode, re-encode, and compare semantically (field order
// does not matter).
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
					t.Errorf("field %q lost in round trip", k)
					continue
				}
				if !reflect.DeepEqual(gv, wv) {
					t.Errorf("field %q = %#v, want %#v", k, gv, wv)
				}
			}
		})
	}
}

// An unknown t must surface as ErrUnknownType so callers ignore it instead of
// closing the connection (protocol §4).
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

// Frame round trips for edge cases the vectors do not cover.
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

// Snapshot bytes do not count toward seq (protocol §3): OUTPUT DataLen is the
// payload length, SNAPSHOT DataLen is 0.
func TestSnapshotNotCountedInSeq(t *testing.T) {
	out := protocol.Frame{Type: protocol.TypeOutput, SID: 1, Seq: 1000, Payload: []byte("hello")}
	if out.DataLen() != 5 {
		t.Fatalf("OUTPUT DataLen = %d, want 5", out.DataLen())
	}
	snap := protocol.Frame{Type: protocol.TypeSnapshot, SID: 1, Seq: 1000, Payload: []byte("\x1b[H\x1b[2Jxx")}
	if snap.DataLen() != 0 {
		t.Fatalf("SNAPSHOT DataLen = %d, want 0: a snapshot is a render instruction, not stream content", snap.DataLen())
	}
}

// Clients may send only INPUT (protocol §3).
func TestFrameDirection(t *testing.T) {
	for typ, want := range map[uint8]bool{
		protocol.TypeInput: true, protocol.TypeOutput: false, protocol.TypeSnapshot: false,
	} {
		if got := (protocol.Frame{Type: typ}).FromClient(); got != want {
			t.Errorf("type %#x FromClient = %v, want %v", typ, got, want)
		}
	}
}

// Snapshot framing (protocol §3): a snapshot larger than one frame is split;
// all frames share seq, all but the last carry MORE, and the payloads join back
// into the original.
func TestSnapshotFrames(t *testing.T) {
	if fs := protocol.SnapshotFrames(1, 7, nil); fs != nil {
		t.Fatalf("empty snapshot should yield no frames (zero-length payloads are invalid), got %d", len(fs))
	}
	for _, n := range []int{1, protocol.MaxPayload - 1, protocol.MaxPayload, protocol.MaxPayload + 1, 2*protocol.MaxPayload + 17} {
		data := make([]byte, n)
		for i := range data {
			data[i] = byte(i * 7)
		}
		fs := protocol.SnapshotFrames(3, 99, data)
		want := (n + protocol.MaxPayload - 1) / protocol.MaxPayload
		if len(fs) != want {
			t.Fatalf("n=%d: %d frames, want %d", n, len(fs), want)
		}
		var joined []byte
		for i, f := range fs {
			if f.Type != protocol.TypeSnapshot || f.SID != 3 || f.Seq != 99 {
				t.Fatalf("n=%d frame %d: bad header %+v", n, i, f)
			}
			if len(f.Payload) == 0 || len(f.Payload) > protocol.MaxPayload {
				t.Fatalf("n=%d frame %d: payload is %d bytes", n, i, len(f.Payload))
			}
			last := i == len(fs)-1
			if f.More() == last {
				t.Fatalf("n=%d frame %d: MORE=%v, only the last frame should clear it", n, i, f.More())
			}
			// The encoded frame must decode.
			if _, err := protocol.DecodeFrame(protocol.EncodeFrame(f)); err != nil {
				t.Fatalf("n=%d frame %d: %v", n, i, err)
			}
			joined = append(joined, f.Payload...)
		}
		if !bytes.Equal(joined, data) {
			t.Fatalf("n=%d: joined payloads differ from the snapshot", n)
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

// session.updated carries only changed fields; unset fields must not appear
// in the JSON.
func TestSessionUpdatedOmitsUnchangedFields(t *testing.T) {
	head := uint64(491337)
	b, err := protocol.Encode(&protocol.SessionUpdated{SID: 2, HeadSeq: &head})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if len(m) != 3 { // t, sid, head_seq
		t.Fatalf("field count = %d (%v), want 3", len(m), m)
	}
}

// Messages removed in v2 (reset / redraw / cwd / prompt / command.*) must be
// ignored as unknown types. The forward-compatibility rule also covers
// messages a peer still sends but this side no longer knows.
func TestRemovedMessagesAreUnknown(t *testing.T) {
	for _, typ := range []string{"reset", "redraw", "cwd", "prompt", "command.start", "command.end"} {
		_, err := protocol.Decode([]byte(`{"t":"` + typ + `","sid":1}`))
		var unknown *protocol.ErrUnknownType
		if !asErr(err, &unknown) {
			t.Errorf("%s: err = %v, want *ErrUnknownType", typ, err)
		}
	}
}

// SessionInfo no longer has shell-integration fields (protocol v2).
func TestSessionInfoHasNoIntegrationFields(t *testing.T) {
	b, err := json.Marshal(protocol.SessionInfo{SID: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"integration", "prompt_state", "unmarked_input"} {
		if bytes.Contains(b, []byte(`"`+k+`"`)) {
			t.Errorf("SessionInfo still has %s", k)
		}
	}
}

// session.move writes before even when it is null (protocol §4.1). Only the
// requester's copy of session.order carries req_id; copies for other
// connections must omit it (ADR-0040).
func TestSessionMoveAndOrderShape(t *testing.T) {
	b, err := protocol.Encode(&protocol.SessionMove{ReqID: "r5", SID: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte(`"before":null`)) {
		t.Errorf("null before was not written: %s", b)
	}

	b, err = protocol.Encode(&protocol.SessionOrder{SIDs: []uint16{3, 1, 2}})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if _, ok := m["req_id"]; ok || len(m) != 2 { // t, sids
		t.Errorf("broadcast copy = %s, want only t and sids", b)
	}
	if !bytes.Contains(b, []byte(`"sids":[3,1,2]`)) {
		t.Errorf("sids is not a number array: %s", b)
	}
}
