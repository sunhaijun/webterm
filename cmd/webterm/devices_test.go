package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/sunhaijun/webterm/internal/store"
)

// UT-devices-via: a device paired from another machine's page shows that
// page's address (AC-10.2); one paired here shows nothing extra.
func TestWriteDevicesVia(t *testing.T) {
	var buf bytes.Buffer
	err := writeDevices(&buf, []store.Device{
		{ID: "aaaaaaaa11", Name: "iPhone · Safari", LastSeenAt: 1, LastIP: "1.2.3.4", Origin: "https://tokyo.example.com:8443"},
		{ID: "bbbbbbbb22", Name: "Mac · Chrome", LastSeenAt: 1, LastIP: "1.2.3.5"},
	})
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("output:\n%s", buf.String())
	}
	if !strings.HasSuffix(lines[1], "via tokyo.example.com:8443") || !strings.HasPrefix(lines[1], "aaaaaaaa") {
		t.Errorf("bound device line = %q", lines[1])
	}
	if strings.Contains(lines[2], "via") || !strings.HasSuffix(lines[2], "1.2.3.5") {
		t.Errorf("own device line = %q", lines[2])
	}
}
