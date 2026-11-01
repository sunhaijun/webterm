package main

import (
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/store"
)

func runPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	var c commonFlags
	c.register(fs)
	httpPort := fs.Int("http-port", 8080, "port under --dev (used to build the pairing URL)")
	// pair is a separate process and cannot know which port serve uses. If it
	// is not the default, pass the same value here; otherwise the URL lacks the
	// port and the scanned code does not open.
	httpsPort := fs.Int("https-port", 443, "HTTPS port (read from the config file by default)")
	wait := fs.Bool("wait", false, "wait until local HTTPS serves a trusted certificate before printing (up to 90s; used by the install script)")
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !c.dev && c.domain == "" {
		return fmt.Errorf("--domain is required to build the pairing URL (use --dev for local development)")
	}

	// Wait for the certificate before creating the code, so its 5 minutes start
	// when the link actually works (ADR-0045 §6).
	if *wait && !c.dev {
		waitCertReady(os.Stdout, 90*time.Second, time.Second, func() error {
			return probeTrustedHTTPS(c.domain, *httpsPort)
		})
	}

	// pair runs as a separate process sharing serve's SQLite database. WAL mode
	// supports multiple processes, and busy_timeout is set to 5 seconds.
	st, err := store.Open(c.dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	codes, err := auth.New(st, c.dev, false).NewPairingCodes(time.Now())
	if err != nil {
		return err
	}
	fmt.Println("Pairing code created. It is valid for 5 minutes:")
	printPairing(c.baseURL(*httpPort, *httpsPort), codes)
	return nil
}

// printPairing prints the pairing URL, a terminal QR code, and the 16-digit
// code for manual entry (ADR-0017).
//
// The code travels in the URL fragment, which is never sent to the server, so
// it stays out of access logs, Referer headers and proxies (AC-1.5 / threat
// model T2).
func printPairing(baseURL string, codes auth.Codes) {
	url := baseURL + "/pair#" + codes.URL
	fmt.Println()
	fmt.Println("  " + url)
	fmt.Println()
	// Typing 43 base64 characters on a phone is not acceptable. Scanning also
	// keeps the code off the clipboard and out of chat apps, where it would
	// stay in the history forever.
	if art, err := qrART(url); err == nil {
		fmt.Println(art)
	}
	fmt.Println("Scan the QR code with your phone to authorize it.")
	// Fallback when the QR code cannot be scanned (say, the terminal is on
	// another screen): 16 digits in 4-4-4-4 groups, easy to read and say.
	fmt.Println()
	fmt.Printf("Can't scan it? Open  %s/pair  in your phone's browser and enter:\n\n      %s\n\n", baseURL, auth.FormatDigits(codes.Digits))
}

// qrART renders url as a QR code drawn with half-block characters.
func qrART(url string) (string, error) {
	q, err := qrcode.New(url, qrcode.Medium)
	if err != nil {
		return "", err
	}
	q.DisableBorder = false
	return q.ToSmallString(false), nil
}

// waitCertReady calls probe every interval until it succeeds or timeout
// passes, and reports whether it succeeded.
//
// On a first install the service has just started and the certificate may
// still be in progress; without waiting, the scanned link shows a certificate
// error and looks like a broken install. On timeout it carries on anyway: the
// code is valid for 5 minutes, which leaves time for the certificate to arrive.
func waitCertReady(w io.Writer, timeout, interval time.Duration, probe func() error) bool {
	deadline := time.Now().Add(timeout)
	announced := false
	for {
		err := probe()
		if err == nil {
			return true
		}
		if time.Now().After(deadline) {
			fmt.Fprintf(w, "\n  ⚠ Local HTTPS has no trusted certificate after %d seconds (%v).\n"+
				"    Printing the pairing code anyway. If the link does not open, check: journalctl -u webterm -n 30\n\n",
				int(timeout/time.Second), err)
			return false
		}
		if !announced {
			fmt.Fprintln(w, "Waiting for the certificate to be issued...")
			announced = true
		}
		time.Sleep(interval)
	}
}

// probeTrustedHTTPS fetches /healthz from the local HTTPS port, verifying the
// certificate for domain against the system trust store.
//
// It connects to 127.0.0.1 rather than the public address because many cloud
// NATs do not hairpin: the machine cannot reach its own public IP. When
// ServerName is an IP, Go sends no SNI and verifies against IP SANs, the same
// as a browser connecting by IP.
func probeTrustedHTTPS(domain string, port int) error {
	c := &http.Client{
		Timeout: 3 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			ServerName: domain,
			MinVersion: tls.VersionTLS12,
		}},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := c.Get("https://127.0.0.1:" + strconv.Itoa(port) + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "ok" {
		return errors.New("/healthz did not return ok")
	}
	return nil
}
