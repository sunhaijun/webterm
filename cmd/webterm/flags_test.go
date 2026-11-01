package main

import "testing"

// baseURL is the only entry point the user gets: the pairing URL and QR code
// are built from it. Dropping a non-default port means the scanned code does
// not open when 443 is taken (see the non-standard port section of
// docs/80-ops/install.md).
func TestBaseURL(t *testing.T) {
	cases := []struct {
		name      string
		dev       bool
		domain    string
		httpPort  int
		httpsPort int
		want      string
	}{
		{
			"--dev uses loopback and the HTTP port",
			true, "", 8080, 443,
			"http://127.0.0.1:8080",
		},
		{
			"--dev follows a custom HTTP port",
			true, "", 18080, 443,
			"http://127.0.0.1:18080",
		},
		{
			"production on 443 omits the port",
			false, "term.example.com", 80, 443,
			"https://term.example.com",
		},
		{
			// The motivating case: 443 is taken by another service.
			"production on another port includes it",
			false, "term.example.com", 80, 8443,
			"https://term.example.com:8443",
		},
		{
			"production on 8080 includes it too",
			false, "term.example.com", 80, 8080,
			"https://term.example.com:8080",
		},
		{
			// 0 can only mean the caller forgot to pass it; treat it as 443
			// rather than appending ":0".
			"httpsPort 0 is treated as 443",
			false, "term.example.com", 80, 0,
			"https://term.example.com",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := &commonFlags{domain: tc.domain, dev: tc.dev}
			if got := c.baseURL(tc.httpPort, tc.httpsPort); got != tc.want {
				t.Errorf("baseURL(%d, %d) = %q, want %q", tc.httpPort, tc.httpsPort, got, tc.want)
			}
		})
	}
}

// The pairing URL carries the code in the fragment (AC-1.5) and keeps the port.
func TestPairURLKeepsPortAndFragment(t *testing.T) {
	c := &commonFlags{domain: "term.example.com"}
	got := c.baseURL(80, 8443) + "/pair#abc123"
	want := "https://term.example.com:8443/pair#abc123"
	if got != want {
		t.Errorf("pairing URL = %q, want %q", got, want)
	}
}
