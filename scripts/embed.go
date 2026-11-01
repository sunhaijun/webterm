// Package scripts embeds install.sh in the binary (ADR-0045), so `webterm install`
// always runs the installer from its own version and works without network access
// to GitHub.
package scripts

import _ "embed"

// InstallSH is the content of scripts/install.sh.
//
//go:embed install.sh
var InstallSH []byte
