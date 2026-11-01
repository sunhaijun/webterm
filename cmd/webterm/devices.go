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
			fmt.Println("No authorized devices. Run webterm pair to create a pairing code.")
			return nil
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "ID\tNAME\tLAST SEEN\tLAST IP")
		for _, d := range devs {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", d.ID[:8], d.Name,
				time.UnixMilli(d.LastSeenAt).Format("2006-01-02 15:04"), d.LastIP)
		}
		return w.Flush()

	case "revoke":
		if fs.NArg() < 2 {
			return fmt.Errorf("usage: webterm devices revoke <id>")
		}
		id, err := resolveDeviceID(st, fs.Arg(1))
		if err != nil {
			return err
		}
		if err := st.RevokeDevice(id, time.Now()); err != nil {
			return err
		}
		fmt.Printf("Revoked device %s. Its WebSocket connections close within 5 seconds.\n", id[:8])
		return nil

	case "revoke-all":
		n, err := st.RevokeAllDevices(time.Now())
		if err != nil {
			return err
		}
		fmt.Printf("Revoked %s. Every device must pair again.\n", plural(int(n), "device"))
		return nil
	}
	return fmt.Errorf("unknown command %q; available: list | revoke <id> | revoke-all", sub)
}

// resolveDeviceID accepts an ID prefix; the list shows the first 8 characters.
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
		return "", fmt.Errorf("no device matches %q", prefix)
	case 1:
		return hits[0], nil
	default:
		return "", fmt.Errorf("%q matches %d devices; use a longer prefix", prefix, len(hits))
	}
}
