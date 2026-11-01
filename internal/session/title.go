package session

import (
	"strings"
	"unicode"
)

// 终端标题作自动名（ADR-0043）。
//
// 标题归属于【设它时在前台的进程组】：轮询发现标题被写过（写入次数变了），就把它记在
// 此刻的前台进程组名下。只有那个进程组仍在前台、且它不是 shell 本身时才采用 ——
// shell 在提示符时设的 `user@host: dir`（Debian 默认 .bashrc）不用，程序退出回到目录名，
// 再启动的程序设标题之前不沿用上一次的。

// maxTitleRunes 是采用的标题最多保留的字符数。标签 240px、抽屉一行也就二三十个字，
// 再长只是白白占消息。
const maxTitleRunes = 64

// cleanTitle 清洗程序设的标题：控制字符（C0、DEL、C1）换成空格，连续空白合成一个，
// 去掉首尾空白，最多 maxTitleRunes 个字符。内容本身不改写 —— claude 的 ✳ / ◐ 前缀
// 就是忙闲信号。
func cleanTitle(raw string) string {
	var b strings.Builder
	space := false
	n := 0
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			space = b.Len() > 0
			continue
		}
		if n == maxTitleRunes {
			break
		}
		if space {
			if n+1 == maxTitleRunes {
				break
			}
			b.WriteByte(' ')
			n++
			space = false
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// pickTitle 决定此刻采用哪个标题（"" = 不用，名字回到目录名）。fg 是此刻的前台
// 进程组，owner 是标题的归属，shell 是 shell 的 pid（交互式 shell 开着 job control，
// pid 就是它的进程组 id；0 = 不知道）。
func pickTitle(raw string, fg, owner, shell int) string {
	if owner <= 0 || fg != owner || (shell > 0 && fg == shell) {
		return ""
	}
	return cleanTitle(raw)
}
