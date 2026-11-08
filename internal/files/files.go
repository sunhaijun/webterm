// Package files is the file browser's file system side (ADR-0059): listing a
// folder, opening a regular file to serve, saving an upload without ever
// overwriting, and creating, renaming and deleting.
//
// The agent user's permissions are the only fence: a paired device already
// has a shell with exactly these rights. Paths must be absolute; they are
// cleaned and symbolic links are followed as the system follows them.
// Nothing here keeps state.
//
// See docs/30-protocol/http-api.md#files.
package files

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

// MaxEntries is the most entries one listing returns.
const MaxEntries = 5000

var (
	// ErrBadPath: not absolute, or contains a NUL byte.
	ErrBadPath = errors.New("path must be absolute")
	// ErrBadName: not a single, printable path component.
	ErrBadName = errors.New("invalid name")
	// ErrNotDir: a folder was expected.
	ErrNotDir = errors.New("not a folder")
	// ErrNotRegular: only regular files are served.
	ErrNotRegular = errors.New("not a regular file")
	// ErrRefused: deleting or renaming / or the home directory.
	ErrRefused = errors.New("refusing to change that")
	// ErrRead: reading the upload failed (the client went away); nothing was kept.
	ErrRead = errors.New("reading the upload failed")
)

// Abs validates and cleans a path from a request.
func Abs(p string) (string, error) {
	if !strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) {
		return "", ErrBadPath
	}
	return filepath.Clean(p), nil
}

// ValidName reports whether name can be one path component: not empty, not
// `.` or `..`, no `/`, no control characters, at most 255 bytes.
func ValidName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 255 {
		return false
	}
	for _, r := range name {
		if r == '/' || r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// Entry is one row of a listing. Type is that of a link's target.
type Entry struct {
	Name  string `json:"name"`
	Type  string `json:"type"` // dir, file or other
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"` // unix milliseconds
	// BadName: the name isn't valid UTF-8 (GBK names from a Windows zip, say).
	// JSON can't carry it losslessly, so the page shows it but can't address it.
	BadName bool `json:"bad_name,omitempty"`
}

// Listing is a folder's contents: at most max entries, in byte order of
// their names, and how many there are in all.
type Listing struct {
	Path    string  `json:"path"`
	Entries []Entry `json:"entries"`
	Total   int     `json:"total"`
}

// List reads a folder. max <= 0 means MaxEntries.
func List(dir string, max int) (Listing, error) {
	dir, err := Abs(dir)
	if err != nil {
		return Listing{}, err
	}
	if max <= 0 {
		max = MaxEntries
	}
	info, err := os.Stat(dir)
	if err != nil {
		return Listing{}, err
	}
	if !info.IsDir() {
		return Listing{}, ErrNotDir
	}
	des, err := os.ReadDir(dir) // sorted by name
	if err != nil && len(des) == 0 {
		return Listing{}, err
	}
	out := Listing{Path: dir, Total: len(des), Entries: make([]Entry, 0, min(len(des), max))}
	for _, de := range des[:min(len(des), max)] {
		out.Entries = append(out.Entries, entry(dir, de))
	}
	return out, nil
}

func entry(dir string, de fs.DirEntry) Entry {
	e := Entry{Name: de.Name(), Type: "other", BadName: !utf8.ValidString(de.Name())}
	info, err := de.Info()
	if err != nil {
		return e
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		target, err := os.Stat(filepath.Join(dir, de.Name()))
		if err != nil { // points nowhere: keep the link's own time
			e.MTime = info.ModTime().UnixMilli()
			return e
		}
		info = target
	}
	e.MTime = info.ModTime().UnixMilli()
	switch {
	case info.IsDir():
		e.Type = "dir"
	case info.Mode().IsRegular():
		e.Type = "file"
		e.Size = info.Size()
	}
	return e
}

// Open opens a regular file for serving. Anything else is refused before it
// is opened: opening a device can have side effects (a serial line's DTR, a
// tape rewinding), a socket can't be opened at all. O_NONBLOCK keeps a FIFO
// swapped in between the check and the open from blocking, and the check is
// repeated on what was opened.
func Open(path string) (*os.File, fs.FileInfo, error) {
	path, err := Abs(path)
	if err != nil {
		return nil, nil, err
	}
	if info, err := os.Stat(path); err != nil {
		return nil, nil, err
	} else if !info.Mode().IsRegular() {
		return nil, nil, ErrNotRegular
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		f.Close()
		return nil, nil, ErrNotRegular
	}
	// Back to blocking reads for the copy.
	if err := syscall.SetNonblock(int(f.Fd()), false); err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, info, nil
}

var contentTypes = map[string]string{
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
	"webp": "image/webp", "avif": "image/avif", "bmp": "image/bmp", "ico": "image/x-icon",
	"svg": "image/svg+xml",
	"mp4": "video/mp4", "m4v": "video/mp4", "webm": "video/webm", "mov": "video/quicktime", "ogv": "video/ogg",
	"mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav", "flac": "audio/flac",
	"ogg": "audio/ogg", "oga": "audio/ogg", "opus": "audio/ogg",
	"pdf": "application/pdf",
	"txt": "text/plain; charset=utf-8", "log": "text/plain; charset=utf-8",
	"md": "text/plain; charset=utf-8", "csv": "text/plain; charset=utf-8",
}

// ContentType is webterm's own type for a file name (by its lowercased
// extension), application/octet-stream when it has none in the table. The
// system's mime.types isn't consulted: the answer decides what may render.
func ContentType(name string) string {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
	if ct, ok := contentTypes[ext]; ok {
		return ct
	}
	return "application/octet-stream"
}

// Inline reports whether a type may be shown in place when opened as a
// page: images other than SVG, video and audio. Everything else is an
// attachment (ADR-0059 §7).
func Inline(contentType string) bool {
	switch {
	case contentType == "image/svg+xml":
		return false
	case strings.HasPrefix(contentType, "image/"), strings.HasPrefix(contentType, "video/"), strings.HasPrefix(contentType, "audio/"):
		return true
	}
	return false
}

// maxSuffix is the last "-N" tried for a taken name.
const maxSuffix = 999

// Save streams r into dir under name, or under <stem>-N<ext> if name is
// taken; it never overwrites. It returns the path written and its size. The
// body goes to a hidden part file in dir first, so the final rename is
// atomic; a failure deletes it.
func Save(dir, name string, r io.Reader) (string, int64, error) {
	dir, err := Abs(dir)
	if err != nil {
		return "", 0, err
	}
	if !ValidName(name) {
		return "", 0, ErrBadName
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", 0, err
	}
	if !info.IsDir() {
		return "", 0, ErrNotDir
	}

	f, part, err := createPart(dir)
	if err != nil {
		return "", 0, err
	}
	kept := false
	defer func() {
		if !kept {
			f.Close()
			os.Remove(part)
		}
	}()
	size, err := io.Copy(f, r)
	if err != nil {
		var pe *os.PathError
		if errors.As(err, &pe) { // the write failed, not the read
			return "", 0, fmt.Errorf("write upload: %w", pe.Err)
		}
		return "", 0, fmt.Errorf("%w: %v", ErrRead, err)
	}
	if err := f.Close(); err != nil {
		return "", 0, fmt.Errorf("write upload: %w", unwrapPath(err))
	}
	for i := 0; i <= maxSuffix; i++ {
		final := filepath.Join(dir, candidate(name, i))
		err := renameNoReplace(part, final)
		if err == nil {
			kept = true
			return final, size, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return "", 0, fmt.Errorf("move upload into place: %w", unwrapPath(err))
		}
	}
	return "", 0, fs.ErrExist
}

// createPart opens a new hidden part file in dir, exclusively, with mode
// 0666 minus the umask like any program's files.
func createPart(dir string) (*os.File, string, error) {
	for range 8 {
		var b [6]byte
		if _, err := rand.Read(b[:]); err != nil {
			return nil, "", err
		}
		part := filepath.Join(dir, ".webterm-upload-"+hex.EncodeToString(b[:])+".part")
		f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o666)
		if err == nil {
			return f, part, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, "", fmt.Errorf("create upload file: %w", unwrapPath(err))
		}
	}
	return nil, "", errors.New("no free part file name")
}

// candidate is the i-th name tried for name: name itself, then
// <stem>-1<ext>, <stem>-2<ext>, … The extension is the last one; a name
// starting with "." and no other dot has none.
func candidate(name string, i int) string {
	if i == 0 {
		return name
	}
	stem, ext := name, ""
	if dot := strings.LastIndexByte(name, '.'); dot > 0 {
		stem, ext = name[:dot], name[dot:]
	}
	return stem + "-" + strconv.Itoa(i) + ext
}

// renameNoReplace renames old to new unless new exists (fs.ErrExist).
func renameNoReplace(old, new string) error {
	err := unix.Renameat2(unix.AT_FDCWD, old, unix.AT_FDCWD, new, unix.RENAME_NOREPLACE)
	if errors.Is(err, unix.EINVAL) || errors.Is(err, unix.ENOSYS) || errors.Is(err, unix.ENOTSUP) {
		return renameFallback(old, new) // the file system lacks RENAME_NOREPLACE
	}
	if err != nil {
		return &os.LinkError{Op: "rename", Old: old, New: new, Err: err}
	}
	return nil
}

// renameFallback checks, then renames. Racy only against another writer of
// the same name in the same instant.
func renameFallback(old, new string) error {
	if _, err := os.Lstat(new); err == nil {
		return &os.LinkError{Op: "rename", Old: old, New: new, Err: fs.ErrExist}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Rename(old, new)
}

// Mkdir creates the folder name in dir (0777 minus the umask) and returns
// its path.
func Mkdir(dir, name string) (string, error) {
	dir, err := Abs(dir)
	if err != nil {
		return "", err
	}
	if !ValidName(name) {
		return "", ErrBadName
	}
	path := filepath.Join(dir, name)
	return path, os.Mkdir(path, 0o777)
}

// Rename renames path to name in the same folder, never replacing anything,
// and returns the new path. It refuses / and the home directory.
func Rename(path, name, home string) (string, error) {
	path, err := Abs(path)
	if err != nil {
		return "", err
	}
	if !ValidName(name) {
		return "", ErrBadName
	}
	if _, err := os.Lstat(path); err != nil {
		return "", err
	}
	if protected(path, home) {
		return "", ErrRefused
	}
	to := filepath.Join(filepath.Dir(path), name)
	if to == path {
		return path, nil
	}
	if err := renameNoReplace(path, to); err != nil {
		return "", err
	}
	return to, nil
}

// Remove deletes a file, a link (not its target) or a folder with all it
// holds. It refuses / and the home directory.
func Remove(path, home string) error {
	path, err := Abs(path)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(path); err != nil {
		return err
	}
	if protected(path, home) {
		return ErrRefused
	}
	return os.RemoveAll(path)
}

// protected reports whether path is / or the home directory, by name or as
// the same folder reached another way (/home a symlink to /var/home, say).
// A symbolic link to either isn't: deleting or renaming it leaves the target.
func protected(path, home string) bool {
	if path == "/" || (home != "" && path == filepath.Clean(home)) {
		return true
	}
	self, err := os.Lstat(path)
	if err != nil {
		return false
	}
	for _, p := range []string{"/", home} {
		if p == "" {
			continue
		}
		if other, err := os.Stat(p); err == nil && os.SameFile(self, other) {
			return true
		}
	}
	return false
}

// unwrapPath drops the path from an *os.PathError so callers can log the
// reason without the name.
func unwrapPath(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	var le *os.LinkError
	if errors.As(err, &le) {
		return le.Err
	}
	return err
}

// Reason is err without any path in it, for logs.
func Reason(err error) error { return unwrapPath(err) }
