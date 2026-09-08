package main

import (
	"strings"
	"testing"
	"time"
)

// 裸跑 webterm 要一眼看到"现在正常吗"。渲染是纯函数，好把各种状态都钉住。
func TestRenderStatus(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		st   status
		want []string
		deny []string
	}{
		{
			"一切正常",
			status{
				running: true, runningVia: "systemd",
				url:    "https://term.example.com:8443",
				certOK: true, certExpiry: now.AddDate(0, 0, 89),
				devices: 2, configPath: "/home/u/.config/webterm/config",
			},
			[]string{"运行中", "systemd", "https://term.example.com:8443",
				"2026-12-06", "89 天", "2 台", "webterm pair"},
			nil,
		},
		{
			// 最常见的第一次：服务起来了但还没配对
			"还没有授权设备 → 指出下一步",
			status{running: true, url: "https://x.example.com", certOK: true,
				certExpiry: now.AddDate(0, 0, 89), devices: 0},
			[]string{"还没有授权设备", "webterm pair"},
			nil,
		},
		{
			"服务没在跑",
			status{running: false, url: "https://x.example.com"},
			[]string{"未运行", "webterm serve"},
			nil,
		},
		{
			"证书还没申请下来",
			status{running: true, url: "https://x.example.com", certOK: false},
			[]string{"还没有证书"},
			[]string{"到期"},
		},
		{
			// 到期在即要显眼 —— 这是唯一会静默变成事故的东西
			"证书快到期了",
			status{running: true, url: "https://x.example.com", certOK: true,
				certExpiry: now.AddDate(0, 0, 5), devices: 1},
			[]string{"5 天", "续期"},
			nil,
		},
		{
			"已经过期",
			status{running: true, url: "https://x.example.com", certOK: true,
				certExpiry: now.AddDate(0, 0, -1), devices: 1},
			[]string{"已过期"},
			nil,
		},
		{
			"还没配域名（连 --dev 都没跑过）",
			status{running: false},
			[]string{"还没配域名", "install.sh"},
			nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := renderStatus(tc.st, "v0.1.0", now)
			for _, w := range tc.want {
				if !strings.Contains(got, w) {
					t.Errorf("缺 %q：\n%s", w, got)
				}
			}
			for _, d := range tc.deny {
				if strings.Contains(got, d) {
					t.Errorf("不该出现 %q：\n%s", d, got)
				}
			}
			// 命令清单永远要在
			if !strings.Contains(got, "webterm doctor") {
				t.Errorf("命令清单丢了：\n%s", got)
			}
		})
	}
}

// 剩余天数按自然日算，别出现 "-0 天" 这种。
func TestDaysLeft(t *testing.T) {
	now := time.Date(2026, 9, 8, 23, 30, 0, 0, time.UTC)
	cases := []struct {
		expiry time.Time
		want   int
	}{
		{now.Add(30 * time.Minute), 0}, // 半小时后到期 → 今天
		{now.Add(25 * time.Hour), 1},
		{now.AddDate(0, 0, 89), 89},
		{now.Add(-time.Hour), -1}, // 已过期
	}
	for _, tc := range cases {
		if got := daysLeft(tc.expiry, now); got != tc.want {
			t.Errorf("daysLeft(+%v) = %d, 想要 %d", tc.expiry.Sub(now), got, tc.want)
		}
	}
}
