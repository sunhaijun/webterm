// Package scripts 把 install.sh 编进二进制（ADR-0045）。
//
// `webterm install` 用的就是这一份：二进制和它的安装脚本永远是同一个版本，
// scp 一个二进制上去就能装，不需要再从网上取脚本、也不需要 GitHub 凭据。
package scripts

import _ "embed"

// InstallSH 是 scripts/install.sh 的原文。
//
//go:embed install.sh
var InstallSH []byte
