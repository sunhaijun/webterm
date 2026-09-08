package main

import (
	"errors"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
)

// 没有绑定权限 ≠ 端口被占。混在一起会让全新安装被自己的自检拦住：
// install.sh 的自检跑的是还没 setcap 的临时二进制，80 上必然 EACCES。
func TestClassifyPortErr(t *testing.T) {
	eacces := &net.OpError{Op: "listen", Err: os.NewSyscallError("bind", syscall.EACCES)}
	eaddrinuse := &net.OpError{Op: "listen", Err: os.NewSyscallError("bind", syscall.EADDRINUSE)}

	free := func(int) bool { return false }
	taken := func(int) bool { return true }

	t.Run("没权限但端口空着 → 只提醒，不拦", func(t *testing.T) {
		_, err := classifyPortErr(80, eacces, free)
		var w warning
		if !errors.As(err, &w) {
			t.Fatalf("该是 warning，得到 %T: %v", err, err)
		}
		for _, want := range []string{"setcap", "install.sh 装完"} {
			if !strings.Contains(w.msg, want) {
				t.Errorf("提醒里缺 %q：%s", want, w.msg)
			}
		}
	})

	t.Run("没权限且端口有人听 → 真失败", func(t *testing.T) {
		_, err := classifyPortErr(80, eacces, taken)
		var w warning
		if errors.As(err, &w) {
			t.Fatal("端口被占着不该只提醒")
		}
		if err == nil || !strings.Contains(err.Error(), "被占用") {
			t.Errorf("该报被占用，得到 %v", err)
		}
	})

	t.Run("端口已被占（EADDRINUSE）→ 真失败，不去探测", func(t *testing.T) {
		// busy 传 free，确认 EADDRINUSE 不经过探测就直接判失败
		_, err := classifyPortErr(8443, eaddrinuse, free)
		var w warning
		if errors.As(err, &w) {
			t.Fatal("EADDRINUSE 不该是 warning")
		}
		if err == nil || !strings.Contains(err.Error(), "被占用") {
			t.Errorf("该报被占用，得到 %v", err)
		}
	})
}

// portBusy 得真的能分辨"有人听"和"没人听"。
func TestPortBusy(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if !portBusy(port) {
		t.Errorf("端口 %d 上正听着，却报没人", port)
	}
	ln.Close()
	if portBusy(port) {
		t.Errorf("端口 %d 已经关了，却报有人听", port)
	}
}
