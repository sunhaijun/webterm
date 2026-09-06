// Package oscparse 是 agent 侧的流式 OSC 状态机：从 PTY 输出流里剥离 webterm
// 关心的 OSC 序列，并抽出结构化事件。
//
// 契约见 docs/30-protocol/shell-integration.md §5。两条关键不变式：
//
//  1. 剥离必须在环形缓冲 append 之前完成，out_seq 在剥离【之后】计数（ADR-0006）。
//  2. 只剥离 133 / 7 / 1701。其它 OSC（0/1/2 标题、8 超链接、52 剪贴板…）
//     必须原样透传，否则会破坏终端功能。
package oscparse

// Event 是从输出流里抽出的一个控制事件。
type Event interface{ isEvent() }

// PromptEvent 来自 OSC 133;B/C/D，驱动输入模式自动切换（ADR-0007）。
// 133;A（prompt 开始）不产生事件 —— 对客户端没有用处。
type PromptEvent struct {
	State string // protocol.PromptInput / PromptRunning / PromptDone
}

// CommandEndEvent 来自 OSC 133;D;<exit_code>。
// ExitCode 为 nil 表示退出码缺失或非数字（不阻断处理）。
type CommandEndEvent struct {
	ExitCode *int
}

// CommandTextEvent 来自 OSC 1701;cmd;<base64>，携带命令原文。
//
// OSC 133 只标记边界不含命令文本，而"捕获 B 与 C 之间用户键入的字节"在
// readline 编辑（方向键、历史调用、补全）下完全不可靠，所以显式发送。
type CommandTextEvent struct {
	Text string
}

// CWDEvent 来自 OSC 7，负载是 file://<host><percent-encoded-path>。
type CWDEvent struct {
	Path string
}

// IntegrationHelloEvent 来自 OSC 1701;hello;<version>，是集成握手。
type IntegrationHelloEvent struct {
	Version string
}

func (PromptEvent) isEvent()           {}
func (CommandEndEvent) isEvent()       {}
func (CommandTextEvent) isEvent()      {}
func (CWDEvent) isEvent()              {}
func (IntegrationHelloEvent) isEvent() {}
