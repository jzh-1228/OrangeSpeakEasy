package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

// 装在哪：和 install.ps1 同一个顺序，先在这里定好，再明确交给它（装完打开的也就是同一个）。
//   1. ORANGESPEAKEASY_HOME：这一次就用它
//   2. 定位文件 %LOCALAPPDATA%\OrangeSpeakEasy\location.json（装在默认位置以外的才有，src/storage/location.mjs）
//   3. 默认位置 %USERPROFILE%\.orangespeakeasy 已经有一份：升级它
//   4. 都没有是第一次安装：问装在哪（系统的对话框，ask_windows.go），默认位置一键就装
// 定位文件坏了、它说的目录不在（移动硬盘没接）都停下说清楚，不悄悄装到别处去。

// maxHomeChars 和 install.ps1 的 $MaxHomeChars 一样：PowerShell 5.1 解包、拷贝受 260 个字符的限制
const maxHomeChars = 120

type homeChoice struct {
	// home 装进哪个目录
	home string
	// installDir 第一次安装选了默认位置以外的文件夹：交给 install.ps1 的 ORANGESPEAKEASY_INSTALL_DIR，
	// 它装进这个文件夹里的 .orangespeakeasy 并记进定位文件
	installDir string
}

func localAppData(getenv func(string) string) string {
	if dir := getenv("LOCALAPPDATA"); dir != "" {
		return dir
	}
	return filepath.Join(getenv("USERPROFILE"), "AppData", "Local")
}

// locationFile 和 src/storage/location.mjs 的 locationFileOf 是同一个位置
func locationFile(getenv func(string) string) string {
	return filepath.Join(localAppData(getenv), "OrangeSpeakEasy", "location.json")
}

// readLocation 定位文件说的家目录；没有这个文件是空字符串
func readLocation(file string) (string, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("can't read OrangeSpeakEasy's location file %s (%v)", file, err)
	}
	var record struct {
		Home *string `json:"home"`
	}
	data = bytes.TrimPrefix(data, []byte("\xEF\xBB\xBF"))
	if json.Unmarshal(data, &record) != nil || record.Home == nil || !filepath.IsAbs(*record.Home) ||
		strings.ContainsFunc(*record.Home, func(r rune) bool { return r < 0x20 }) {
		return "", fmt.Errorf("OrangeSpeakEasy's location file is invalid: %s\n    It should hold the full path of the OrangeSpeakEasy folder. Delete it to use the default place", file)
	}
	return filepath.Clean(*record.Home), nil
}

// hasContents 这个目录里有没有东西（装过、用过）
func hasContents(dir string) bool {
	entries, err := os.ReadDir(dir)
	return err == nil && len(entries) > 0
}

// homeIn 选的文件夹里装进哪：它里面的 .orangespeakeasy；选的就是一个 .orangespeakeasy 的话就用它本身
func homeIn(folder string) string {
	if strings.EqualFold(filepath.Base(folder), ".orangespeakeasy") {
		return folder
	}
	return filepath.Join(folder, ".orangespeakeasy")
}

// resolveHome 定下装在哪。ask 只在第一次安装时调：交给它默认位置，它交回选的文件夹（空的是默认位置）
func resolveHome(getenv func(string) string, ask func(defaultHome string) (string, error)) (homeChoice, error) {
	if home := getenv("ORANGESPEAKEASY_HOME"); home != "" {
		return homeChoice{home: home}, nil
	}
	file := locationFile(getenv)
	located, err := readLocation(file)
	if err != nil {
		return homeChoice{}, err
	}
	if located != "" {
		if info, statErr := os.Stat(located); statErr != nil || !info.IsDir() {
			return homeChoice{}, fmt.Errorf("Can't find the OrangeSpeakEasy folder: %s\n    If it's on an external drive, connect the drive and run this again.\n    If you no longer use that place, delete %s to install to the default one", located, file)
		}
		return homeChoice{home: located}, nil
	}
	defaultHome := filepath.Join(getenv("USERPROFILE"), ".orangespeakeasy")
	if hasContents(defaultHome) {
		return homeChoice{home: defaultHome}, nil
	}
	folder, err := ask(defaultHome)
	if err != nil {
		return homeChoice{}, err
	}
	if folder == "" || strings.EqualFold(filepath.Clean(homeIn(folder)), filepath.Clean(defaultHome)) {
		return homeChoice{home: defaultHome}, nil
	}
	return homeChoice{home: homeIn(folder), installDir: folder}, nil
}

// usedBefore 这个目录 OrangeSpeakEasy 用过（重装系统前放在别的盘上的那种）：选到它时沿用里面的东西
func usedBefore(home string) bool {
	for _, name := range []string{"settings.json", "data", "models", "versions"} {
		if _, err := os.Stat(filepath.Join(home, name)); err == nil {
			return true
		}
	}
	return false
}

// checkFolderAnswer 看看用户选的、敲进来的文件夹能不能用：交回整理好的路径，或者不能用的原因（给人看的一句话）。
// 和 install.ps1 的 Test-Place 是同一套规矩：那边还会再查一遍
func checkFolderAnswer(typed string, w words) (string, string) {
	// 资源管理器里"复制为路径"带着引号
	folder := strings.Trim(strings.TrimSpace(typed), `"`)
	if !filepath.IsAbs(folder) {
		return "", w.notFull
	}
	folder = filepath.Clean(folder)
	home := homeIn(folder)
	// 按字符数（UTF-16）算，和 install.ps1 的 .Length、orangespeakeasy move 一样：len 是字节数，中文一个字算三个
	if len(utf16.Encode([]rune(home))) > maxHomeChars {
		return "", fmt.Sprintf(w.tooLong, maxHomeChars-len(`\.orangespeakeasy`))
	}
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		return "", w.missing
	}
	if hasContents(home) && !usedBefore(home) {
		return "", fmt.Sprintf(w.notEmpty, home)
	}
	// 家目录要能设成只有自己能进（访问控制表）：FAT32、exFAT 没有这个
	if format := diskFormat(folder); format != "" && !strings.EqualFold(format, "NTFS") && !strings.EqualFold(format, "ReFS") {
		return "", fmt.Sprintf(w.format, format)
	}
	// 写得进去（Program Files 这类要管理员权限的地方写不进）
	probe, err := os.CreateTemp(folder, ".orangespeakeasy-probe-")
	if err != nil {
		return "", w.unwritable
	}
	probe.Close()
	os.Remove(probe.Name())
	return folder, ""
}
