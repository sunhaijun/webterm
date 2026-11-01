package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
	"time"
)

// UT-pair-wait: block until the probe succeeds; on timeout, point to the logs
// and return anyway (ADR-0045 §6).
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
		t.Fatalf("ok=%v n=%d: should return after the 3rd probe succeeds", ok, n)
	}
	if !strings.Contains(out.String(), "Waiting for the certificate") {
		t.Errorf("does not say what it is waiting for: %q", out.String())
	}

	out.Reset()
	ok = waitCertReady(&out, 20*time.Millisecond, 5*time.Millisecond, func() error { return errors.New("connection refused") })
	if ok {
		t.Fatal("reported success although every probe failed")
	}
	for _, want := range []string{"no trusted certificate", "connection refused", "journalctl -u webterm"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("timeout message is missing %q: %q", want, out.String())
		}
	}

	out.Reset()
	if !waitCertReady(&out, time.Second, time.Millisecond, func() error { return nil }) || out.Len() != 0 {
		t.Errorf("should print nothing when the first probe succeeds: %q", out.String())
	}
}
