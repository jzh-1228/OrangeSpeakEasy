package main

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"unsafe"
)

// openApp 打开装好的 App：和开始菜单的快捷方式一样，用 current 指着的那个版本的 Electron 跑它的 app 目录，
// 工作目录是家目录。不等它：安装程序关掉之后 App 照常开着
func openApp(home string) error {
	exe, app, err := installedApp(home)
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, app)
	cmd.Dir = home
	cmd.Env = appEnv(os.Environ())
	// DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP：不挂在安装程序的控制台上
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// appEnv 去掉只给安装用的环境变量，App 看到的和从开始菜单打开时一样
func appEnv(env []string) []string {
	kept := env[:0:0]
	for _, entry := range env {
		name := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		if strings.HasPrefix(name, "ORANGESPEAKEASY_INSTALL_") || name == "ORANGESPEAKEASY_VERSION" || name == "ORANGESPEAKEASY_NO_START" || name == "ELECTRON_RUN_AS_NODE" {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}

// stdinIsConsole 标准输入是不是控制台（双击打开的是；被脚本调、输入被重定向的不是，那时不问问题）
func stdinIsConsole() bool {
	var mode uint32
	return syscall.GetConsoleMode(syscall.Handle(os.Stdin.Fd()), &mode) == nil
}

func setTitle(title string) {
	text, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	// 只是窗口标题，设不上也不影响安装
	syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleTitleW").Call(uintptr(unsafe.Pointer(text)))
}
