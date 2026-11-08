package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Edit changes an item's label, what it sends, or whether it presses Enter.
// Only the label applies to keys.
type Edit struct {
	Label *string `json:"label,omitempty"`
	Send  *string `json:"send,omitempty"`
	Enter *bool   `json:"enter,omitempty"`
}

// Added is a text item the user added.
type Added struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Send  string `json:"send"`
	Enter bool   `json:"enter"`
}

// Arrangement is the user's changes to one program's list (ADR-0057 §5).
type Arrangement struct {
	Order   []string        `json:"order,omitempty"`
	Visible map[string]bool `json:"visible,omitempty"`
	Edits   map[string]Edit `json:"edits,omitempty"`
	Added   []Added         `json:"added,omitempty"`
}

// Limits on what PUT /api/commands accepts.
const (
	maxEntries = 1000
	maxIDLen   = 256
	maxLabel   = 200
	maxSend    = 32 << 10
)

// Validate rejects an arrangement too large or malformed to store.
func (a Arrangement) Validate() error {
	if len(a.Order) > maxEntries || len(a.Visible) > maxEntries || len(a.Edits) > maxEntries || len(a.Added) > maxEntries {
		return errors.New("too many entries")
	}
	for _, id := range a.Order {
		if id == "" || len(id) > maxIDLen {
			return fmt.Errorf("bad id %q", id)
		}
	}
	for id, e := range a.Edits {
		if len(id) > maxIDLen || (e.Label != nil && len(*e.Label) > maxLabel) || (e.Send != nil && len(*e.Send) > maxSend) {
			return fmt.Errorf("edit for %q too large", id)
		}
	}
	for _, x := range a.Added {
		if x.ID == "" || len(x.ID) > maxIDLen || len(x.Label) > maxLabel || len(x.Send) > maxSend || x.Send == "" {
			return fmt.Errorf("bad added item %q", x.ID)
		}
	}
	return nil
}

// Arrange applies an arrangement to the catalog: added items join, edits and
// visibility apply, the ids in Order come first in that order, and everything
// else follows in the catalog's order. Nothing is ordered automatically.
func Arrange(catalog []Item, a Arrangement) []Item {
	all := make([]Item, 0, len(catalog)+len(a.Added))
	all = append(all, catalog...)
	known := map[string]bool{}
	for _, it := range catalog {
		known[it.ID] = true
	}
	for _, x := range a.Added {
		if known[x.ID] {
			continue
		}
		known[x.ID] = true
		all = append(all, Item{ID: x.ID, Label: x.Label, Kind: KindText, Send: []string{x.Send}, Enter: x.Enter, Origin: OriginAdded})
	}
	for i := range all {
		it := &all[i]
		if e, ok := a.Edits[it.ID]; ok {
			if e.Label != nil && *e.Label != "" {
				it.Label = *e.Label
			}
			if it.Kind == KindText {
				if e.Send != nil && *e.Send != "" {
					it.Send = []string{*e.Send}
				}
				if e.Enter != nil {
					it.Enter = *e.Enter
				}
			}
		}
		if v, ok := a.Visible[it.ID]; ok {
			it.Hidden = !v
		}
	}
	index := map[string]int{}
	for i, it := range all {
		index[it.ID] = i
	}
	out := make([]Item, 0, len(all))
	placed := make([]bool, len(all))
	for _, id := range a.Order {
		if i, ok := index[id]; ok && !placed[i] {
			placed[i] = true
			out = append(out, all[i])
		}
	}
	for i, it := range all {
		if !placed[i] {
			out = append(out, it)
		}
	}
	return out
}

// Store keeps every program's arrangement in one JSON file (0600, written
// atomically), so all devices share it and it can be edited by hand.
type Store struct {
	Path string
	mu   sync.Mutex
}

func (s *Store) read() map[string]Arrangement {
	all := map[string]Arrangement{}
	if data, err := os.ReadFile(s.Path); err == nil {
		_ = json.Unmarshal(data, &all)
	}
	return all
}

func (s *Store) write(all map[string]Arrangement) error {
	data, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.Path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.Path), ".commands-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.Path)
}

// Load returns a program's arrangement (empty when there is none).
func (s *Store) Load(program string) Arrangement {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.read()[program]
}

// Save replaces a program's arrangement.
func (s *Store) Save(program string, a Arrangement) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := s.read()
	all[program] = a
	return s.write(all)
}

// Reset removes a program's arrangement: back to the defaults.
func (s *Store) Reset(program string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := s.read()
	if _, ok := all[program]; !ok {
		return nil
	}
	delete(all, program)
	return s.write(all)
}
