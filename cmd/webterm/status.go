package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/store"
)

// Running webterm with no arguments prints a status overview.
//
// The everyday question is "is it working?". Without the overview, answering it
// means piecing together systemctl, the certificate state in journalctl, and
// webterm devices.
//
// There is deliberately no interactive menu: pairing and revoking are rare and
// have their own commands, and a TUI would add dependencies, against the
// single-binary goal.

// status holds everything the overview shows. Collecting and rendering are
// separate so rendering can be tested as a pure function.
type status struct {
	running    bool
	runningVia string   // "systemd" or ""; shows how "running" was determined
	unit       unitKind // installed systemd unit: picks the commands in hints and whether to suggest migrating
	url        string
	certOK     bool
	certStart  time.Time // NotBefore; the "expiring soon" threshold scales with validity (ADR-0044 §4)
	certExpiry time.Time
	ipMode     bool // IP certificates renew over HTTP-01 only, so port 80 must stay reachable
	devices    int
	configPath string
}

func runStatus() error {
	fmt.Print(renderStatus(collectStatus(), version, time.Now(), colorEnabled(os.Stdout)))
	return nil
}

// colorEnabled reports whether to use ANSI colors.
//
// Only when writing to a terminal: `webterm > status.log` or a pipe should not
// end up with \033[33m in it. It also honors NO_COLOR (per no-color.org, any
// value, even empty, disables color) and TERM=dumb.
func colorEnabled(f *os.File) bool {
	if _, ok := os.LookupEnv("NO_COLOR"); ok {
		return false
	}
	if os.Getenv("TERM") == "dumb" {
		return false
	}
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// collectStatus is best effort: anything it cannot read is left empty instead
// of failing the whole overview.
func collectStatus() status {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var c commonFlags
	c.register(fs)
	httpsPort := fs.Int("https-port", 443, "")
	httpPort := fs.Int("http-port", 80, "")
	cfgPath := registerConfigFlag(fs, nil)
	_ = loadConfigInto(fs, cfgPath)
	_ = fs.Parse(nil)

	st := status{}
	if _, err := os.Stat(cfgPath); err == nil {
		st.configPath = cfgPath
	}
	if c.domain != "" {
		st.url = agent.ExternalURL(c.domain, *httpsPort)
	}

	st.unit = detectUnit()
	st.running, st.runningVia = probeRunning(st.unit, c.domain, *httpPort, *httpsPort)

	if c.domain != "" {
		st.ipMode = agent.IsIPAddress(c.domain)
		if leaf, ok := certFromCache(agent.CertDirDefault(c.dataDir), c.domain); ok {
			st.certOK, st.certStart, st.certExpiry = true, leaf.NotBefore, leaf.NotAfter
		}
	}
	if db, err := store.Open(c.dataDir); err == nil {
		if list, err := db.ListDevices(); err == nil {
			st.devices = len(list)
		}
		db.Close()
	}
	return st
}

// probeRunning reports whether the service is running.
//
// systemd is asked first: installed deployments always have a unit (a system
// service since ADR-0034, a user service before), and it gives the most
// reliable answer.
//
// If the unit is not active, or there is none, it falls back to probing
// /healthz, so a manual webterm serve counts too. A listening port is not
// enough: 443 may belong to another service entirely (it once turned out to be
// Xray), whereas a /healthz body of "ok" is specific to webterm.
func probeRunning(unit unitKind, domain string, httpPort, httpsPort int) (bool, string) {
	if unit.active() {
		return true, "systemd"
	}
	// Production: the HTTPS port serves the full router (:80 only has ACME
	// challenges and redirects).
	//
	// SNI is required. autocert's HostPolicy accepts only the --domain name, so
	// a connection to the IP without SNI gets no certificate and the handshake
	// fails. That is a server-side refusal InsecureSkipVerify cannot fix, and
	// the probe would report a healthy service as not running.
	//
	// Verification is still skipped: an expired certificate or an incomplete
	// chain should not change whether the service counts as running.
	if domain != "" && healthzOK("https://127.0.0.1:"+strconv.Itoa(httpsPort)+"/healthz", domain) {
		return true, ""
	}
	// --dev / --no-tls: plain HTTP on the HTTP port.
	if healthzOK("http://127.0.0.1:"+strconv.Itoa(httpPort)+"/healthz", "") {
		return true, ""
	}
	return false, ""
}

// healthzOK probes /healthz once. A non-empty sni is sent as the TLS server
// name, and certificate verification is skipped.
func healthzOK(url, sni string) bool {
	c := &http.Client{
		Timeout: time.Second,
		// Never follow redirects. :80 only has ACME challenges and redirects,
		// and following one lets another host answer "is this machine
		// running?", the very false positive this probe exists to prevent (the
		// first version probed the port and mistook Xray on 443 for webterm).
		// The redirect target is also the public domain, so following it leaves
		// the machine and comes back, which breaks with --bind 127.0.0.1,
		// without NAT hairpinning, or when DNS is down.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if sni != "" {
		c.Transport = &http.Transport{TLSClientConfig: &tls.Config{
			ServerName:         sni,
			InsecureSkipVerify: true, //nolint:gosec // liveness probe only; no data is sent
		}}
	}
	resp, err := c.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	return err == nil && strings.TrimSpace(string(body)) == "ok"
}

// certFromCache reads the leaf certificate from the certificate cache (the
// IP-mode cache uses the same format as autocert).
//
// The cache is PEM: the private key, then the chain. Only the first
// CERTIFICATE block (the leaf) is used. Nothing is verified; this is for
// display only, and validity is enforced by autocert / ipCertManager.
func certFromCache(certDir, domain string) (*x509.Certificate, bool) {
	raw, err := os.ReadFile(filepath.Join(certDir, domain))
	if err != nil {
		return nil, false
	}
	for rest := raw; len(rest) > 0; {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if blk.Type != "CERTIFICATE" {
			continue
		}
		leaf, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return nil, false
		}
		return leaf, true
	}
	return nil, false
}

// certWarnThreshold is the "expiring soon" (yellow) threshold:
// min(10 days, validity/4) (ADR-0044 §4).
//
// A fixed 10 days would flag a 6-day IP certificate the moment it is issued.
// Scaled, a 90-day certificate still gets 10 days and a 160-hour IP certificate
// gets 40 hours: it should have renewed with 53 hours left, so still being
// unrenewed at 40 means renewal is actually failing. Without NotBefore the
// threshold is 10 days.
func certWarnThreshold(start, expiry time.Time) time.Duration {
	th := 10 * 24 * time.Hour
	if !start.IsZero() {
		if q := expiry.Sub(start) / 4; q < th {
			th = q
		}
	}
	return th
}

// remaining formats the time left: in days from two days up, in hours below.
func remaining(expiry, now time.Time) string {
	if d := expiry.Sub(now); d < 48*time.Hour {
		return plural(int(d/time.Hour), "hour")
	}
	return plural(daysLeft(expiry, now), "day")
}

// plural formats a count with an English noun: "1 day", "2 days".
func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return strconv.Itoa(n) + " " + noun + "s"
}

// daysLeft returns the number of whole days left; negative once expired.
func daysLeft(expiry, now time.Time) int {
	d := expiry.Sub(now)
	if d < 0 {
		return int(d/(24*time.Hour)) - 1
	}
	return int(d / (24 * time.Hour))
}

func renderStatus(st status, ver string, now time.Time, color bool) string {
	// Color is emphasis only: without it, words like "Expired" and
	// "Only N days left" still say everything.
	paint := func(code, s string) string {
		if !color {
			return s
		}
		return "\033[" + code + "m" + s + "\033[0m"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "webterm %s\n\n", ver)

	row := func(k, v string) { fmt.Fprintf(&b, "  %-11s  %s\n", k, v) }

	switch {
	case st.running && st.runningVia != "" && st.unit == unitUser:
		row("Service", "Running (systemd user service; killed before your login session when memory runs low)")
	case st.running && st.runningVia != "":
		row("Service", "Running (systemd)")
	case st.running:
		row("Service", "Running")
	default:
		row("Service", "Not running")
	}

	if st.url != "" {
		row("URL", st.url)
	} else {
		row("URL", "Not configured. Install with webterm install (uses this machine's public IP without --domain), or try it locally with webterm serve --dev")
	}

	switch {
	case !st.certOK && st.url != "":
		row("Certificate", "Not issued yet (requested automatically when the service starts)")
	case st.certOK:
		date := st.certExpiry.Local().Format("2006-01-02")
		if !st.certStart.IsZero() && st.certExpiry.Sub(st.certStart) < 10*24*time.Hour {
			date = st.certExpiry.Local().Format("2006-01-02 15:04") // a date alone is too coarse for a 6-day certificate
		}
		reach := "port 80 or 443"
		if st.ipMode {
			reach = "port 80"
		}
		switch left := st.certExpiry.Sub(now); {
		case left < 0:
			row("Certificate", fmt.Sprintf("%s (%s); restart the service to request a new one", paint("31", "Expired"), date))
		case left < certWarnThreshold(st.certStart, st.certExpiry):
			// Expiry is the one thing that silently turns into an outage, so be
			// explicit when time is short.
			row("Certificate", fmt.Sprintf("%s (%s); renewal needs %s reachable from the internet. Check journalctl -u webterm",
				paint("33", "Only "+remaining(st.certExpiry, now)+" left"), date, reach))
		default:
			row("Certificate", fmt.Sprintf("Valid until %s (%s left, renews automatically)", date, remaining(st.certExpiry, now)))
		}
	}

	if st.devices == 0 {
		row("Devices", "None authorized yet")
	} else {
		row("Devices", fmt.Sprintf("%d authorized", st.devices))
	}
	if st.configPath != "" {
		row("Config", st.configPath)
	}

	type hint struct{ cmd, what string }
	var hints []hint
	if !st.running {
		if st.unit == unitNone {
			hints = append(hints, hint{"webterm serve", "Start the service"})
		} else {
			hints = append(hints, hint{st.unit.ctl("start"), "Start the service"})
		}
	}
	if st.unit == unitUser {
		// ADR-0034: migrating closes every session once, so only suggest it.
		hints = append(hints, hint{"webterm update --force-restart", "Migrate to a system service (closes all sessions once; run it over SSH)"})
	}
	if st.devices == 0 {
		hints = append(hints, hint{"webterm pair", "Get a pairing code and QR code to authorize your phone  ← next step"})
	} else {
		hints = append(hints, hint{"webterm pair", "Get a pairing code and QR code"})
	}
	hints = append(hints,
		hint{"webterm devices", "List or revoke authorized devices"},
		hint{"webterm doctor", "Check deployment prerequisites"},
	)
	width := 0
	for _, h := range hints {
		width = max(width, len(h.cmd))
	}
	b.WriteString("\n")
	for _, h := range hints {
		fmt.Fprintf(&b, "  %-*s  %s\n", width, h.cmd, h.what)
	}
	b.WriteString("\nRun \"webterm <command> --help\" for options.\n")
	return b.String()
}
