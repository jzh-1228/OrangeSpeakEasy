package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 一台假的电脑：用户目录、LOCALAPPDATA 都在临时目录里
type machine struct {
	profile string
	local   string
	env     map[string]string
}

func newMachine(t *testing.T) *machine {
	root := t.TempDir()
	m := &machine{profile: filepath.Join(root, "profile"), local: filepath.Join(root, "local"), env: map[string]string{}}
	for _, dir := range []string{m.profile, m.local} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	m.env["USERPROFILE"] = m.profile
	m.env["LOCALAPPDATA"] = m.local
	return m
}

func (m *machine) getenv(name string) string { return m.env[name] }

func (m *machine) writeLocation(t *testing.T, text string) {
	dir := filepath.Join(m.local, "OrangeSpeakEasy")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "location.json"), []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func noAsk(t *testing.T) func(string) (string, error) {
	return func(string) (string, error) {
		t.Fatal("不该问装在哪")
		return "", nil
	}
}

func TestHomeFromEnvironmentWins(t *testing.T) {
	m := newMachine(t)
	m.env["ORANGESPEAKEASY_HOME"] = filepath.Join(m.profile, "custom")
	m.writeLocation(t, `{"home": "elsewhere"}`)
	choice, err := resolveHome(m.getenv, noAsk(t))
	if err != nil || choice.home != m.env["ORANGESPEAKEASY_HOME"] || choice.installDir != "" {
		t.Fatalf("got %+v %v", choice, err)
	}
}

func TestHomeFromLocationFile(t *testing.T) {
	m := newMachine(t)
	home := filepath.Join(m.profile, "Data", ".orangespeakeasy")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	// PowerShell 5.1 写 UTF-8 时常带 BOM：也认
	quoted := strings.ReplaceAll(home, `\`, `\\`)
	m.writeLocation(t, "\uFEFF{\r\n  \"home\": \""+quoted+"\"\r\n}\r\n")
	choice, err := resolveHome(m.getenv, noAsk(t))
	if err != nil || choice.home != home {
		t.Fatalf("got %+v %v", choice, err)
	}
}

func TestLocationFileMissingFolderIsAnError(t *testing.T) {
	m := newMachine(t)
	missing := filepath.Join(m.profile, "unplugged", ".orangespeakeasy")
	m.writeLocation(t, `{"home": "`+strings.ReplaceAll(missing, `\`, `\\`)+`"}`)
	_, err := resolveHome(m.getenv, noAsk(t))
	if err == nil || !strings.Contains(err.Error(), "Can't find the OrangeSpeakEasy folder") {
		t.Fatalf("want a can't-find error, got %v", err)
	}
	if _, statErr := os.Stat(missing); statErr == nil {
		t.Fatal("不该建出来")
	}
}

func TestBrokenLocationFileIsAnError(t *testing.T) {
	m := newMachine(t)
	for _, text := range []string{"{ 坏了", `{"home": "relative"}`, `{"other": 1}`, `{"home": ""}`} {
		m.writeLocation(t, text)
		if _, err := resolveHome(m.getenv, noAsk(t)); err == nil || !strings.Contains(err.Error(), "location file is invalid") {
			t.Fatalf("%q: want invalid, got %v", text, err)
		}
	}
}

func TestDefaultHomeInUseIsAnUpgrade(t *testing.T) {
	m := newMachine(t)
	home := filepath.Join(m.profile, ".orangespeakeasy")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "current"), []byte("0.11.0-1a2b3c4d"), 0o600); err != nil {
		t.Fatal(err)
	}
	choice, err := resolveHome(m.getenv, noAsk(t))
	if err != nil || choice.home != home || choice.installDir != "" {
		t.Fatalf("got %+v %v", choice, err)
	}
}

func TestFirstInstallAsksWhere(t *testing.T) {
	m := newMachine(t)
	defaultHome := filepath.Join(m.profile, ".orangespeakeasy")
	// 直接回车：默认位置
	choice, err := resolveHome(m.getenv, func(offered string) (string, error) {
		if offered != defaultHome {
			t.Fatalf("offered %q", offered)
		}
		return "", nil
	})
	if err != nil || choice.home != defaultHome || choice.installDir != "" {
		t.Fatalf("got %+v %v", choice, err)
	}
	// 选了别的文件夹：装进它里面的 .orangespeakeasy，交给 install.ps1 记进定位文件
	folder := filepath.Join(m.profile, "Apps")
	choice, err = resolveHome(m.getenv, func(string) (string, error) { return folder, nil })
	if err != nil || choice.home != filepath.Join(folder, ".orangespeakeasy") || choice.installDir != folder {
		t.Fatalf("got %+v %v", choice, err)
	}
	// 选的就是一个 .orangespeakeasy：用它本身，不再套一层
	chosen := filepath.Join(m.profile, "Apps", ".orangespeakeasy")
	choice, err = resolveHome(m.getenv, func(string) (string, error) { return chosen, nil })
	if err != nil || choice.home != chosen || choice.installDir != chosen {
		t.Fatalf("got %+v %v", choice, err)
	}
}

func TestCheckFolderAnswer(t *testing.T) {
	m := newMachine(t)
	existing := filepath.Join(m.profile, "My Apps")
	if err := os.MkdirAll(existing, 0o700); err != nil {
		t.Fatal(err)
	}
	// 资源管理器"复制为路径"带着引号，前后可能有空格
	for _, typed := range []string{existing, `"` + existing + `"`, "  " + existing + "  "} {
		if folder, problem := checkFolderAnswer(typed, english); problem != "" || folder != existing {
			t.Fatalf("%q: got %q %q", typed, folder, problem)
		}
	}
	taken := filepath.Join(m.profile, "Taken")
	if err := os.MkdirAll(filepath.Join(taken, ".orangespeakeasy"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taken, ".orangespeakeasy", "notes.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for typed, want := range map[string]string{
		"relative":                       "full path",
		filepath.Join(m.profile, "nope"): "doesn't exist",
		filepath.Join(existing, strings.Repeat("x", 130)): "too long",
		taken: "already has other things",
	} {
		if _, problem := checkFolderAnswer(typed, english); !strings.Contains(problem, want) {
			t.Fatalf("%q: want %q, got %q", typed, want, problem)
		}
	}
}

// 长度按字符数算（和 install.ps1、orangespeakeasy move 一样）：中文一个字三个字节，按字节算会多拦
func TestCheckFolderAnswerCountsCharacters(t *testing.T) {
	// t.TempDir() 带着测试名，太长；放在短一些的临时目录里
	short := os.TempDir()
	if runtime.GOOS != "windows" {
		short = "/tmp"
	}
	base, err := os.MkdirTemp(short, "sm-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(base) })
	room := maxHomeChars - len([]rune(base)) - len([]rune(`\.orangespeakeasy`)) - 1
	folder := filepath.Join(base, strings.Repeat("语", room))
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	if got, problem := checkFolderAnswer(folder, english); problem != "" || got != folder {
		t.Fatalf("%d 个字符（%d 个字节）的文件夹被拦了：%q", len([]rune(homeIn(folder))), len(homeIn(folder)), problem)
	}
}

func TestReuseOldHome(t *testing.T) {
	m := newMachine(t)
	old := filepath.Join(m.profile, "Old")
	if err := os.MkdirAll(filepath.Join(old, ".orangespeakeasy", "data"), 0o700); err != nil {
		t.Fatal(err)
	}
	if folder, problem := checkFolderAnswer(old, english); problem != "" || folder != old {
		t.Fatalf("got %q %q", folder, problem)
	}
}

func TestWordsFollowTheDisplayLanguage(t *testing.T) {
	// 0x0804 简体中文、0x0404 繁体中文、0x0409 英语（美国）、0x0411 日语
	for lang, want := range map[uint16]string{0x0804: chinese.title, 0x0404: chinese.title, 0x0409: english.title, 0x0411: english.title} {
		if got := wordsFor(lang).title; got != want {
			t.Fatalf("%#x: got %q", lang, got)
		}
	}
	if len(english.question) == 0 || len(chinese.question) == 0 {
		t.Fatal("empty question")
	}
}
