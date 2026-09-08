package main

import (
	"flag"
	"fmt"
	"os"
	"text/tabwriter"
	"time"

	"github.com/sunhaijun/webterm/internal/store"
)

func runDevices(args []string) error {
	fs := flag.NewFlagSet("devices", flag.ExitOnError)
	var c commonFlags
	c.register(fs)
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, err := store.Open(c.dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	sub := "list"
	if fs.NArg() > 0 {
		sub = fs.Arg(0)
	}
	switch sub {
	case "list":
		devs, err := st.ListDevices()
		if err != nil {
			return err
		}
		if len(devs) == 0 {
			fmt.Println("没有已授权的设备。跑 webterm pair 生成配对码。")
			return nil
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\t名字\t最后活动\t最后 IP")
		for _, d := range devs {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", d.ID[:8], d.Name,
				time.UnixMilli(d.LastSeenAt).Format("2006-01-02 15:04"), d.LastIP)
		}
		return w.Flush()

	case "revoke":
		if fs.NArg() < 2 {
			return fmt.Errorf("用法: webterm devices revoke <id>")
		}
		id, err := resolveDeviceID(st, fs.Arg(1))
		if err != nil {
			return err
		}
		if err := st.RevokeDevice(id, time.Now()); err != nil {
			return err
		}
		fmt.Printf("设备 %s 已吊销。它的 WebSocket 会在 5 秒内断开。\n", id[:8])
		return nil

	case "revoke-all":
		n, err := st.RevokeAllDevices(time.Now())
		if err != nil {
			return err
		}
		fmt.Printf("已吊销全部 %d 台设备。所有设备都需要重新配对。\n", n)
		return nil
	}
	return fmt.Errorf("未知子命令 %q，可用：list | revoke <id> | revoke-all", sub)
}

// resolveDeviceID 支持用 id 前缀（列表里显示的就是前 8 位）。
func resolveDeviceID(st *store.Store, prefix string) (string, error) {
	devs, err := st.ListDevices()
	if err != nil {
		return "", err
	}
	var hits []string
	for _, d := range devs {
		if len(d.ID) >= len(prefix) && d.ID[:len(prefix)] == prefix {
			hits = append(hits, d.ID)
		}
	}
	switch len(hits) {
	case 0:
		return "", fmt.Errorf("没有匹配 %q 的设备", prefix)
	case 1:
		return hits[0], nil
	default:
		return "", fmt.Errorf("%q 匹配到 %d 台设备，请给出更长的前缀", prefix, len(hits))
	}
}
