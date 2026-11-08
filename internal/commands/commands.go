// Package commands builds the command strip's items for claude and codex and
// merges them with the user's arrangement (ADR-0057 §4–§5,
// docs/30-protocol/http-api.md#commands).
//
// claude's built-in commands come from the tool itself: the init message of
// `claude -p --output-format stream-json`, probed with the executable in front
// and cached by its resolved path, so a self-update is picked up by the next
// request. codex offers nothing like it, so its list ships with webterm.
// Custom commands are read from their files on every request.
package commands

import (
	"context"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Kind is how an item is sent.
type Kind string

const (
	// KindKeys: Send holds byte strings written 120 ms apart, past sticky modifiers.
	KindKeys Kind = "keys"
	// KindText: Send holds one string, pasted, then Enter when Enter is true.
	KindText Kind = "text"
)

// Origin says where an item came from.
type Origin string

const (
	OriginKey     Origin = "key"
	OriginBuiltin Origin = "builtin"
	OriginCustom  Origin = "custom"
	OriginSkill   Origin = "skill"
	OriginAdded   Origin = "added"
)

// Item is one chip of the command strip.
type Item struct {
	ID     string   `json:"id"`
	Label  string   `json:"label"`
	Kind   Kind     `json:"kind"`
	Send   []string `json:"send"`
	Enter  bool     `json:"enter"`
	Origin Origin   `json:"origin"`
	Hidden bool     `json:"hidden"`
}

// Input is what the catalog needs about the session in front.
type Input struct {
	Program string // "claude" or "codex"; anything else has no strip
	Home    string
	Cwd     string
	// Command runs the claude in front: its executable, or interpreter and
	// script for an npm install (see ProbeCommand).
	Command []string
}

// Catalog returns the program's items in the source's order. warning is
// non-empty when claude's built-ins couldn't be listed; the rest still is.
func Catalog(ctx context.Context, in Input, p *Prober) (items []Item, warning string) {
	switch in.Program {
	case "claude":
		return claudeCatalog(ctx, in, p)
	case "codex":
		return codexCatalog(in), ""
	}
	return []Item{}, ""
}

func text(id string, origin Origin) Item {
	return Item{ID: id, Label: id, Kind: KindText, Send: []string{id}, Enter: true, Origin: origin}
}

// ---------- claude ----------

// claudeKey is one of claude's shortcuts; action is claude's name for it in
// keybindings.json, so a rebind can be followed.
type claudeKey struct {
	id, key, name, action string
}

// claudeKeys are claude's shortcuts worth a chip, checked against claude
// 2.1.317's built-in key bindings.
var claudeKeys = []claudeKey{
	{"key:shift-tab", "shift+tab", "Mode", "chat:cycleMode"},
	{"key:esc-esc", "escape escape", "Rewind", ""},
	{"key:ctrl-o", "ctrl+o", "Transcript", "app:toggleTranscript"},
	{"key:ctrl-t", "ctrl+t", "Todos", "app:toggleTodos"},
	{"key:ctrl-b", "ctrl+b", "Background", "task:background"},
	{"key:ctrl-r", "ctrl+r", "History", "history:search"},
	{"key:alt-p", "meta+p", "Model", "chat:modelPicker"},
	{"key:alt-t", "meta+t", "Thinking", "chat:thinkingToggle"},
	{"key:ctrl-g", "ctrl+g", "Editor", "chat:externalEditor"},
	{"key:ctrl-s", "ctrl+s", "Stash", "chat:stash"},
	{"key:ctrl-j", "ctrl+j", "Newline", "chat:newline"},
	{"key:ctrl-c", "ctrl+c", "Interrupt", "app:interrupt"},
	{"key:ctrl-d", "ctrl+d", "Exit", "app:exit"},
}

// claudeSupplement are interactive-only commands that `--bare` doesn't list.
var claudeSupplement = []string{"copy", "resume"}

func claudeCatalog(ctx context.Context, in Input, p *Prober) ([]Item, string) {
	rebinds := readKeybindings(filepath.Join(in.Home, ".claude", "keybindings.json"))
	var items []Item
	for _, k := range claudeKeys {
		key := k.key
		if r, ok := rebinds[k.action]; ok && k.action != "" {
			key = r
		}
		send, ok := keyBytes(key)
		if !ok {
			send, _ = keyBytes(k.key)
			key = k.key
		}
		items = append(items, Item{ID: k.id, Label: keyGlyph(key) + " " + k.name, Kind: KindKeys, Send: send, Origin: OriginKey})
	}
	seen := map[string]bool{}
	add := func(name string, origin Origin) {
		id := "/" + name
		if name == "" || seen[id] {
			return
		}
		seen[id] = true
		it := text(id, origin)
		it.Hidden = origin == OriginSkill
		items = append(items, it)
	}

	warning := ""
	var probed Result
	if p == nil || len(in.Command) == 0 {
		warning = "claude's built-in commands are unknown: no claude in front"
	} else if r, err := p.Get(ctx, in.Command); err != nil {
		warning = "couldn't list claude's built-in commands: " + err.Error()
	} else {
		probed = r
	}
	skills := map[string]bool{}
	for _, s := range probed.Skills {
		skills[s] = true
	}
	for _, c := range probed.Commands {
		if !skills[c] && !strings.HasPrefix(c, "__") {
			add(c, OriginBuiltin)
		}
	}
	for _, c := range claudeSupplement {
		add(c, OriginBuiltin)
	}
	for _, c := range mdNames(filepath.Join(in.Home, ".claude", "commands")) {
		add(c, OriginCustom)
	}
	if in.Cwd != "" {
		for _, c := range mdNames(filepath.Join(in.Cwd, ".claude", "commands")) {
			add(c, OriginCustom)
		}
	}
	for _, s := range probed.Skills {
		add(s, OriginSkill)
	}
	return items, warning
}

// readKeybindings maps claude actions to the key the user bound them to in
// ~/.claude/keybindings.json ({"bindings": [{"context", "bindings": {key: action|null}}]}).
func readKeybindings(path string) map[string]string {
	out := map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	var f struct {
		Bindings []struct {
			Bindings map[string]*string `json:"bindings"`
		} `json:"bindings"`
	}
	if json.Unmarshal(data, &f) != nil {
		return out
	}
	for _, block := range f.Bindings {
		for key, action := range block.Bindings {
			if action != nil && *action != "" {
				out[*action] = key
			}
		}
	}
	return out
}

// mdNames lists the custom commands under dir: every *.md, recursively, named
// after the file.
func mdNames(dir string) []string {
	var out []string
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || len(out) >= 500 {
			return nil
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".md") {
			out = append(out, strings.TrimSuffix(d.Name(), ".md"))
		}
		return nil
	})
	return out
}

// ---------- codex ----------

var codexKeys = []struct{ id, key, name string }{
	{"key:esc", "escape", "Interrupt"},
	{"key:esc-esc", "escape escape", "Edit previous"},
	{"key:ctrl-t", "ctrl+t", "Transcript"},
	{"key:ctrl-j", "ctrl+j", "Newline"},
	{"key:ctrl-l", "ctrl+l", "Clear"},
	{"key:ctrl-c", "ctrl+c", "Quit"},
}

// codexCommands is codex 0.166's slash command list (codex has no
// machine-readable list; it follows webterm releases).
var codexCommands = []string{
	"model", "permissions", "review", "new", "resume", "fork", "rename", "archive", "delete",
	"compact", "diff", "mention", "copy", "export", "prompts", "init", "status", "mcp", "logout", "quit",
}

func codexCatalog(in Input) []Item {
	var items []Item
	for _, k := range codexKeys {
		send, _ := keyBytes(k.key)
		items = append(items, Item{ID: k.id, Label: keyGlyph(k.key) + " " + k.name, Kind: KindKeys, Send: send, Origin: OriginKey})
	}
	for _, c := range codexCommands {
		items = append(items, text("/"+c, OriginBuiltin))
	}
	for _, c := range mdNames(filepath.Join(in.Home, ".codex", "prompts")) {
		items = append(items, text("/prompts:"+c, OriginCustom))
	}
	return items
}

// ---------- keys ----------

// keyBytes turns a key spec as keybindings.json writes it ("ctrl+o",
// "shift+tab", "meta+p", "escape", chords separated by spaces) into the bytes
// a terminal sends, one string per chord.
func keyBytes(spec string) ([]string, bool) {
	var out []string
	for _, chord := range strings.Fields(strings.ToLower(spec)) {
		b, ok := chordBytes(chord)
		if !ok {
			return nil, false
		}
		out = append(out, b)
	}
	return out, len(out) > 0
}

func chordBytes(chord string) (string, bool) {
	parts := strings.Split(chord, "+")
	key := parts[len(parts)-1]
	mods := map[string]bool{}
	for _, m := range parts[:len(parts)-1] {
		mods[m] = true
	}
	named := map[string]string{"escape": "\x1b", "esc": "\x1b", "enter": "\r", "return": "\r", "tab": "\t", "space": " "}
	var base string
	switch {
	case key == "tab" && mods["shift"] && len(mods) == 1:
		return "\x1b[Z", true
	case named[key] != "":
		base = named[key]
	case len(key) == 1:
		base = key
	default:
		return "", false
	}
	delete(mods, "shift")
	if mods["ctrl"] {
		delete(mods, "ctrl")
		c := base[0]
		switch {
		case len(base) == 1 && c >= 'a' && c <= 'z':
			base = string(rune(c - 'a' + 1))
		case len(base) == 1 && c >= '[' && c <= '_':
			base = string(rune(c - '@'))
		default:
			return "", false
		}
	}
	if mods["meta"] || mods["alt"] {
		delete(mods, "meta")
		delete(mods, "alt")
		base = "\x1b" + base
	}
	if len(mods) > 0 {
		return "", false
	}
	return base, true
}

// keyGlyph shows a key spec the way the extra keys do: ^O, ⇧Tab, ⌥P, Esc Esc.
func keyGlyph(spec string) string {
	var out []string
	for _, chord := range strings.Fields(strings.ToLower(spec)) {
		parts := strings.Split(chord, "+")
		key := parts[len(parts)-1]
		name := strings.ToUpper(key)
		switch key {
		case "escape", "esc":
			name = "Esc"
		case "tab":
			name = "Tab"
		case "enter", "return":
			name = "↵"
		}
		prefix := ""
		for _, m := range parts[:len(parts)-1] {
			switch m {
			case "ctrl":
				prefix += "^"
			case "shift":
				prefix += "⇧"
			case "meta", "alt":
				prefix += "⌥"
			}
		}
		out = append(out, prefix+name)
	}
	return strings.Join(out, " ")
}
