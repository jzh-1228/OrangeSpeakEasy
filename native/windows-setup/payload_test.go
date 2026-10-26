package main

import (
	"archive/tar"
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// fakeSetup 照 scripts/build/windows-setup.mjs 的拼法做一个假的安装程序：前面一段"程序"，后面接 zstd 压的 tar 和记号
func fakeSetup(t *testing.T, entries []tar.Header, contents map[string]string, mangle func([]byte) []byte) string {
	t.Helper()
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	for _, header := range entries {
		header := header
		body := contents[header.Name]
		header.Size = int64(len(body))
		header.Mode = 0o644
		if err := tw.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
		tw.Write([]byte(body))
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	var payload bytes.Buffer
	zw, err := zstd.NewWriter(&payload)
	if err != nil {
		t.Fatal(err)
	}
	zw.Write(archive.Bytes())
	zw.Close()
	trailer := make([]byte, trailerSize)
	copy(trailer, magic)
	binary.LittleEndian.PutUint64(trailer[len(magic):], uint64(payload.Len()))
	data := append(append([]byte("MZ 程序本身"), payload.Bytes()...), trailer...)
	if mangle != nil {
		data = mangle(data)
	}
	path := filepath.Join(t.TempDir(), "OrangeSpeakEasy-Setup-x64.exe")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func file(name string) tar.Header { return tar.Header{Name: name, Typeflag: tar.TypeReg} }
func dir(name string) tar.Header  { return tar.Header{Name: name, Typeflag: tar.TypeDir} }

func unpackFile(t *testing.T, path string, into string) error {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	r, err := openPayload(f)
	if err != nil {
		return err
	}
	return extract(r, into)
}

func TestPayloadUnpacksTheTree(t *testing.T) {
	path := fakeSetup(t,
		[]tar.Header{dir("app/"), file("app/install.ps1"), dir("app/bin/"), file("app/bin/orangespeakeasy.mjs"), file("runtime/electron.exe")},
		map[string]string{"app/install.ps1": "& { 'hi' }", "app/bin/orangespeakeasy.mjs": "js", "runtime/electron.exe": "MZ"},
		nil)
	into := t.TempDir()
	if err := unpackFile(t, path, into); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"app/install.ps1": "& { 'hi' }", "runtime/electron.exe": "MZ"} {
		got, err := os.ReadFile(filepath.Join(into, filepath.FromSlash(name)))
		if err != nil || string(got) != want {
			t.Fatalf("%s: got %q, %v", name, got, err)
		}
	}
}

func TestPlainExeWithoutPayloadIsRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "plain.exe")
	os.WriteFile(path, []byte("MZ 一个普通的程序，后面什么都没接"), 0o644)
	if err := unpackFile(t, path, t.TempDir()); err != errNoPayload {
		t.Fatalf("got %v", err)
	}
}

func TestTruncatedDownloadIsRejected(t *testing.T) {
	// 下载断在中间：记号还在最后（下了一半的文件没有记号），这里模拟长度对不上
	path := fakeSetup(t, []tar.Header{file("app/x")}, map[string]string{"app/x": "x"}, func(data []byte) []byte {
		return append(data[:10], data[len(data)-trailerSize:]...)
	})
	if err := unpackFile(t, path, t.TempDir()); err == nil {
		t.Fatal("长度对不上的包被当成好的")
	}
}

func TestDamagedPayloadIsRejected(t *testing.T) {
	path := fakeSetup(t, []tar.Header{file("app/x")}, map[string]string{"app/x": "some content here"}, func(data []byte) []byte {
		// 压着的那段中间改坏一个字节
		data[len("MZ 程序本身")+8] ^= 0xff
		return data
	})
	if err := unpackFile(t, path, t.TempDir()); err == nil {
		t.Fatal("坏了的包被解开了")
	}
}

func TestPathsOutsideTheDirectoryAndLinksAreRefused(t *testing.T) {
	escape := fakeSetup(t, []tar.Header{file("../escape.txt")}, map[string]string{"../escape.txt": "x"}, nil)
	if err := unpackFile(t, escape, t.TempDir()); err == nil {
		t.Fatal("../ 开头的路径被解出来了")
	}
	link := fakeSetup(t, []tar.Header{{Name: "app/link", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}}, nil, nil)
	if err := unpackFile(t, link, t.TempDir()); err == nil {
		t.Fatal("符号链接被解出来了")
	}
}
