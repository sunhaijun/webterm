package files

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// UT-fs-path: paths must be absolute and are cleaned (http-api.md#files).
func TestAbs(t *testing.T) {
	for in, want := range map[string]string{
		"/":                "/",
		"/a/./b/../c":      "/a/c",
		"//etc///nginx/":   "/etc/nginx",
		"/home/u/截图 1.png": "/home/u/截图 1.png",
	} {
		got, err := Abs(in)
		if err != nil || got != want {
			t.Errorf("Abs(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "a/b", "./x", "~/x", "/a\x00b"} {
		if _, err := Abs(in); !errors.Is(err, ErrBadPath) {
			t.Errorf("Abs(%q): err %v, want ErrBadPath", in, err)
		}
	}
}

// UT-fs-name: what a single name may be, and the names tried when one is taken.
func TestValidName(t *testing.T) {
	for _, ok := range []string{"a.txt", ".env", "shot 1 (2).png", "截图.png", "..a", "a..", strings.Repeat("x", 255)} {
		if !ValidName(ok) {
			t.Errorf("ValidName(%q) = false", ok)
		}
	}
	for _, bad := range []string{"", ".", "..", "a/b", "/", "a\x00b", "line\nbreak", "tab\there", "del\x7f", strings.Repeat("x", 256)} {
		if ValidName(bad) {
			t.Errorf("ValidName(%q) = true", bad)
		}
	}
}

func TestCandidates(t *testing.T) {
	for name, want := range map[string][]string{
		"shot.png":    {"shot.png", "shot-1.png", "shot-2.png"},
		"a.tar.gz":    {"a.tar.gz", "a.tar-1.gz", "a.tar-2.gz"},
		".env":        {".env", ".env-1", ".env-2"},
		".config.yml": {".config.yml", ".config-1.yml", ".config-2.yml"},
		"Makefile":    {"Makefile", "Makefile-1", "Makefile-2"},
		"x.":          {"x.", "x-1.", "x-2."},
	} {
		for i, w := range want {
			if got := candidate(name, i); got != w {
				t.Errorf("candidate(%q, %d) = %q, want %q", name, i, got, w)
			}
		}
	}
}

// UT-fs-list: entries typed by their target, sizes, times, the cap.
func TestList(t *testing.T) {
	d := t.TempDir()
	mustWrite(t, filepath.Join(d, "b.txt"), "hello")
	if err := os.Mkdir(filepath.Join(d, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	must(t, os.Symlink("sub", filepath.Join(d, "to-dir")))
	must(t, os.Symlink("b.txt", filepath.Join(d, "to-file")))
	must(t, os.Symlink("nowhere", filepath.Join(d, "broken")))
	must(t, syscall.Mkfifo(filepath.Join(d, "fifo"), 0o600))
	when := time.Date(2026, 11, 8, 14, 5, 0, 0, time.UTC)
	must(t, os.Chtimes(filepath.Join(d, "b.txt"), when, when))

	got, err := List(d+"/./", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got.Path != d || got.Total != 6 || len(got.Entries) != 6 {
		t.Fatalf("path %q total %d entries %d", got.Path, got.Total, len(got.Entries))
	}
	byName := map[string]Entry{}
	for _, e := range got.Entries {
		byName[e.Name] = e
	}
	for name, want := range map[string]string{"b.txt": "file", "sub": "dir", "to-dir": "dir", "to-file": "file", "broken": "other", "fifo": "other"} {
		if byName[name].Type != want {
			t.Errorf("%s: type %q, want %q", name, byName[name].Type, want)
		}
	}
	if e := byName["b.txt"]; e.Size != 5 || e.MTime != when.UnixMilli() {
		t.Errorf("b.txt: size %d mtime %d", e.Size, e.MTime)
	}
	if byName["to-file"].Size != 5 || byName["sub"].Size != 0 {
		t.Errorf("sizes: link %d, dir %d", byName["to-file"].Size, byName["sub"].Size)
	}

	capped, err := List(d, 2)
	if err != nil || len(capped.Entries) != 2 || capped.Total != 6 || capped.Entries[0].Name != "b.txt" {
		t.Errorf("capped: %+v, %v", capped, err)
	}

	if _, err := List(filepath.Join(d, "b.txt"), 0); !errors.Is(err, ErrNotDir) {
		t.Errorf("a file: err %v, want ErrNotDir", err)
	}
	if _, err := List(filepath.Join(d, "missing"), 0); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing: err %v, want ErrNotExist", err)
	}
}

// Raw: regular files only, and a FIFO never blocks the open.
func TestOpen(t *testing.T) {
	d := t.TempDir()
	mustWrite(t, filepath.Join(d, "a.txt"), "abc")
	must(t, syscall.Mkfifo(filepath.Join(d, "fifo"), 0o600))
	must(t, os.Symlink("a.txt", filepath.Join(d, "link")))

	for _, name := range []string{"a.txt", "link"} {
		f, info, err := Open(filepath.Join(d, name))
		if err != nil || info.Size() != 3 {
			t.Fatalf("%s: %v", name, err)
		}
		f.Close()
	}
	done := make(chan error, 1)
	go func() {
		_, _, err := Open(filepath.Join(d, "fifo"))
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, ErrNotRegular) {
			t.Errorf("fifo: err %v, want ErrNotRegular", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("opening a FIFO blocked")
	}
	if _, _, err := Open(d); !errors.Is(err, ErrNotRegular) {
		t.Errorf("dir: err %v, want ErrNotRegular", err)
	}
}

func TestContentType(t *testing.T) {
	for name, want := range map[string]string{
		"a.PNG": "image/png", "a.jpeg": "image/jpeg", "a.svg": "image/svg+xml", "a.mp4": "video/mp4",
		"a.mov": "video/quicktime", "a.mp3": "audio/mpeg", "a.opus": "audio/ogg", "a.pdf": "application/pdf",
		"a.log": "text/plain; charset=utf-8", "a.html": "application/octet-stream", "Makefile": "application/octet-stream",
	} {
		if got := ContentType(name); got != want {
			t.Errorf("ContentType(%q) = %q, want %q", name, got, want)
		}
	}
	for ct, want := range map[string]bool{
		"image/png": true, "image/svg+xml": false, "video/webm": true, "audio/flac": true,
		"application/pdf": false, "text/plain; charset=utf-8": false, "application/octet-stream": false,
	} {
		if Inline(ct) != want {
			t.Errorf("Inline(%q) = %v", ct, !want)
		}
	}
}

// UT-fs-save: byte for byte, never overwriting, no part file left behind.
func TestSave(t *testing.T) {
	d := t.TempDir()
	body := bytes.Repeat([]byte("0123456789"), 100_000)

	path, size, err := Save(d, "shot 1.png", bytes.NewReader(body))
	if err != nil || path != filepath.Join(d, "shot 1.png") || size != int64(len(body)) {
		t.Fatalf("Save: %q %d %v", path, size, err)
	}
	if data, _ := os.ReadFile(path); !bytes.Equal(data, body) {
		t.Error("content differs")
	}
	umask := syscall.Umask(0)
	syscall.Umask(umask)
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o666&^fs.FileMode(umask) {
		t.Errorf("mode %v, umask %o", fi.Mode().Perm(), umask)
	}

	for i, want := range []string{"shot 1-1.png", "shot 1-2.png"} {
		p, _, err := Save(d, "shot 1.png", strings.NewReader("again"))
		if err != nil || filepath.Base(p) != want {
			t.Errorf("conflict %d: %q %v, want %q", i, p, err, want)
		}
	}
	if data, _ := os.ReadFile(path); !bytes.Equal(data, body) {
		t.Error("the original was overwritten")
	}

	_, _, err = Save(d, "cut.bin", io.MultiReader(strings.NewReader("part"), errReader{}))
	if !errors.Is(err, ErrRead) {
		t.Errorf("interrupted: err %v, want ErrRead", err)
	}
	if _, err := os.Stat(filepath.Join(d, "cut.bin")); !errors.Is(err, fs.ErrNotExist) {
		t.Error("an interrupted upload left the file")
	}
	assertNoParts(t, d)

	if _, _, err := Save(d, "../x", strings.NewReader("x")); !errors.Is(err, ErrBadName) {
		t.Errorf("bad name: err %v", err)
	}
	if _, _, err := Save(path, "x", strings.NewReader("x")); !errors.Is(err, ErrNotDir) {
		t.Errorf("into a file: err %v", err)
	}
	if _, _, err := Save(filepath.Join(d, "missing"), "x", strings.NewReader("x")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("into a missing folder: err %v", err)
	}
	empty, _, err := Save(d, "empty", strings.NewReader(""))
	if fi, _ := os.Stat(empty); err != nil || fi == nil || fi.Size() != 0 {
		t.Errorf("empty file: %v", err)
	}
	assertNoParts(t, d)
}

// The rename never replaces, even when the file system has no RENAME_NOREPLACE.
func TestRenameNoReplaceFallback(t *testing.T) {
	d := t.TempDir()
	mustWrite(t, filepath.Join(d, "a"), "A")
	mustWrite(t, filepath.Join(d, "b"), "B")
	if err := renameFallback(filepath.Join(d, "a"), filepath.Join(d, "b")); !errors.Is(err, fs.ErrExist) {
		t.Errorf("err %v, want ErrExist", err)
	}
	if err := renameFallback(filepath.Join(d, "a"), filepath.Join(d, "c")); err != nil {
		t.Error(err)
	}
	if data, _ := os.ReadFile(filepath.Join(d, "c")); string(data) != "A" {
		t.Error("not moved")
	}
}

// UT-fs-ops: mkdir, rename, delete.
func TestOps(t *testing.T) {
	d := t.TempDir()
	home := filepath.Join(d, "home")
	must(t, os.Mkdir(home, 0o755))

	if p, err := Mkdir(d, "made"); err != nil || p != filepath.Join(d, "made") {
		t.Fatal(p, err)
	}
	if _, err := Mkdir(d, "made"); !errors.Is(err, fs.ErrExist) {
		t.Errorf("mkdir twice: %v", err)
	}
	if _, err := Mkdir(filepath.Join(d, "no"), "parent"); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("mkdir without a parent: %v", err)
	}
	for _, bad := range []string{"../escaped", "a/b", "..", ""} {
		if _, err := Mkdir(d, bad); !errors.Is(err, ErrBadName) {
			t.Errorf("Mkdir(%q): %v, want ErrBadName", bad, err)
		}
	}

	mustWrite(t, filepath.Join(d, "a.txt"), "A")
	mustWrite(t, filepath.Join(d, "b.txt"), "B")
	if _, err := Rename(filepath.Join(d, "a.txt"), "b.txt", home); !errors.Is(err, fs.ErrExist) {
		t.Errorf("rename onto a file: %v", err)
	}
	if data, _ := os.ReadFile(filepath.Join(d, "b.txt")); string(data) != "B" {
		t.Error("rename replaced the target")
	}
	if _, err := Rename(filepath.Join(d, "a.txt"), "made", home); !errors.Is(err, fs.ErrExist) {
		t.Errorf("rename onto a folder: %v", err)
	}
	if p, err := Rename(filepath.Join(d, "a.txt"), "a.txt", home); err != nil || p != filepath.Join(d, "a.txt") {
		t.Errorf("same name: %q %v", p, err)
	}
	if p, err := Rename(filepath.Join(d, "a.txt"), "c d.txt", home); err != nil || p != filepath.Join(d, "c d.txt") {
		t.Errorf("rename: %q %v", p, err)
	}
	if _, err := Rename(filepath.Join(d, "made"), "renamed", home); err != nil {
		t.Errorf("rename a folder: %v", err)
	}
	if _, err := Rename(filepath.Join(d, "b.txt"), "x/y", home); !errors.Is(err, ErrBadName) {
		t.Errorf("bad name: %v", err)
	}
	if _, err := Rename(filepath.Join(d, "missing"), "z", home); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing: %v", err)
	}

	tree := filepath.Join(d, "renamed", "deep", "er")
	must(t, os.MkdirAll(tree, 0o755))
	mustWrite(t, filepath.Join(tree, "f"), "x")
	if err := Remove(filepath.Join(d, "renamed"), home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(d, "renamed")); !errors.Is(err, fs.ErrNotExist) {
		t.Error("folder still there")
	}
	must(t, os.Symlink(filepath.Join(d, "b.txt"), filepath.Join(d, "link")))
	if err := Remove(filepath.Join(d, "link"), home); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(d, "b.txt")); err != nil {
		t.Error("deleting a link deleted its target")
	}
	if err := Remove(filepath.Join(d, "missing"), home); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing: %v", err)
	}
	for _, p := range []string{"/", home, home + "/"} {
		if err := Remove(p, home); !errors.Is(err, ErrRefused) {
			t.Errorf("Remove(%q): %v, want ErrRefused", p, err)
		}
	}
	if _, err := os.Stat(home); err != nil {
		t.Error("home was deleted")
	}
	if _, err := Rename(home, "moved", home); !errors.Is(err, ErrRefused) {
		t.Errorf("rename home: %v, want ErrRefused", err)
	}

	// Home reached through a symlinked parent is still home; a link to home is just a link
	alias := filepath.Join(d, "alias")
	must(t, os.Symlink(d, alias))
	if err := Remove(filepath.Join(alias, "home"), home); !errors.Is(err, ErrRefused) {
		t.Errorf("home through a symlinked parent: %v, want ErrRefused", err)
	}
	link := filepath.Join(d, "to-home")
	must(t, os.Symlink(home, link))
	if err := Remove(link, home); err != nil {
		t.Errorf("a link to home: %v", err)
	}
	if _, err := os.Stat(home); err != nil {
		t.Error("deleting a link to home deleted home")
	}
}

// A name that isn't UTF-8 can't round-trip through JSON: it is flagged.
func TestListBadName(t *testing.T) {
	d := t.TempDir()
	mustWrite(t, filepath.Join(d, "\xd6\xd0\xce\xc4.txt"), "gbk")
	mustWrite(t, filepath.Join(d, "ok.txt"), "ok")
	l, err := List(d, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range l.Entries {
		if e.BadName != (e.Name != "ok.txt") {
			t.Errorf("%q: BadName %v", e.Name, e.BadName)
		}
	}
}

// Devices and sockets are refused without being opened.
func TestOpenSocket(t *testing.T) {
	d := t.TempDir()
	sock := filepath.Join(d, "s.sock")
	fd, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	must(t, err)
	defer syscall.Close(fd)
	must(t, syscall.Bind(fd, &syscall.SockaddrUnix{Name: sock}))
	for _, p := range []string{sock, "/dev/null"} {
		if _, _, err := Open(p); !errors.Is(err, ErrNotRegular) {
			t.Errorf("%s: %v, want ErrNotRegular", p, err)
		}
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

func assertNoParts(t *testing.T, dir string) {
	t.Helper()
	des, _ := os.ReadDir(dir)
	for _, de := range des {
		if strings.HasSuffix(de.Name(), ".part") {
			t.Errorf("part file left: %s", de.Name())
		}
	}
}

func mustWrite(t *testing.T, path, s string) {
	t.Helper()
	must(t, os.WriteFile(path, []byte(s), 0o644))
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
