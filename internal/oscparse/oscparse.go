package oscparse

import (
	"bytes"
	"encoding/base64"
	"net/url"
	"strconv"
	"strings"
)

const (
	esc = 0x1b
	bel = 0x07

	// maxPayload 是单个 OSC 负载的上限。超限则放弃该序列：把已缓冲的字节
	// 【原样输出】并回到正常状态 —— 绝不能吞掉数据。
	maxPayload = 8 << 10 // 8 KiB

	// maxIDLen 是我们关心的 OSC 编号的最大长度（"1701"）。
	maxIDLen = 4
)

type state int

const (
	stNormal     state = iota // 正常字节流
	stEsc                     // 见到 ESC，等下一个字节
	stID                      // 见到 ESC ]，正在读数字编号
	stPayload                 // 编号是我们的，正在缓冲负载
	stPayloadEsc              // 负载中见到 ESC，可能是 ST
	stPass                    // 不是我们的 OSC，原样透传直到终止符
	stPassEsc                 // 透传中见到 ESC，可能是 ST
)

// Parser 是跨 Feed 调用保持状态的流式状态机 —— 序列可能被 PTY.Read()
// 切在任何一个字节上。
//
// Parser 不是并发安全的；每个会话一个实例，只在 readLoop 里用。
type Parser struct {
	st     state
	id     []byte // 正在读的 OSC 编号
	pay    []byte // 正在缓冲的负载
	out    []byte // Feed 的输出缓冲，跨调用复用
	events []Event
	// offs[i] 是 events[i] 在【本次 Feed 的干净输出】里的偏移：该序列前面
	// 已经吐出了多少个字节。session 用"块首 seq + 偏移"给 command.start/end
	// 盖戳 —— 不能用整块 append 之后的 head：一条快命令的 133;C、输出、133;D
	// 常在同一次 PTY 读里到达，用同一个 head 会让块的字节区间为空。
	offs []int
}

// New 创建一个解析器。
func New() *Parser {
	return &Parser{
		id:  make([]byte, 0, maxIDLen+1),
		pay: make([]byte, 0, 256),
		out: make([]byte, 0, 32<<10),
	}
}

// Feed 消费一批字节，返回剥离后的输出和抽出的事件。
//
// 返回的 out 可能是 in 的子切片（无 OSC 的快路径，零分配），也可能指向
// Parser 内部复用的缓冲 —— 两种情况下调用方都必须在下次 Feed 之前用完它
// （比如立刻 ring.Append，那里会拷贝）。
func (p *Parser) Feed(in []byte) (out []byte, events []Event) {
	p.events = p.events[:0]
	p.offs = p.offs[:0]

	// 快路径：绝大多数字节里没有 ESC，直接透传，不产生任何分配。
	if p.st == stNormal && bytes.IndexByte(in, esc) < 0 {
		return in, nil
	}

	p.out = p.out[:0]
	for i := 0; i < len(in); i++ {
		c := in[i]
		switch p.st {
		case stNormal:
			// 批量拷贝到下一个 ESC，避免逐字节 append
			if j := bytes.IndexByte(in[i:], esc); j < 0 {
				p.out = append(p.out, in[i:]...)
				i = len(in)
			} else {
				p.out = append(p.out, in[i:i+j]...)
				i += j
				p.st = stEsc
			}

		case stEsc:
			if c == ']' {
				p.st = stID
				p.id = p.id[:0]
			} else {
				// 不是 OSC，把 ESC 和这个字节原样吐出
				p.out = append(p.out, esc)
				if c == esc {
					p.st = stEsc // 连续 ESC：保持等待
				} else {
					p.out = append(p.out, c)
					p.st = stNormal
				}
			}

		case stID:
			switch {
			case c >= '0' && c <= '9' && len(p.id) < maxIDLen:
				p.id = append(p.id, c)
			case c == ';' && p.isOurs():
				p.st = stPayload
				p.pay = p.pay[:0]
			case isTerm(c) || (c == esc):
				// 没有分隔符就结束了（如 ESC]7BEL）—— 不是我们能用的形式，原样吐出
				p.emitRawOSC()
				if c == esc {
					p.st = stPassEsc
				} else {
					p.out = append(p.out, c)
					p.st = stNormal
				}
			default:
				// 不是我们关心的 OSC：吐出已缓冲的部分，剩下的原样透传
				p.emitRawOSC()
				p.out = append(p.out, c)
				p.st = stPass
			}

		case stPayload:
			switch {
			case c == bel:
				p.finish()
			case c == esc:
				p.st = stPayloadEsc
			case len(p.pay) >= maxPayload:
				// 负载超限：放弃该序列，把已缓冲的字节原样输出，绝不吞数据
				p.emitRawOSC()
				p.out = append(p.out, ';')
				p.out = append(p.out, p.pay...)
				p.out = append(p.out, c)
				p.pay = p.pay[:0]
				p.st = stPass
			default:
				p.pay = append(p.pay, c)
			}

		case stPayloadEsc:
			if c == '\\' { // ST = ESC \
				p.finish()
			} else {
				// ESC 不是 ST 的一部分：当作负载内容继续
				p.pay = append(p.pay, esc, c)
				p.st = stPayload
			}

		case stPass:
			p.out = append(p.out, c)
			switch {
			case c == bel:
				p.st = stNormal
			case c == esc:
				p.st = stPassEsc
			}

		case stPassEsc:
			p.out = append(p.out, c)
			if c == '\\' {
				p.st = stNormal
			} else if c != esc {
				p.st = stPass
			}
		}
	}
	return p.out, p.events
}

// Offsets 返回上一次 Feed 产生的每个事件在【那次 Feed 的干净输出】里的偏移，
// 与 events 一一对应。偏移是相对本次 Feed 的，跨 Feed 由调用方加上块首 seq。
//
// 单独一个方法而不是改事件类型：事件类型是对外契约，且大量测试用
// DeepEqual 比较它们；偏移是 session 才关心的附带信息。
func (p *Parser) Offsets() []int { return p.offs }

// emit 记一个事件，同时记下它在干净输出里的位置。
func (p *Parser) emit(ev Event) {
	p.events = append(p.events, ev)
	p.offs = append(p.offs, len(p.out))
}

// isOurs 报告当前编号是不是 webterm 关心的那三个之一。
func (p *Parser) isOurs() bool {
	switch string(p.id) {
	case "133", "7", "1701":
		return true
	}
	return false
}

// emitRawOSC 把已缓冲的 "ESC ] <id>" 原样吐回输出流。
// 遇到不认识的 OSC 时必须调用它 —— 不能把别人的序列吞掉。
func (p *Parser) emitRawOSC() {
	p.out = append(p.out, esc, ']')
	p.out = append(p.out, p.id...)
}

// finish 结算一个完整的 webterm OSC 序列：剥离它，并在可能时产生事件。
// 畸形负载一律只剥离不产生事件，不崩溃。
func (p *Parser) finish() {
	switch string(p.id) {
	case "133":
		p.finish133()
	case "7":
		p.finish7()
	case "1701":
		p.finish1701()
	}
	p.pay = p.pay[:0]
	p.st = stNormal
}

func (p *Parser) finish133() {
	if len(p.pay) == 0 {
		return
	}
	switch p.pay[0] {
	case 'A':
		// prompt 开始：剥离，不产生消息
	case 'B':
		p.emit(PromptEvent{State: "input"})
	case 'C':
		p.emit(PromptEvent{State: "running"})
	case 'D':
		var code *int
		if rest, ok := strings.CutPrefix(string(p.pay), "D;"); ok {
			// 退出码非数字或缺失 → 视为 null，不阻断处理
			if n, err := strconv.Atoi(strings.TrimSpace(rest)); err == nil {
				code = &n
			}
		}
		p.emit(PromptEvent{State: "done"})
		p.emit(CommandEndEvent{ExitCode: code})
	}
}

func (p *Parser) finish7() {
	// 负载形如 file://<hostname><percent-encoded-path>。hostname 忽略（总在本机）。
	u, err := url.Parse(string(p.pay))
	if err != nil || u.Scheme != "file" || u.Path == "" {
		return // 解析失败 → 忽略这条，不发消息，不报错
	}
	p.emit(CWDEvent{Path: u.Path})
}

func (p *Parser) finish1701() {
	kind, rest, ok := strings.Cut(string(p.pay), ";")
	if !ok {
		return
	}
	switch kind {
	case "hello":
		p.emit(IntegrationHelloEvent{Version: rest})
	case "cmd":
		// base64（标准字母表带填充）：命令原文可以包含 BEL/ESC/换行等会破坏
		// OSC 结构的字节，所以必须编码
		text, err := base64.StdEncoding.DecodeString(rest)
		if err != nil {
			return // 畸形 base64 → 剥离但无事件
		}
		p.emit(CommandTextEvent{Text: string(text)})
	}
}

func isTerm(c byte) bool { return c == bel }
