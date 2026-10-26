// OrangeSpeakEasy 的 Windows 安装程序（OrangeSpeakEasy-Setup-x64.exe）：双击就装好，装完打开 App 进首次引导。
//
// 它身上带着这个版本的整棵程序（见 payload.go），解到临时目录，再让程序里自带的 install.ps1 从那里装
// （ORANGESPEAKEASY_INSTALL_FROM，它拷进 versions 下的新目录）：怎么装只有 install.ps1 这一份，和 PowerShell 里
// irm | iex 那一行装出来的一模一样，装的时候也不用联网。
// 控制台程序：安装的进度就是 install.ps1 打的那几行。出错时停住等按回车，免得窗口一闪就没了，看不到原因。
// 第一次安装时用系统的对话框问装在哪（ask_windows.go）。依赖只有解 zstd 的 klauspost/compress、弹系统对话框的
// ncruces/zenity（MIT，纯 Go 调 Win32）和它用的 golang.org/x/sys；图标、版本信息和清单（asInvoker：不要管理员权限，不然名字里带 Setup 会被 Windows 自动要求提权）
// 由 scripts/build/windows-setup.mjs 编译时用 go-winres 生成。
package main

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// 和 src/update/home.mjs 跑 install.ps1 的写法一样：按 UTF-8 读进来当脚本块跑
// （直接 -File 的话，Windows PowerShell 5.1 把没有 BOM 的脚本当成系统编码读）
const runInstall = "& ([scriptblock]::Create([IO.File]::ReadAllText($env:ORANGESPEAKEASY_INSTALL_SCRIPT, [Text.Encoding]::UTF8))); exit $LASTEXITCODE"

func main() {
	setTitle("OrangeSpeakEasy Setup")
	code := install()
	if code != 0 {
		fmt.Print("\n  Press Enter to close this window.")
		bufio.NewReader(os.Stdin).ReadString('\n')
	}
	os.Exit(code)
}

func install() int {
	// 先定好装在哪（home.go）：第一次安装要问一句，问完再花时间解包
	choice, err := resolveHome(os.Getenv, askWhere)
	if errors.Is(err, errCanceled) {
		fmt.Printf("\n  %s\n", uiWords().cancelled)
		return 0
	}
	if err != nil {
		fmt.Printf("\n  x %v\n", err)
		return 1
	}
	dir, err := unpack()
	if dir != "" {
		defer removeTemp(dir)
	}
	if err != nil {
		fmt.Printf("\n  x %v\n", err)
		return 1
	}
	script := filepath.Join(dir, "app", "install.ps1")
	if _, err := os.Stat(script); err != nil {
		fmt.Printf("\n  x This setup file is damaged (%v); download it again.\n", err)
		return 1
	}
	cmd := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", runInstall)
	cmd.Env = append(withoutHome(os.Environ()),
		"ORANGESPEAKEASY_INSTALL_SCRIPT="+script,
		"ORANGESPEAKEASY_INSTALL_FROM="+dir,
		// 装完由这里打开 App；install.ps1 自己启动的是命令行那一份，会在终端里问 key
		"ORANGESPEAKEASY_NO_START=1",
	)
	// 装在哪明确告诉 install.ps1，装完打开的就是同一个：第一次安装选了别处的交给 ORANGESPEAKEASY_INSTALL_DIR（它记进定位文件），
	// 别的就是这一次用的目录
	if choice.installDir != "" {
		cmd.Env = append(cmd.Env, "ORANGESPEAKEASY_INSTALL_DIR="+choice.installDir)
	} else {
		cmd.Env = append(cmd.Env, "ORANGESPEAKEASY_HOME="+choice.home)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode()
		}
		fmt.Printf("\n  x Couldn't run Windows PowerShell: %v\n", err)
		return 1
	}

	if err := openApp(choice.home); err != nil {
		fmt.Printf("  Couldn't open OrangeSpeakEasy (%v). Open it from the Start menu.\n", err)
		return 0
	}
	fmt.Println("  Opening OrangeSpeakEasy…")
	// 留一会儿让人看见装好了，再关窗口
	time.Sleep(3 * time.Second)
	return 0
}

// withoutHome 去掉环境里的 ORANGESPEAKEASY_HOME、ORANGESPEAKEASY_INSTALL_DIR：由 resolveHome 定下的那一个交给 install.ps1
func withoutHome(env []string) []string {
	kept := env[:0:0]
	for _, entry := range env {
		name := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if name == "ORANGESPEAKEASY_HOME" || name == "ORANGESPEAKEASY_INSTALL_DIR" {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}

// errCanceled 第一次安装时问装在哪，点了"取消"
var errCanceled = errors.New("canceled")

// askInConsole 在控制台里问装在哪个文件夹下：回车就是默认位置。不是在控制台里跑的（脚本调的）不问，用默认位置。
// 对话框弹不出来时（ask_windows.go）退到这里
func askInConsole(defaultHome string, w words) (string, error) {
	if !stdinIsConsole() {
		return "", nil
	}
	fmt.Println()
	fmt.Println("  " + w.consoleIntro)
	fmt.Printf("  "+w.consoleEnter+"\n", defaultHome)
	fmt.Print("  " + w.consoleType)
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadString('\n')
		if strings.TrimSpace(line) == "" {
			return "", nil
		}
		folder, problem := checkFolderAnswer(line, w)
		if problem == "" {
			return folder, nil
		}
		if err != nil {
			return "", fmt.Errorf("%s", problem)
		}
		fmt.Printf("  %s\n  %s", problem, w.consoleFolder)
	}
}

// removeTemp 删掉解包用的临时目录。里面刚写出来的程序杀毒软件可能还在扫，扫完之前删不掉：
// 隔一秒再试，试十次；还删不掉就照实说在哪，不悄悄留下约 400 MB
func removeTemp(dir string) {
	var err error
	for range 10 {
		if err = os.RemoveAll(dir); err == nil {
			return
		}
		time.Sleep(time.Second)
	}
	fmt.Printf("  Couldn't remove the temporary folder %s (%v); it's safe to delete it yourself.\n", dir, err)
}

// unpack 把身上带的东西解到一个新的临时目录，交出那个目录（出错时也交出来，好让调用的人删掉）
func unpack() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	f, err := os.Open(self)
	if err != nil {
		return "", err
	}
	defer f.Close()
	payload, err := openPayload(f)
	if err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp("", "orangespeakeasy-setup-")
	if err != nil {
		return "", err
	}
	return dir, extract(payload, dir)
}
