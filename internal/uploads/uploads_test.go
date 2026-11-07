package uploads_test

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/uploads"
)

// A minimal PNG: signature + IHDR is enough for http.DetectContentType.
var pngBytes = append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"), bytes.Repeat([]byte{7}, 100)...)

// UT-upload-name: names never need quoting in a shell, keep what they can
// of the original, and get an extension claude recognizes (ADR-0051 §5).
func TestSplitName(t *testing.T) {
	long := strings.Repeat("截", 40) // 120 bytes
	for _, tc := range []struct{ in, stem, ext string }{
		{"shot 1.png", "shot-1", "png"},
		{"Screenshot 2026-11-06 at 15.30.12.PNG", "Screenshot-2026-11-06-at-15.30.12", "png"},
		{"截图 2026.11.06.jpg", "截图-2026.11.06", "jpg"},
		{"IMG_0001.HEIC", "IMG_0001", "heic"},
		{"../../etc/passwd", "passwd", ""},
		{`C:\fakepath\photo.jpeg`, "photo", "jpeg"},
		{"a;rm -rf $(x) `y`'z\".jpg", "a-rm-rf-x-y-z", "jpg"},
		{"-rf.png", "rf", "png"},
		{"..", "file", ""},
		{"", "file", ""},
		{".bashrc", "file", "bashrc"},
		{"archive.tar.gz", "archive.tar", "gz"},
		{"notes.verylongext", "notes.verylongext", ""},
		{"tab\there\nnewline.txt", "tab-here-newline", "txt"},
		{"e\u0301te\u0301.png", "e\u0301te\u0301", "png"}, // NFD accents (macOS) are marks, kept
		{long + ".png", strings.Repeat("截", 20), "png"},
	} {
		stem, ext := uploads.SplitName(tc.in)
		if stem != tc.stem || ext != tc.ext {
			t.Errorf("SplitName(%q) = %q, %q; want %q, %q", tc.in, stem, ext, tc.stem, tc.ext)
		}
		if len(stem) > 60 {
			t.Errorf("SplitName(%q): stem is %d bytes, want ≤ 60", tc.in, len(stem))
		}
	}
}

var nameRE = regexp.MustCompile(`^[\pL\pM\pN._-]+-[0-9a-f]{6}(\.[a-z0-9]{1,8})?$`)

func newStore(t *testing.T, opts ...uploads.Option) (*uploads.Store, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "webterm-test")
	return uploads.New(root, opts...), root
}

func TestSave(t *testing.T) {
	s, root := newStore(t)
	path, size, err := s.Save(bytes.NewReader(pngBytes), "shot 1.png")
	if err != nil {
		t.Fatal(err)
	}
	if size != int64(len(pngBytes)) {
		t.Errorf("size = %d, want %d", size, len(pngBytes))
	}
	if !filepath.IsAbs(path) || filepath.Dir(path) != filepath.Join(root, "uploads") {
		t.Errorf("path = %s, want an absolute path in %s/uploads", path, root)
	}
	if base := filepath.Base(path); !nameRE.MatchString(base) || !strings.HasPrefix(base, "shot-1-") || !strings.HasSuffix(base, ".png") {
		t.Errorf("name = %s", base)
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, pngBytes) {
		t.Errorf("content differs (err %v)", err)
	}
	for p, want := range map[string]os.FileMode{path: 0o600, root: 0o700, filepath.Dir(path): 0o700} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != want {
			t.Errorf("%s mode = %04o, want %04o", p, fi.Mode().Perm(), want)
		}
	}
	assertNoParts(t, s.Dir())

	// The same name twice gives two files.
	path2, _, err := s.Save(bytes.NewReader(pngBytes), "shot 1.png")
	if err != nil {
		t.Fatal(err)
	}
	if path2 == path {
		t.Error("second upload reused the first path")
	}
}

func TestSaveSniffsMissingExtension(t *testing.T) {
	s, _ := newStore(t)
	for _, tc := range []struct {
		name string
		body []byte
		ext  string
	}{
		{"", pngBytes, ".png"},
		{"image", []byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00"), ".jpg"},
		{"log", []byte("plain text\nsecond line\n"), ".txt"},
		{"blob", []byte{0, 1, 2, 3, 0xfe, 0xff, 0, 9}, ""},
		{"named.png", []byte("not really a png"), ".png"}, // the original extension wins
	} {
		path, _, err := s.Save(bytes.NewReader(tc.body), tc.name)
		if err != nil {
			t.Fatal(err)
		}
		if got := filepath.Ext(path); got != tc.ext {
			t.Errorf("%q: extension %q, want %q (path %s)", tc.name, got, tc.ext, path)
		}
	}
}

func TestSaveLimits(t *testing.T) {
	s, _ := newStore(t, uploads.WithLimits(1000, 1<<20))

	if _, _, err := s.Save(bytes.NewReader(nil), "empty.png"); !errors.Is(err, uploads.ErrEmpty) {
		t.Errorf("empty body: err = %v, want ErrEmpty", err)
	}
	if _, _, err := s.Save(bytes.NewReader(make([]byte, 1001)), "big.bin"); !errors.Is(err, uploads.ErrTooLarge) {
		t.Errorf("1001 bytes: err = %v, want ErrTooLarge", err)
	}
	// Exactly at the limit is fine; under the sniff size too.
	if _, size, err := s.Save(bytes.NewReader(make([]byte, 1000)), "edge.bin"); err != nil || size != 1000 {
		t.Errorf("1000 bytes: size %d, err %v", size, err)
	}
	if _, _, err := s.Save(bytes.NewReader(make([]byte, 10)), "small.bin"); err != nil {
		t.Errorf("10 bytes: %v", err)
	}
	// A body that fails midway keeps nothing.
	if _, _, err := s.Save(io.MultiReader(bytes.NewReader(make([]byte, 600)), failing{}), "cut.bin"); !errors.Is(err, uploads.ErrRead) {
		t.Errorf("failing reader: err = %v, want ErrRead", err)
	}
	if n := countFiles(t, s.Dir()); n != 2 {
		t.Errorf("%d files kept, want 2 (edge, small)", n)
	}
	assertNoParts(t, s.Dir())
}

type failing struct{}

func (failing) Read([]byte) (int, error) { return 0, errors.New("connection reset") }

// UT-upload-dir: the shared temp directory is checked before every upload
// (threat model T9).
func TestSaveRefusesUnsafeDirectory(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		base := t.TempDir()
		target := filepath.Join(base, "elsewhere")
		if err := os.Mkdir(target, 0o700); err != nil {
			t.Fatal(err)
		}
		root := filepath.Join(base, "webterm-x")
		if err := os.Symlink(target, root); err != nil {
			t.Fatal(err)
		}
		_, _, err := uploads.New(root).Save(bytes.NewReader(pngBytes), "a.png")
		if !errors.Is(err, uploads.ErrUnsafeDir) {
			t.Errorf("err = %v, want ErrUnsafeDir", err)
		}
		if des, _ := os.ReadDir(target); len(des) != 0 {
			t.Errorf("wrote %d entries through the symlink", len(des))
		}
	})
	t.Run("open to others", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "webterm-x")
		if err := os.Mkdir(root, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(root, 0o755); err != nil {
			t.Fatal(err)
		}
		_, _, err := uploads.New(root).Save(bytes.NewReader(pngBytes), "a.png")
		if !errors.Is(err, uploads.ErrUnsafeDir) || !strings.Contains(err.Error(), "0755") {
			t.Errorf("err = %v, want ErrUnsafeDir naming mode 0755", err)
		}
	})
	t.Run("a file", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "webterm-x")
		if err := os.WriteFile(root, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := uploads.New(root).Save(bytes.NewReader(pngBytes), "a.png"); !errors.Is(err, uploads.ErrUnsafeDir) {
			t.Errorf("err = %v, want ErrUnsafeDir", err)
		}
	})
	t.Run("another owner", func(t *testing.T) {
		if os.Getuid() == 0 {
			t.Skip("root owns everything")
		}
		// /usr exists and belongs to root.
		_, _, err := uploads.New("/usr").Save(bytes.NewReader(pngBytes), "a.png")
		if !errors.Is(err, uploads.ErrUnsafeDir) || !strings.Contains(err.Error(), "another user") {
			t.Errorf("err = %v, want ErrUnsafeDir naming the owner", err)
		}
	})
	t.Run("missing → created 0700", func(t *testing.T) {
		root := filepath.Join(t.TempDir(), "webterm-x")
		if _, _, err := uploads.New(root).Save(bytes.NewReader(pngBytes), "a.png"); err != nil {
			t.Fatal(err)
		}
		fi, _ := os.Lstat(root)
		if fi == nil || !fi.IsDir() || fi.Mode().Perm() != 0o700 {
			t.Errorf("root = %v", fi)
		}
	})
}

// UT-upload-sweep: age and total size (ADR-0051 §5).
func TestSweepByAge(t *testing.T) {
	now := time.Now()
	s, _ := newStore(t, uploads.WithClock(func() time.Time { return now }))
	if removed, err := s.Sweep(); err != nil || removed != 0 {
		t.Fatalf("sweep before any upload: %d, %v", removed, err)
	}
	old, _, _ := s.Save(bytes.NewReader(pngBytes), "old.png")
	fresh, _, _ := s.Save(bytes.NewReader(pngBytes), "fresh.png")
	part := filepath.Join(s.Dir(), "stale-abcdef.png.part")
	if err := os.WriteFile(part, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	livePart := filepath.Join(s.Dir(), "live-abcdef.png.part")
	if err := os.WriteFile(livePart, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	past := now.Add(-25 * time.Hour)
	for _, p := range []string{old, part} {
		if err := os.Chtimes(p, past, past); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := s.Sweep()
	if err != nil || removed != 2 {
		t.Errorf("sweep: removed %d, err %v; want 2", removed, err)
	}
	for p, want := range map[string]bool{old: false, part: false, fresh: true, livePart: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s exists = %v, want %v", filepath.Base(p), err == nil, want)
		}
	}
}

func TestTrimOldestFirst(t *testing.T) {
	size := int64(len(pngBytes))
	s, _ := newStore(t, uploads.WithLimits(1<<20, 3*size))
	var paths []string
	base := time.Now().Add(-time.Hour)
	for i := range 3 {
		p, _, err := s.Save(bytes.NewReader(pngBytes), "f.png")
		if err != nil {
			t.Fatal(err)
		}
		mt := base.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(p, mt, mt); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, p)
	}
	// The fourth pushes the total over 3 files: the oldest goes, the new one stays.
	newest, _, err := s.Save(bytes.NewReader(pngBytes), "f.png")
	if err != nil {
		t.Fatal(err)
	}
	for p, want := range map[string]bool{paths[0]: false, paths[1]: true, paths[2]: true, newest: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Errorf("%s exists = %v, want %v", filepath.Base(p), err == nil, want)
		}
	}
}

func TestSweepLeavesUnsafeDirectoryAlone(t *testing.T) {
	root := filepath.Join(t.TempDir(), "webterm-x")
	if err := os.MkdirAll(filepath.Join(root, "uploads"), 0o755); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(root, "uploads", "someone-elses.png")
	if err := os.WriteFile(victim, pngBytes, 0o644); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-48 * time.Hour)
	_ = os.Chtimes(victim, past, past)
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := uploads.New(root).Sweep(); !errors.Is(err, uploads.ErrUnsafeDir) {
		t.Errorf("err = %v, want ErrUnsafeDir", err)
	}
	if _, err := os.Stat(victim); err != nil {
		t.Error("sweep deleted a file in a directory it doesn't trust")
	}
}

func countFiles(t *testing.T, dir string) int {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return len(des)
}

func assertNoParts(t *testing.T, dir string) {
	t.Helper()
	des, _ := os.ReadDir(dir)
	for _, de := range des {
		if strings.HasSuffix(de.Name(), ".part") {
			t.Errorf("leftover %s", de.Name())
		}
	}
}
