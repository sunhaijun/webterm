package main

import (
	"os"
	"os/exec"
	"os/user"
	"strings"
	"testing"
)

// UT-install-unit（ADR-0034）：install.sh --print-unit 打印将要写入的系统单元，
// 不联网、不需要 sudo。断言的都是踩了就出事的行：漏了 OOM 两行等于没迁；
// uid 写成 %U 会变成 0（PID 1 的 UID），会话里的 systemctl --user 全挂。
func TestInstallScriptPrintUnit(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("install.sh 拒绝以 root 运行")
	}
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	g, err := user.LookupGroupId(u.Gid)
	if err != nil {
		t.Fatal(err)
	}

	out, err := exec.Command("bash", "../../scripts/install.sh", "--print-unit",
		"--domain", "term.example.com", "--https-port", "8443").CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh --print-unit: %v\n%s", err, out)
	}
	unit := string(out)

	// 只看生效的行：注释里会提到 %U（解释为什么不能用它）
	lines := map[string]bool{}
	var body strings.Builder
	for _, l := range strings.Split(unit, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "#") {
			continue
		}
		lines[l] = true
		body.WriteString(l + "\n")
	}
	for _, want := range []string{
		"[Service]",
		"User=" + u.Username,
		"Group=" + g.Name,
		"ExecStart=/usr/local/bin/webterm serve --domain term.example.com --https-port 8443",
		"OOMScoreAdjust=-900",
		"OOMPolicy=continue",
		"Environment=XDG_RUNTIME_DIR=/run/user/" + u.Uid,
		"Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + u.Uid + "/bus",
		"Wants=network-online.target user@" + u.Uid + ".service",
		"After=network-online.target user@" + u.Uid + ".service",
		"ExecReload=/bin/kill -USR2 $MAINPID",
		"KillMode=mixed",
		"WantedBy=multi-user.target",
	} {
		if !lines[want] {
			t.Errorf("单元里缺这一行：%s", want)
		}
	}
	for _, bad := range []string{"%U", "%u", "default.target"} {
		if strings.Contains(body.String(), bad) {
			t.Errorf("单元里不该出现 %q", bad)
		}
	}
	// 只打印单元：不能混进安装步骤的输出
	if strings.Contains(unit, "检查环境") || strings.Contains(unit, "下载") {
		t.Errorf("--print-unit 跑了安装步骤：\n%s", unit)
	}
}
