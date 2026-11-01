package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
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

// runDoctorCapture 跑一次 doctor，把输出收进字符串；公网 IP 与实签都换成假的。
func runDoctorCapture(t *testing.T, public string, issue func(context.Context, agent.ServeConfig) (*x509.Certificate, error), args ...string) (string, error) {
	t.Helper()
	var buf bytes.Buffer
	oldOut, oldIP, oldIssue := doctorOut, lookupPublicIP, issueCheck
	t.Cleanup(func() { doctorOut, lookupPublicIP, issueCheck = oldOut, oldIP, oldIssue })
	doctorOut = &buf
	lookupPublicIP = func() (string, error) { return public, nil }
	if issue != nil {
		issueCheck = issue
	}
	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // 不读开发机上真的配置文件
	ports := freeTCPPorts(t, 2)
	base := []string{"--data-dir", t.TempDir(),
		"--http-port", strconv.Itoa(ports[0]), "--https-port", strconv.Itoa(ports[1])}
	err := runDoctor(append(base, args...))
	return buf.String(), err
}

func freeTCPPorts(t *testing.T, n int) []int {
	t.Helper()
	var lns []net.Listener
	defer func() {
		for _, l := range lns {
			l.Close()
		}
	}()
	var ports []int
	for range n {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		lns = append(lns, l)
		ports = append(ports, l.Addr().(*net.TCPAddr).Port)
	}
	return ports
}

// UT-doctor-ip：IP 模式不查 DNS，查「--domain == 本机公网 IP」。
func TestDoctorIPMode(t *testing.T) {
	out, err := runDoctorCapture(t, "203.0.113.7", nil, "--domain", "203.0.113.7")
	if err != nil {
		t.Fatalf("IP 对得上时不该失败: %v\n%s", err, out)
	}
	if strings.Contains(out, "DNS") {
		t.Errorf("IP 模式不该查 DNS:\n%s", out)
	}
	if !strings.Contains(out, "✓ 公网 IP") {
		t.Errorf("缺「公网 IP」这一项:\n%s", out)
	}

	out, err = runDoctorCapture(t, "198.51.100.9", nil, "--domain", "203.0.113.7")
	if err == nil {
		t.Fatalf("公网 IP 不一致时应当失败:\n%s", out)
	}
	for _, want := range []string{"198.51.100.9", "不等于", "重新配对", "NAT"} {
		if !strings.Contains(out, want) {
			t.Errorf("不一致时的说明缺 %q:\n%s", want, out)
		}
	}
}

func TestDoctorRejectsIPv6(t *testing.T) {
	out, err := runDoctorCapture(t, "", nil, "--domain", "2001:db8::1")
	if err == nil || !strings.Contains(out, "IPv4") {
		t.Fatalf("IPv6 应当被拒并说明，err=%v\n%s", err, out)
	}
}

// --acme：静态检查都过了才实签；实签的结果是一项检查；不带 --acme 时提示安全组查不出来。
func TestDoctorACME(t *testing.T) {
	var called agent.ServeConfig
	ok := func(_ context.Context, cfg agent.ServeConfig) (*x509.Certificate, error) {
		called = cfg
		return &x509.Certificate{NotAfter: time.Now().Add(160 * time.Hour)}, nil
	}
	out, err := runDoctorCapture(t, "203.0.113.7", ok, "--domain", "203.0.113.7", "--acme")
	if err != nil {
		t.Fatalf("实签成功却失败了: %v\n%s", err, out)
	}
	if !called.ACMEStaging {
		t.Error("doctor --acme 必须走 staging —— 正式环境的限额不该花在自检上")
	}
	if called.CertDir == "" || strings.HasSuffix(called.CertDir, "/certs") {
		t.Errorf("实签的证书目录 = %q，应当是临时目录，不碰 certs/", called.CertDir)
	}
	if _, statErr := os.Stat(called.CertDir); !os.IsNotExist(statErr) {
		t.Errorf("临时证书目录 %s 用完没删", called.CertDir)
	}
	if !strings.Contains(out, "✓ 证书实签") {
		t.Errorf("缺实签那一项:\n%s", out)
	}

	fail := func(context.Context, agent.ServeConfig) (*x509.Certificate, error) {
		return nil, errors.New("CA 没能连上 http://203.0.113.7/ 做验证 …… 安全组")
	}
	out, err = runDoctorCapture(t, "203.0.113.7", fail, "--domain", "203.0.113.7", "--acme")
	if err == nil || !strings.Contains(out, "✗ 证书实签") || !strings.Contains(out, "安全组") {
		t.Fatalf("实签失败应当是一项 ✗ 并带诊断，err=%v\n%s", err, out)
	}

	// 静态检查有 ✗ 时不去找 CA
	called = agent.ServeConfig{}
	out, _ = runDoctorCapture(t, "198.51.100.9", ok, "--domain", "203.0.113.7", "--acme")
	if called.Domain != "" || !strings.Contains(out, "跳过") {
		t.Errorf("静态检查失败时不该实签:\n%s", out)
	}

	out, _ = runDoctorCapture(t, "203.0.113.7", nil, "--domain", "203.0.113.7")
	if !strings.Contains(out, "--acme") || !strings.Contains(out, "安全组") {
		t.Errorf("不带 --acme 时应当提示安全组只有实签才查得出来:\n%s", out)
	}
}
