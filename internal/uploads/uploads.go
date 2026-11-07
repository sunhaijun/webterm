// Package uploads stores files the user sends to a session (ADR-0051).
//
// A file lands in <temp>/webterm-<uid>/uploads/ under a generated name that
// never needs quoting in a shell, and the frontend pastes its absolute path
// into the session. The directory is private to the agent's user; files are
// deleted after MaxAge, and the oldest go first once the directory passes
// MaxTotal. Nothing here is tied to a session: closing one deletes nothing,
// because a program in a tmux pane can outlive it and still need the file.
//
// See docs/30-protocol/http-api.md#uploads and docs/60-security/threat-model.md (T6, T9).
package uploads

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// MaxFileBytes is the largest file accepted (413 above it).
	MaxFileBytes = 20 << 20
	// MaxTotalBytes caps the directory; the oldest files go first above it.
	MaxTotalBytes = 256 << 20
	// MaxAge is how long a file is kept.
	MaxAge = 24 * time.Hour

	partSuffix = ".part"
	// maxStemBytes bounds the part of the name taken from the original.
	maxStemBytes = 60
	// sniffBytes is what http.DetectContentType looks at.
	sniffBytes = 512
)

var (
	// ErrTooLarge means the body exceeded the per-file limit; nothing was kept.
	ErrTooLarge = errors.New("file too large")
	// ErrEmpty means the body was empty; nothing was kept.
	ErrEmpty = errors.New("empty file")
	// ErrRead means reading the body failed (the client went away); nothing was kept.
	ErrRead = errors.New("reading the upload failed")
)

// Store saves uploads under one root directory.
type Store struct {
	root     string // <temp>/webterm-<uid>
	dir      string // root/uploads
	uid      int
	maxFile  int64
	maxTotal int64
	maxAge   time.Duration
	now      func() time.Time

	// mu serializes moving a finished file into place with trimming the
	// directory, and sweeps, so two of them never pick the same victims.
	// Bodies stream outside it.
	mu sync.Mutex
}

// Option tunes a Store; tests use them to shrink the limits.
type Option func(*Store)

// WithLimits overrides the per-file and total limits.
func WithLimits(maxFile, maxTotal int64) Option {
	return func(s *Store) { s.maxFile, s.maxTotal = maxFile, maxTotal }
}

// WithClock overrides the clock used for ages.
func WithClock(now func() time.Time) Option {
	return func(s *Store) { s.now = now }
}

// DefaultRoot is <temp>/webterm-<uid>, like tmux's /tmp/tmux-<uid>.
// os.TempDir honors $TMPDIR.
func DefaultRoot() string {
	return filepath.Join(os.TempDir(), "webterm-"+strconv.Itoa(os.Getuid()))
}

// New returns a Store rooted at root (DefaultRoot when empty). Nothing is
// created until the first Save.
func New(root string, opts ...Option) *Store {
	if root == "" {
		root = DefaultRoot()
	}
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	s := &Store{
		root:     root,
		dir:      filepath.Join(root, "uploads"),
		uid:      os.Getuid(),
		maxFile:  MaxFileBytes,
		maxTotal: MaxTotalBytes,
		maxAge:   MaxAge,
		now:      time.Now,
	}
	for _, o := range opts {
		o(s)
	}
	return s
}

// Dir is the directory files are saved in.
func (s *Store) Dir() string { return s.dir }

// Save streams r into a new file and returns its absolute path and size.
// name is the original file name; it only shapes the saved name.
func (s *Store) Save(r io.Reader, name string) (path string, size int64, err error) {
	if err := s.ensureDirs(); err != nil {
		return "", 0, err
	}

	// The first bytes decide the extension when the name has none.
	head := make([]byte, sniffBytes)
	n, rerr := io.ReadFull(r, head)
	head = head[:n]
	switch {
	case rerr == io.EOF:
		return "", 0, ErrEmpty
	case rerr != nil && rerr != io.ErrUnexpectedEOF:
		return "", 0, fmt.Errorf("%w: %v", ErrRead, rerr)
	}
	stem, ext := SplitName(name)
	if ext == "" {
		ext = sniffExt(head)
	}

	f, part, err := s.createPart(stem, ext)
	if err != nil {
		return "", 0, err
	}
	keep := false
	defer func() {
		if !keep {
			f.Close()
			os.Remove(part)
		}
	}()

	if _, err := f.Write(head); err != nil {
		return "", 0, fmt.Errorf("write upload: %w", noName(err))
	}
	size = int64(len(head))
	if rerr == nil { // head was full: there may be more
		limit := s.maxFile + 1 - size
		copied, err := io.Copy(f, io.LimitReader(r, limit))
		size += copied
		if err != nil {
			var pe *os.PathError
			if errors.As(err, &pe) {
				return "", 0, fmt.Errorf("write upload: %w", noName(err))
			}
			return "", 0, fmt.Errorf("%w: %v", ErrRead, err)
		}
	}
	if size > s.maxFile {
		return "", 0, ErrTooLarge
	}
	if err := f.Close(); err != nil {
		return "", 0, fmt.Errorf("write upload: %w", noName(err))
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	path, err = s.publish(part, stem, ext)
	if err != nil {
		return "", 0, err
	}
	keep = true
	os.Remove(part)
	s.trimLocked(path)
	return path, size, nil
}

// createPart opens a new, empty <final>.part file exclusively.
func (s *Store) createPart(stem, ext string) (*os.File, string, error) {
	for range 8 {
		part := filepath.Join(s.dir, fileName(stem, randomSuffix(), ext)+partSuffix)
		f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
		if err == nil {
			return f, part, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, "", fmt.Errorf("create upload file: %w", noName(err))
		}
	}
	return nil, "", errors.New("no free file name")
}

// publish hard-links part to a final name that doesn't exist yet. A link,
// not a rename: rename would silently replace an existing file.
func (s *Store) publish(part, stem, ext string) (string, error) {
	// The part file's own suffix is the first choice, so a path is stable
	// from creation; another suffix only on a (rare) collision.
	first := strings.TrimSuffix(filepath.Base(part), partSuffix)
	for i := range 8 {
		name := first
		if i > 0 {
			name = fileName(stem, randomSuffix(), ext)
		}
		final := filepath.Join(s.dir, name)
		err := os.Link(part, final)
		if err == nil {
			return final, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", fmt.Errorf("save upload: %w", noName(err))
		}
	}
	return "", errors.New("no free file name")
}

// Sweep deletes files (finished or partial) older than MaxAge, then trims
// the directory to MaxTotal. A missing directory is not an error; an unsafe
// one is left untouched and reported.
func (s *Store) Sweep() (removed int, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Lstat(s.root); errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err := checkDir(s.root, s.uid); err != nil {
		return 0, err
	}
	if _, err := os.Lstat(s.dir); errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err := checkDir(s.dir, s.uid); err != nil {
		return 0, err
	}
	cutoff := s.now().Add(-s.maxAge)
	for _, f := range s.list(true) {
		if f.mtime.Before(cutoff) && os.Remove(f.path) == nil {
			removed++
		}
	}
	return removed + s.trimLocked(""), nil
}

type entry struct {
	path  string
	size  int64
	mtime time.Time
	part  bool
}

// list returns the regular files in the directory, partial ones only when
// asked.
func (s *Store) list(withParts bool) []entry {
	des, err := os.ReadDir(s.dir)
	if err != nil {
		return nil
	}
	var out []entry
	for _, de := range des {
		if !de.Type().IsRegular() {
			continue
		}
		part := strings.HasSuffix(de.Name(), partSuffix)
		if part && !withParts {
			continue
		}
		fi, err := de.Info()
		if err != nil {
			continue
		}
		out = append(out, entry{path: filepath.Join(s.dir, de.Name()), size: fi.Size(), mtime: fi.ModTime(), part: part})
	}
	return out
}

// trimLocked deletes the oldest finished files until the directory fits in
// maxTotal, never the one just saved (keep). Partial files are uploads in
// flight and don't count. Returns how many it deleted.
func (s *Store) trimLocked(keep string) int {
	files := s.list(false)
	var total int64
	for _, f := range files {
		total += f.size
	}
	if total <= s.maxTotal {
		return 0
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mtime.Before(files[j].mtime) })
	removed := 0
	for _, f := range files {
		if total <= s.maxTotal {
			break
		}
		if f.path == keep {
			continue
		}
		if os.Remove(f.path) == nil {
			total -= f.size
			removed++
		}
	}
	return removed
}

// ensureDirs creates root and root/uploads (0700) if missing and checks
// both before every upload: a real directory, ours, closed to everyone else.
// /tmp is shared, so another local user could have created root first to
// read or redirect uploads (threat model T9). Such a directory is refused,
// never used or repaired.
func (s *Store) ensureDirs() error {
	for _, d := range []string{s.root, s.dir} {
		if err := os.Mkdir(d, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("create %s: %w", d, err)
		}
		if err := checkDir(d, s.uid); err != nil {
			return err
		}
	}
	return nil
}

// noName drops the file name from a file system error: errors end up in the
// log, and file names stay out of it (privacy-history.md).
func noName(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	var le *os.LinkError
	if errors.As(err, &le) {
		return le.Err
	}
	return err
}

// ErrUnsafeDir wraps every reason a directory is refused.
var ErrUnsafeDir = errors.New("upload directory is not safe to use")

func checkDir(path string, uid int) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if fi.Mode()&fs.ModeSymlink != 0 {
		return fmt.Errorf("%w: %s is a symlink", ErrUnsafeDir, path)
	}
	if !fi.IsDir() {
		return fmt.Errorf("%w: %s is not a directory", ErrUnsafeDir, path)
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); !ok || int(st.Uid) != uid {
		return fmt.Errorf("%w: %s is owned by another user", ErrUnsafeDir, path)
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("%w: %s is accessible to other users (mode %04o)", ErrUnsafeDir, path, perm)
	}
	return nil
}

// ---------- Names ----------

// SplitName turns an original file name into a safe stem and a lowercase
// extension (possibly empty). The stem keeps letters of any script, marks,
// digits, '.', '_' and '-'; every other run of characters becomes one '-'.
// It is trimmed of leading and trailing "-._", cut to 60 bytes, and "file"
// when nothing is left. The extension is kept only if it is 1–8 ASCII
// letters or digits.
func SplitName(name string) (stem, ext string) {
	// Browsers send a bare name, but strip any directory part, either slash.
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	base := name
	if i := strings.LastIndexByte(name, '.'); i >= 0 && validExt(name[i+1:]) {
		base, ext = name[:i], strings.ToLower(name[i+1:])
	}
	return cleanStem(base), ext
}

func validExt(e string) bool {
	if len(e) < 1 || len(e) > 8 {
		return false
	}
	for _, c := range e {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

func cleanStem(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range s {
		if r != utf8.RuneError && r != '-' && (unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) || r == '.' || r == '_') {
			b.WriteRune(r)
			dash = false
			continue
		}
		// '-' itself and everything replaced by it collapse into one.
		if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.Trim(b.String(), "-._")
	for len(out) > maxStemBytes {
		_, size := utf8.DecodeLastRuneInString(out)
		out = out[:len(out)-size]
	}
	out = strings.TrimRight(out, "-._")
	if out == "" {
		return "file"
	}
	return out
}

func fileName(stem, suffix, ext string) string {
	if ext == "" {
		return stem + "-" + suffix
	}
	return stem + "-" + suffix + "." + ext
}

// randomSuffix is 6 hex digits.
func randomSuffix() string {
	var b [3]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// sniffExt picks an extension from the content for names without one: an
// image path without an image extension stays plain text in claude.
func sniffExt(head []byte) string {
	ct := http.DetectContentType(head)
	switch {
	case ct == "image/png":
		return "png"
	case ct == "image/jpeg":
		return "jpg"
	case ct == "image/gif":
		return "gif"
	case ct == "image/webp":
		return "webp"
	case ct == "application/pdf":
		return "pdf"
	case strings.HasPrefix(ct, "text/plain"):
		return "txt"
	}
	return ""
}
