package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

// UT-pair-wait：探针成功前不往下走；超时提示看日志并照常返回（ADR-0043 §6）。
func TestWaitCertReady(t *testing.T) {
	var out bytes.Buffer
	n := 0
	ok := waitCertReady(&out, time.Second, time.Millisecond, func() error {
		n++
		if n < 3 {
			return errors.New("x509: certificate signed by unknown authority")
		}
		return nil
	})
	if !ok || n != 3 {
		t.Fatalf("ok=%v n=%d：应当探到第 3 次成功才返回", ok, n)
	}
	if !strings.Contains(out.String(), "等正式证书") {
		t.Errorf("等待时没说在等什么: %q", out.String())
	}

	out.Reset()
	ok = waitCertReady(&out, 20*time.Millisecond, 5*time.Millisecond, func() error { return errors.New("connection refused") })
	if ok {
		t.Fatal("一直失败却报成功")
	}
	for _, want := range []string{"还没拿到受信任的证书", "connection refused", "journalctl -u webterm"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("超时提示缺 %q: %q", want, out.String())
		}
	}

	out.Reset()
	if !waitCertReady(&out, time.Second, time.Millisecond, func() error { return nil }) || out.Len() != 0 {
		t.Errorf("一上来就好了就不该打印任何东西: %q", out.String())
	}
}
