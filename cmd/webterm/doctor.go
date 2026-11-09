package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
)

// webterm doctor checks what a deployment needs and explains failures in plain
// words (US-7.2, AC-1.13). --acme also obtains the certificate the service will
// use. --guide, which the installer passes when there is a terminal, stops at the
// steps only the user can do (a DNS record, the cloud firewall), says exactly what
// to do, and checks again until they pass (ADR-0046).

// Test seams: no network, no real CA.
var (
	doctorOut       io.Writer = os.Stdout
	lookupPublicIP            = publicIP
	lookupHost                = resolveViaPublicDNS
	issueCheck                = agent.IssueCheck
	openTTY                   = func() (io.ReadCloser, error) { return os.Open("/dev/tty") }
	cloudVendor               = detectCloudVendor
	dnsPollInterval           = 10 * time.Second
	dnsPollTimeout            = 30 * time.Minute
)

// letsEncryptStaging is only used to re-check reachability in a guided install:
// staging has generous limits and the certificate is thrown away (ADR-0046).
const letsEncryptStaging = "https://acme-staging-v02.api.letsencrypt.org/directory"

// warning is worth reporting but shouldn't block a deployment.
type warning struct{ msg string }

func (w warning) Error() string { return w.msg }

type doctor struct {
	out            io.Writer
	tty            *bufio.Reader // nil when not guiding
	failed, warned int
}

func runDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	var c commonFlags
	c.register(fs)
	httpPort := fs.Int("http-port", 80, "port for certificate validation and redirects")
	httpsPort := fs.Int("https-port", 443, "HTTPS port")
	acmeCheck := fs.Bool("acme", false, "also obtain the certificate the service will use (binds both ports; stop the service first)")
	guide := fs.Bool("guide", false, "when something needs fixing by hand (DNS, cloud firewall), explain it and wait to check again; needs a terminal")
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}

	d := &doctor{out: doctorOut}
	if *guide {
		if f, err := openTTY(); err == nil {
			defer f.Close()
			d.tty = bufio.NewReader(f)
		}
	}

	fmt.Fprintln(d.out, "webterm doctor")
	fmt.Fprintln(d.out)

	d.check("bash", func() (string, error) {
		out, err := exec.Command("bash", "--version").Output()
		if err != nil {
			return "", errors.New("bash not found. Sessions run bash by default: install it, or pick another shell with --shell")
		}
		// "GNU bash, version 5.2.37(1)-release (x86_64-pc-linux-gnu)" → "5.2.37"
		v := strings.SplitN(string(out), "\n", 2)[0]
		if f := strings.Fields(strings.TrimPrefix(v, "GNU bash, version ")); len(f) > 0 {
			v = strings.SplitN(f[0], "(", 2)[0]
		}
		return v, nil
	})
	d.check("Data directory", func() (string, error) {
		if err := os.MkdirAll(c.dataDir, 0o700); err != nil {
			return "", fmt.Errorf("can't create %s: %v", c.dataDir, err)
		}
		f, err := os.CreateTemp(c.dataDir, ".doctor-*")
		if err != nil {
			return "", fmt.Errorf("%s isn't writable: %v", c.dataDir, err)
		}
		f.Close()
		os.Remove(f.Name())
		return c.dataDir, nil
	})

	if c.dev {
		fmt.Fprintln(d.out, "\n(--dev: address and port checks skipped)")
		return d.summarize(nil)
	}
	if c.domain == "" {
		d.fail("Address", "No --domain given. Use a domain name, or this server's public IPv4.")
		return d.summarize(nil)
	}
	if err := agent.CheckAddress(c.domain); err != nil {
		d.fail("Address", err.Error())
		return d.summarize(nil)
	}

	if agent.IsIPAddress(c.domain) {
		// IP mode (ADR-0044): no DNS; the address must be this machine's public IP.
		d.check("Public IP", func() (string, error) { return checkPublicIP(c.domain, lookupPublicIP) })
	} else {
		d.check("DNS", func() (string, error) { return d.checkDNS(c.domain) })
	}

	for _, p := range []int{*httpPort, *httpsPort} {
		d.check(fmt.Sprintf("Port %d is free", p), func() (string, error) {
			ln, err := net.Listen("tcp", fmt.Sprintf(":%d", p))
			if err == nil {
				ln.Close()
				return "", nil
			}
			return classifyPortErr(p, err, portBusy)
		})
	}

	if *acmeCheck {
		if d.failed > 0 {
			fmt.Fprintln(d.out, "  - Certificate: skipped until the items above are fixed"+
				" (if webterm itself holds the ports: sudo systemctl stop webterm)")
		} else {
			fmt.Fprintln(d.out, "  … Certificate: requesting one from Let's Encrypt")
			d.check("Certificate", func() (string, error) {
				return d.obtainCert(c.domain, agent.CertDirDefault(c.dataDir), *httpPort, *httpsPort)
			})
		}
	}
	if *acmeCheck {
		return d.summarize(nil)
	}
	return d.summarize([]int{*httpPort, *httpsPort})
}

func (d *doctor) check(name string, fn func() (string, error)) {
	detail, err := fn()
	var w warning
	switch {
	case errors.As(err, &w):
		d.warned++
		fmt.Fprintf(d.out, "  ⚠ %s\n      %s\n", name, indent(w.msg))
	case err != nil:
		d.fail(name, err.Error())
	case detail != "":
		fmt.Fprintf(d.out, "  ✓ %s (%s)\n", name, detail)
	default:
		fmt.Fprintf(d.out, "  ✓ %s\n", name)
	}
}

func (d *doctor) fail(name, msg string) {
	d.failed++
	fmt.Fprintf(d.out, "  ✗ %s\n      %s\n", name, indent(msg))
}

// note prints guidance while a check is waiting on the user.
func (d *doctor) note(msg string) {
	fmt.Fprintf(d.out, "\n  → %s\n", indent(msg))
}

// waitEnter blocks until the user presses Enter. False means no more input.
func (d *doctor) waitEnter() bool {
	fmt.Fprint(d.out, "      Press Enter to check again (Ctrl+C to quit) ")
	_, err := d.tty.ReadString('\n')
	return err == nil
}

// checkDNS requires the domain to resolve to this machine's public IP. Guided, it
// shows the record to add and polls until it appears.
func (d *doctor) checkDNS(domain string) (string, error) {
	public, err := lookupPublicIP()
	if err != nil {
		if _, lerr := lookupHost(domain); lerr != nil {
			return "", fmt.Errorf("%s doesn't resolve: %v", domain, lerr)
		}
		return "", warning{fmt.Sprintf("Couldn't detect this server's public IP (%v). Check by hand that\n"+
			"  dig +short %s\nprints the same address as\n  curl -s ifconfig.me", err, domain)}
	}
	points := func() ([]string, bool) {
		ips, err := lookupHost(domain)
		return ips, err == nil && slices.Contains(ips, public)
	}
	ips, ok := points()
	if ok {
		return domain + " → " + public, nil
	}
	advice := dnsAdvice(domain, ips, public)
	if d.tty == nil {
		return "", errors.New(advice)
	}
	d.note(advice + fmt.Sprintf("\nWaiting for the record to appear (checking every %s, Ctrl+C to quit)…", dnsPollInterval))
	for deadline := time.Now().Add(dnsPollTimeout); time.Now().Before(deadline); {
		time.Sleep(dnsPollInterval)
		if _, ok := points(); ok {
			return domain + " → " + public, nil
		}
	}
	return "", fmt.Errorf("%s still doesn't point to %s after %s", domain, public, dnsPollTimeout)
}

func dnsAdvice(domain string, ips []string, public string) string {
	now := "doesn't resolve yet"
	if len(ips) > 0 {
		now = "points to " + strings.Join(ips, ", ")
	}
	return fmt.Sprintf("%s %s; it must point to this server (%s).\n"+
		"Add this record at your DNS provider:\n"+
		"  Type   A\n"+
		"  Name   %s\n"+
		"  Value  %s\n"+
		"Use an A record, not a CNAME. On Cloudflare, set it to \"DNS only\" (grey cloud).",
		domain, now, public, domain, public)
}

// obtainCert gets the certificate into certDir, where the service picks it up.
// If Let's Encrypt can't reach this machine and we're guiding, it explains how to
// open the cloud firewall, waits for Enter, and re-checks against staging (which
// doesn't count against production limits) before requesting the real certificate.
func (d *doctor) obtainCert(domain, certDir string, httpPort, httpsPort int) (string, error) {
	cfg := agent.ServeConfig{
		Domain: domain, Bind: "0.0.0.0",
		HTTPPort: httpPort, HTTPSPort: httpsPort, CertDir: certDir,
	}
	detail, err := issueOnce(cfg)
	if err == nil || d.tty == nil || !agent.IsUnreachable(err) {
		return detail, err
	}

	d.note(firewallAdvice(domain, httpPort, httpsPort, cloudVendor()))
	for {
		if !d.waitEnter() {
			return "", err
		}
		fmt.Fprintln(d.out, "  … Checking whether Let's Encrypt can reach this server")
		perr := probeReachable(cfg)
		if perr == nil {
			break
		}
		if !agent.IsUnreachable(perr) {
			return "", perr
		}
		fmt.Fprintf(d.out, "      Still can't reach http://%s/ from the internet.\n", hostPort(domain, httpPort))
	}
	fmt.Fprintln(d.out, "  … Reachable. Requesting the certificate")
	return issueOnce(cfg)
}

func issueOnce(cfg agent.ServeConfig) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	leaf, issued, err := issueCheck(ctx, cfg)
	if err != nil {
		return "", err
	}
	exp := leaf.NotAfter.Local().Format("2006-01-02 15:04")
	if !issued {
		return "already have one, expires " + exp + "; didn't contact the CA, so reachability wasn't tested", nil
	}
	return "issued, expires " + exp + "; the service will use it", nil
}

func probeReachable(cfg agent.ServeConfig) error {
	dir, err := os.MkdirTemp("", "webterm-probe-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	cfg.CertDir = dir
	cfg.ACMEDirectoryURL = letsEncryptStaging
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	_, _, err = issueCheck(ctx, cfg)
	return err
}

func firewallAdvice(domain string, httpPort, httpsPort int, vendor string) string {
	where := "Your provider's console, usually under \"Security groups\" or \"Firewall\" → inbound rules."
	if vendor != "" {
		where = vendor
	}
	return fmt.Sprintf("Let's Encrypt can't reach http://%s/, so it can't issue a certificate.\n"+
		"Allow inbound TCP %d and %d in your cloud firewall:\n"+
		"  %s\n"+
		"Behind NAT, or your ISP blocks port 80? See \"Behind NAT\" in docs/80-ops/install.md.",
		hostPort(domain, httpPort), httpPort, httpsPort, where)
}

func hostPort(host string, port int) string {
	if port == 80 {
		return host
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// detectCloudVendor reads the DMI vendor strings (world-readable) to point at the
// right console page. Empty if unknown.
func detectCloudVendor() string {
	read := func(f string) string {
		b, _ := os.ReadFile("/sys/class/dmi/id/" + f)
		return strings.TrimSpace(string(b))
	}
	s := strings.ToLower(read("sys_vendor") + " " + read("product_name") + " " + read("bios_vendor"))
	for _, v := range []struct{ key, where string }{
		{"alibaba", "Alibaba Cloud: ECS console → Security Groups → Inbound rules"},
		{"tencent", "Tencent Cloud: CVM console → Security Groups → Inbound rules"},
		{"huawei", "Huawei Cloud: ECS console → Security Groups → Inbound Rules"},
		{"amazon", "AWS: EC2 console → Security Groups → Edit inbound rules"},
		{"google", "Google Cloud: VPC network → Firewall → Create firewall rule"},
		{"microsoft", "Azure: your VM → Networking → Add inbound port rule"},
		{"digitalocean", "DigitalOcean: Networking → Firewalls"},
		{"hetzner", "Hetzner Cloud: Firewalls (or detach the firewall from this server)"},
		{"vultr", "Vultr: Network → Firewall"},
		{"oracle", "Oracle Cloud: your VCN → Security Lists → Ingress Rules"},
	} {
		if strings.Contains(s, v.key) {
			return v.where
		}
	}
	return ""
}

// checkPublicIP: in IP mode, --domain must be this machine's public IP.
func checkPublicIP(ip string, lookup func() (string, error)) (string, error) {
	public, err := lookup()
	if err != nil {
		return "", fmt.Errorf("couldn't detect this server's public IP (%v). Check by hand:\n  curl -s ifconfig.me   should print %s", err, ip)
	}
	if public != ip {
		return "", fmt.Errorf("this server's public IP is %s, not %s.\n"+
			"Let's Encrypt validates %s, so the certificate can't be issued here.\n"+
			"  The IP changed: reinstall with --domain %s (devices must pair again)\n"+
			"  Behind NAT: see \"Behind NAT\" in docs/80-ops/install.md", public, ip, ip, public)
	}
	return public, nil
}

// resolveViaPublicDNS asks public resolvers first: the local stub resolver caches
// negative answers, so a freshly added record can take minutes to show up locally.
//
// Each resolver gets its own deadline: where outbound DNS to public resolvers is
// blocked, they time out and the system resolver must still get its chance.
func resolveViaPublicDNS(host string) ([]string, error) {
	lookup := func(r *net.Resolver, timeout time.Duration) ([]string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		return r.LookupHost(ctx, host)
	}
	for _, server := range []string{"1.1.1.1:53", "8.8.8.8:53"} {
		r := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "udp", server)
		}}
		ips, err := lookup(r, 2*time.Second)
		var dnsErr *net.DNSError
		if err == nil || (errors.As(err, &dnsErr) && dnsErr.IsNotFound) {
			return ips, err
		}
	}
	return lookup(net.DefaultResolver, 5*time.Second)
}

// classifyPortErr turns a failed bind into a verdict. No permission is not the same
// as busy: a freshly downloaded binary without setcap can't bind port 80 even when
// it's free, and that must not block an install (the installed copy gets setcap).
// busy is injected because CI can't produce a real EACCES.
func classifyPortErr(p int, err error, busy func(int) bool) (string, error) {
	occupied := fmt.Errorf("in use by another program. Find it with:\n  ss -lntp | grep :%d", p)
	if !errors.Is(err, syscall.EACCES) || busy(p) {
		return "", occupied
	}
	return "", warning{fmt.Sprintf("Port %d is free, but this binary may not bind it (ports below 1024 need a capability).\n"+
		"The installer grants it. By hand:\n"+
		"  sudo setcap 'cap_net_bind_service=+ep' $(command -v webterm)\n"+
		"Don't run webterm as root: that puts a root shell on the internet.", p)}
}

// portBusy reports whether something listens on port p, by connecting rather than
// binding (binding a low port without permission can't tell busy from forbidden).
// Only checks loopback; a listener bound to a single external address shows up
// later as "address already in use".
func portBusy(p int) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)), time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

// summarize prints the verdict. firewallHint, the HTTP and HTTPS ports, adds
// the note that only --acme can tell whether the cloud firewall lets them in.
func (d *doctor) summarize(firewallHint []int) error {
	fmt.Fprintln(d.out)
	if d.failed > 0 {
		return fmt.Errorf("%d check(s) failed; see above", d.failed)
	}
	if d.warned > 0 {
		fmt.Fprintf(d.out, "Nothing blocking (%d warning(s) above).\n", d.warned)
	} else {
		fmt.Fprintln(d.out, "All checks passed.")
	}
	if len(firewallHint) == 2 {
		fmt.Fprintf(d.out, "Whether your cloud firewall lets TCP %d and %d in can't be checked from inside this machine;\n", firewallHint[0], firewallHint[1])
		fmt.Fprintln(d.out, "add --acme to actually request the certificate (stop the service first).")
	}
	return nil
}

func publicIP() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.ipify.org", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func indent(s string) string { return strings.ReplaceAll(s, "\n", "\n      ") }
