package main

// 入口和线程：低级钩子的回调由装它的那个线程在取消息时调用，剪贴板也要一个窗口当主人，所以这些都放在
// 同一个锁定的系统线程上跑一个消息循环。读标准输入、写标准输出各是一个 goroutine：要在钩子线程上做的事
// 经 tasks 交过去、再投一条消息叫醒它；钩子回调里不做任何会等的事（系统嫌慢会悄悄卸掉钩子）。
// 录键（record.go）接在匹配器前面，钩子回调把键先交给它。probe 的试登记也在这个线程上做（见 probe）。
// 同一个消息窗口还收三样系统通知（docs/hotkey-research.md 4.2）：
//   睡眠唤醒、锁屏解锁、切换用户  钩子可能在睡眠中被悄悄卸掉、松开的事件也丢了：回来以后重装钩子，从头认
//   前台换了窗口                  前台是以管理员身份运行的窗口时，钩子收不到发给它的按键，报 elevated_foreground 让父进程提示

import (
	"bufio"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

// 模拟粘贴之后等多久再还原剪贴板：太短的话目标应用还没来得及读（同 macOS 版）
const restoreDelay = 300 * time.Millisecond

// 一次录音最长 9 分钟。截了这么久父进程还没说"不截了"，多半是它那边出了岔子：自己松开，
// 不能让取消用的键（esc）在所有应用里一直按不出来
const captureLimit = 600 * time.Second

// 录键最长 30 秒。录了这么久父进程还没说"停"，多半是它那边出了岔子：自己停，不能让录到的键一直被吞着
const recordLimit = 30 * time.Second

// 试登记用的热键号：只在 probe 里登记一下、马上注销，同一时刻只有这一个
const probeHotkeyID = 1

const wmTask = wmApp + 1

var (
	out   = newOutbox(256)
	tasks taskQueue

	// 键盘钩子装上没有：没装上时 bind 的绑定一个都装不了。main 里定下来以后才开始读标准输入
	listening bool
	// 热键匹配、录键和点击的截取：只在钩子线程上碰，不加锁
	hotkeys      = newMatcher(keyStillDown)
	recording    = newRecorder(hotkeys)
	clicks       clickCapture
	board        *clipboard
	window       uintptr
	keyboardHook uintptr
	mouseHook    uintptr
	// 截的期限、录键的期限：每次开始换一个号，过期的那个不算数
	captureGeneration int
	recordGeneration  int
)

func emit(e event) { out.send(e) }

// 交给钩子线程去做
func onUIThread(task func()) {
	tasks.push(task)
	procPostMessageW.Call(window, wmTask, 0, 0)
}

// 交给钩子线程做，等它做完（别在钩子线程上调）
func onUIThreadWait(task func()) {
	done := make(chan struct{})
	onUIThread(func() {
		defer close(done)
		task()
	})
	<-done
}

// 系统说这个键还按着没有（matcher 核对按住的普通键时问）。钩子回调发生在系统更新键的状态之前，
// 查不准正触发回调的这个键；matcher 只拿它查早先按下的别的键。vk 为 0 的键查不了，当它还按着，只靠 10 秒清
func keyStillDown(_ keyID, key heldKey) bool {
	if key.vk == 0 {
		return true
	}
	state, _, _ := procGetAsyncKeyState.Call(uintptr(key.vk))
	return state&0x8000 != 0
}

// 只带了 vk、扫描码是 0 的模拟按键：照 vk 查一个扫描码（MAPVK_VK_TO_VSC_EX 的高字节是 0xE0、0xE1 时是扩展键）
func scanOfVK(vk uint32) (uint32, bool) {
	code, _, _ := procMapVirtualKeyW.Call(uintptr(vk), mapvkVKToVSCEx)
	prefix := code >> 8 & 0xFF
	return uint32(code) & 0xFF, prefix == 0xE0 || prefix == 0xE1
}

func keyboardProc(code int32, wParam, lParam uintptr) uintptr {
	if code >= 0 {
		info := (*kbdLLHookStruct)(unsafe.Pointer(lParam))
		down := wParam == wmKeyDown || wParam == wmSysKeyDown
		if down || wParam == wmKeyUp || wParam == wmSysKeyUp {
			in := normalize(keyInput{vk: info.vkCode, scan: info.scanCode, extended: info.flags&llkhfExtended != 0,
				down: down, ours: info.extraInfo == ourMark, time: info.time}, scanOfVK)
			result := recording.onKey(in)
			report(result)
			if result.mask {
				// 就在回调里插（AutoHotkey、handy-keys 也是）。在 Alt、Win 自己按下的回调里插，效果和插在它前面一样（记事本实测），
				// 所以匹配器不在那一下要掩码（见 matcher.settleMask）。交回消息循环再插的话，消息循环先处理的是钩子回调，
				// 快速点按时松开可能抢在掩码前面
				sendKeys([]uint16{vkMask, vkMask}, []bool{true, false})
			}
			if result.swallow {
				return 1
			}
		}
	}
	next, _, _ := procCallNextHookEx.Call(0, uintptr(code), wParam, lParam)
	return next
}

func mouseProc(code int32, wParam, lParam uintptr) uintptr {
	if code >= 0 && (wParam == wmLButtonDown || wParam == wmLButtonUp) {
		info := (*msLLHookStruct)(unsafe.Pointer(lParam))
		if info.extraInfo != ourMark {
			result := clicks.onLeftButton(wParam == wmLButtonDown, float64(info.x), float64(info.y))
			report(result)
			if !clicks.wantsHook() {
				// 不能在自己的回调里把自己卸掉：回到消息循环里再卸
				onUIThread(settleMouseHook)
			}
			if result.swallow {
				return 1
			}
		}
	}
	next, _, _ := procCallNextHookEx.Call(0, uintptr(code), wParam, lParam)
	return next
}

func report(result outcome) {
	for _, e := range result.events {
		emit(e)
	}
}

// 交给系统的回调。在 init 里建：鼠标的回调要装卸它自己，写成包级变量的初始值会成环
var keyboardCallback, mouseCallback, windowCallback, foregroundCallback uintptr

func init() {
	keyboardCallback = syscall.NewCallback(func(code, wParam, lParam uintptr) uintptr {
		return keyboardProc(int32(code), wParam, lParam)
	})
	mouseCallback = syscall.NewCallback(func(code, wParam, lParam uintptr) uintptr {
		return mouseProc(int32(code), wParam, lParam)
	})
	windowCallback = syscall.NewCallback(windowProc)
	foregroundCallback = syscall.NewCallback(func(_, _, hwnd, _, _, _, _ uintptr) uintptr {
		onForeground(hwnd)
		return 0
	})
}

func installHook(kind int, callback uintptr) uintptr {
	module, _, _ := procGetModuleHandleW.Call(0)
	hook, _, _ := procSetWindowsHookExW.Call(uintptr(kind), callback, module, 0)
	return hook
}

// 重装键盘钩子，从头认（睡眠唤醒、解锁、切回这个用户以后）：Windows 睡眠时可能悄悄卸掉低级钩子
// （handy-keys listener.rs 的注释），这段时间的松开也丢了。先装新的再卸旧的，中间不漏键；装不上就留着旧的
func relisten(reason string) {
	if keyboardHook == 0 {
		return
	}
	fresh := installHook(whKeyboardLL, keyboardCallback)
	if fresh == 0 {
		emit(event{"event": "error", "message": "重装键盘钩子失败（" + reason + "），热键可能不灵了：重启 OrangeSpeakEasy 试试"})
		return
	}
	procUnhookWindowsHookEx.Call(keyboardHook)
	keyboardHook = fresh
	for _, e := range recording.reset() {
		emit(e)
	}
	emit(event{"event": "relistened", "reason": reason})
}

// 睡下去、锁屏、切走：按着的绑定补报松开、录着的集合清空（之后它们的松开到不了）。回来时 relisten
func pauseListening() {
	for _, e := range recording.reset() {
		emit(e)
	}
}

// 前台窗口是不是以管理员身份运行的：变了才报。我们自己以管理员身份运行时不用盯（watchForeground 不装）
var foregroundElevated bool

func onForeground(hwnd uintptr) {
	elevated, pid := windowBlocksInput(hwnd)
	if elevated == foregroundElevated {
		return
	}
	foregroundElevated = elevated
	if elevated {
		emit(event{"event": "elevated_foreground", "on": true, "pid": pid})
	} else {
		emit(event{"event": "elevated_foreground", "on": false})
	}
}

// 收三样系统通知（见文件开头）。登记不上的照实报，不影响热键本身
func watchSystem() {
	if ok, _, _ := procWTSRegisterSessionNotification.Call(window, notifyForThisSession); ok == 0 {
		emit(event{"event": "error", "message": "登记不上锁屏解锁的通知：解锁后热键要是不灵，重启 OrangeSpeakEasy"})
	}
	if handle, _, _ := procRegisterSuspendResumeNotification.Call(window, deviceNotifyWindowHandle); handle == 0 {
		emit(event{"event": "error", "message": "登记不上睡眠唤醒的通知：唤醒后热键要是不灵，重启 OrangeSpeakEasy"})
	}
	self, _, _ := procGetCurrentProcess.Call()
	if processElevated(self) {
		return
	}
	if hook, _, _ := procSetWinEventHook.Call(eventSystemForeground, eventSystemForeground, 0, foregroundCallback, 0, 0,
		wineventOutOfContext); hook == 0 {
		emit(event{"event": "error", "message": "盯不了前台窗口：管理员窗口在前台时没法提示热键用不了"})
		return
	}
	foreground, _, _ := procGetForegroundWindow.Call()
	onForeground(foreground)
}

// 鼠标钩子只在要截的时候装着：装着时全系统每一下鼠标都要先过我们这里
func settleMouseHook() {
	if clicks.wantsHook() && mouseHook == 0 {
		mouseHook = installHook(whMouseLL, mouseCallback)
		if mouseHook == 0 {
			emit(event{"event": "error", "message": "装不上鼠标钩子，悬浮条上的按钮点不了"})
		}
	} else if !clicks.wantsHook() && mouseHook != 0 {
		procUnhookWindowsHookEx.Call(mouseHook)
		mouseHook = 0
	}
}

// 截不截同时管两样：只在截着时生效的绑定（取消），和悬浮条、划词卡片上的点击。
// outside：块外的按下要不要报（划词卡片的"点别处收起"），见 capture.go
func setCapturing(on bool, regions []region, outside bool) {
	captureGeneration++
	hotkeys.setCapturing(on)
	clicks.setCapturing(on, regions, outside)
	settleMouseHook()
	if !on {
		return
	}
	generation := captureGeneration
	time.AfterFunc(captureLimit, func() {
		onUIThread(func() {
			if generation != captureGeneration || !clicks.capturing {
				return
			}
			emit(event{"event": "error", "message": fmt.Sprintf("截了 %d 秒还没人说不截了，自己松开", int(captureLimit.Seconds()))})
			setCapturing(false, nil, false)
		})
	})
}

// 进入或离开录键模式。进入时开始计 30 秒，再进入一次从头计
func setRecording(on bool) {
	recordGeneration++
	for _, e := range recording.record(on) {
		emit(e)
	}
	if !on {
		return
	}
	generation := recordGeneration
	time.AfterFunc(recordLimit, func() {
		onUIThread(func() {
			if generation != recordGeneration || !recording.on {
				return
			}
			emit(event{"event": "error", "message": fmt.Sprintf("录了 %d 秒还没录完，自己停了", int(recordLimit.Seconds()))})
			setRecording(false)
		})
	})
}

// 试登记一次这个组合，看是不是已经被别的程序用 RegisterHotKey 登记了（docs/hotkey-research.md 4.2、5.5，PowerToys 也这么查）。
// 要在钩子线程上做：不给窗口时热键挂在调用的线程上，登记上了立刻注销。RegisterHotKey 要 vk，扫描码按前台窗口的键盘布局换：
// 用户在前台按这个组合时，系统也是照那个布局换的
func probe(id int, combo binding) []event {
	foreground, _, _ := procGetForegroundWindow.Call()
	thread, _, _ := procGetWindowThreadProcess.Call(foreground, 0)
	layout, _, _ := procGetKeyboardLayout.Call(thread)
	// combo.Key 的扩展键本来就带 0xE0 高字节，MAPVK_VSC_TO_VK_EX 认这个写法
	vk, _, _ := procMapVirtualKeyExW.Call(uintptr(combo.Key), mapvkVSCToVKEx, layout)
	if vk == 0 {
		return []event{noConflict(id), {"event": "error", "message": fmt.Sprintf("扫描码 0x%X 在当前键盘布局里换不出键码，试登记不了", combo.Key)}}
	}
	// 单个普通键时修饰键只有 MOD_NOREPEAT，RegisterHotKey 认这种
	ok, _, lastError := procRegisterHotKey.Call(0, probeHotkeyID, uintptr(registerModifiers(combo.Mods)), vk)
	errno, _ := lastError.(syscall.Errno)
	events := probeResult(id, ok != 0, uint32(errno))
	if ok != 0 {
		// 注销不掉的话，这个组合一直挂在我们线程上：别的程序登记不了，钩子放行的这个键也会被系统当热键吃掉。照实报
		if done, _, unregisterError := procUnregisterHotKey.Call(0, probeHotkeyID); done == 0 {
			code, _ := unregisterError.(syscall.Errno)
			events = append(events, event{"event": "error", "message": fmt.Sprintf("试登记的组合注销不掉（错误码 %d），这个组合可能一直被占着：重启 OrangeSpeakEasy 试试", uint32(code))})
		}
	}
	return events
}

// 存剪贴板 → 写入文字 → 模拟 Ctrl+V → 等一会儿 → 还原剪贴板。只有粘贴这一条路，同 macOS 版。
// 排在剪贴板的活里（clipboardJobs）：等的那一会儿也占着，取选区的模拟复制插不进来
func paste(id int, text string) {
	var finish func()
	onUIThreadWait(func() { finish = startPaste(id, text) })
	if finish == nil {
		return
	}
	time.Sleep(restoreDelay)
	onUIThreadWait(finish)
}

// 贴字的前半段（钩子线程上）：发了 Ctrl+V 的交回后半段（还原、报 pasted），没发出去的当场报完、交回 nil
func startPaste(id int, text string) func() {
	if foregroundBlocksInput() {
		// 系统不让模拟的按键进管理员窗口，而且不报错。把文字留在剪贴板里，让用户自己按 Ctrl+V
		if err := board.writeText(text, false); err != nil {
			emit(event{"event": "error", "message": err.Error()})
		}
		emit(event{"event": "pasted", "id": id, "ok": false, "reason": "elevated"})
		return nil
	}
	saved, err := board.snapshot()
	restorable := err == nil
	if !restorable {
		// 存不下原来的内容就还原不了：这次的字不标成临时的，留在剪贴板和剪贴板历史（Win+V）里，
		// 用户原来复制的那份在剪贴板历史里也还找得到
		emit(event{"event": "error", "message": "存不下剪贴板，贴完不还原：" + err.Error()})
	}
	if err := board.writeText(text, restorable); err != nil {
		emit(event{"event": "error", "message": err.Error()})
		emit(event{"event": "pasted", "id": id, "ok": false, "reason": "clipboard"})
		return nil
	}
	if !sendKeys([]uint16{vkControl, vkV, vkV, vkControl}, []bool{true, true, false, false}) {
		// 文字已经在剪贴板里了：不还原，让用户自己按
		emit(event{"event": "pasted", "id": id, "ok": false, "reason": "send_input"})
		return nil
	}
	return func() {
		if restorable {
			if err := board.restore(saved); err != nil {
				emit(event{"event": "error", "message": "还原不了剪贴板：" + err.Error()})
			}
		}
		emit(event{"event": "pasted", "id": id, "ok": true})
	}
}

func handle(line []byte) {
	cmd, err := parseCommand(line)
	if err != nil {
		emit(event{"event": "error", "message": err.Error()})
		return
	}
	switch cmd.Cmd {
	case "bind":
		bindings, rejected, err := parseBindings(cmd.Bindings, listening)
		if err != nil {
			emit(event{"event": "error", "message": err.Error()})
			return
		}
		onUIThread(func() {
			// 换表前按着的绑定先补报松开，再报这次的回执
			for _, e := range hotkeys.bind(bindings) {
				emit(e)
			}
			emit(boundEvent(rejected))
		})
	case "paste":
		if cmd.ID == nil || cmd.Text == nil {
			emit(event{"event": "error", "message": "paste 需要 id 和 text"})
			return
		}
		id, text := *cmd.ID, *cmd.Text
		clipboardJobs <- func() { paste(id, text) }
	case "capture":
		regions, outside, err := parseCapture(cmd)
		if err != nil {
			emit(event{"event": "error", "message": err.Error()})
			return
		}
		onUIThread(func() { setCapturing(true, regions, outside) })
	case "release":
		onUIThread(func() { setCapturing(false, nil, false) })
	case "selection":
		id, err := parseSelection(cmd)
		if err != nil {
			emit(event{"event": "error", "message": err.Error()})
			return
		}
		handleSelection(id)
	case "record":
		on, err := parseRecord(cmd.On)
		if err != nil {
			emit(event{"event": "error", "message": err.Error()})
			return
		}
		onUIThread(func() { setRecording(on) })
	case "probe":
		id, combo, reply := parseProbe(cmd)
		if reply != nil {
			for _, e := range reply {
				emit(e)
			}
			return
		}
		onUIThread(func() {
			for _, e := range probe(id, combo) {
				emit(e)
			}
		})
	case "info":
		// Windows 上没有要报的系统设置（fnUsage 只有 Mac 有）
		emit(event{"event": "info"})
	default:
		emit(event{"event": "error", "message": "不认识的命令：" + cmd.Cmd})
	}
}

func windowProc(hwnd, message, wParam, lParam uintptr) uintptr {
	switch message {
	case wmTask:
		// 做的过程中又排进来的，会再投一条消息，下一轮再做
		for _, task := range tasks.takeAll() {
			task()
		}
		return 0
	case wmPowerBroadcast:
		switch wParam {
		case pbtAPMSuspend:
			pauseListening()
		case pbtAPMResumeAutomatic:
			relisten("resume")
		}
		return 1
	case wmWTSSessionChange:
		switch wParam {
		case wtsSessionLock, wtsConsoleDisconnect, wtsRemoteDisconnect:
			pauseListening()
		case wtsSessionUnlock, wtsConsoleConnect, wtsRemoteConnect:
			relisten("unlock")
		}
		return 0
	}
	result, _, _ := procDefWindowProcW.Call(hwnd, message, wParam, lParam)
	return result
}

func createMessageWindow() uintptr {
	module, _, _ := procGetModuleHandleW.Call(0)
	class := wndClassEx{wndProc: windowCallback, instance: module, className: utf16Ptr("OrangeSpeakEasyKeyHelper")}
	class.size = uint32(unsafe.Sizeof(class))
	procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
	hwnd, _, _ := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(class.className)), 0, 0, 0, 0, 0, 0,
		hwndMessage, 0, module, 0)
	return hwnd
}

// 自检（不发按键）：剪贴板能写进去、带上了"临时"标记、还原之后和原来一模一样
func selfTest() bool {
	before, err := board.snapshot()
	if err != nil {
		emit(event{"event": "error", "message": err.Error()})
		return false
	}
	const probe = "orangespeakeasy 自检"
	wrote := board.writeText(probe, true) == nil
	text, readErr := board.readText()
	wroteText := wrote && readErr == nil && text == probe
	markedTransient := wrote && board.hasFormat(board.exclude)
	restored := board.restore(before) == nil
	after, _ := board.snapshot()
	same := restored && sameEntries(before, after)
	emit(event{"event": "selftest", "wrote_text": wroteText, "marked_transient": markedTransient, "restored": same, "items": len(before)})
	return wroteText && markedTransient && same
}

// 两份剪贴板内容一样不一样：格式的先后不算，系统可能按自己的顺序列
func sameEntries(a, b []clipboardEntry) bool {
	if len(a) != len(b) {
		return false
	}
	byFormat := map[uint32]string{}
	for _, entry := range a {
		byFormat[entry.format] = string(entry.data)
	}
	for _, entry := range b {
		if data, ok := byFormat[entry.format]; !ok || data != string(entry.data) {
			return false
		}
	}
	return true
}

func main() {
	runtime.LockOSThread()
	declareDPIAware()
	go func() {
		writer := bufio.NewWriter(os.Stdout)
		for {
			line, ok := out.next()
			if !ok {
				return
			}
			writer.Write(line)
			if out.pending() == 0 {
				writer.Flush()
			}
		}
	}()
	exit := func(code int) {
		// 等写完再退：出错的那一行不能丢
		for out.pending() > 0 {
			time.Sleep(10 * time.Millisecond)
		}
		time.Sleep(20 * time.Millisecond)
		os.Exit(code)
	}

	args := os.Args[1:]
	has := func(flag string) bool {
		for _, arg := range args {
			if arg == flag {
				return true
			}
		}
		return false
	}
	// Windows 没有"输入监控""辅助功能"这两项权限
	if has("--check") {
		emit(event{"event": "check", "listen": true, "trusted": true})
		exit(0)
	}

	window = createMessageWindow()
	if window == 0 {
		emit(event{"event": "error", "message": "建不了消息窗口"})
		exit(1)
	}
	board = newClipboard(window)
	startClipboardJobs()
	if has("--selftest") {
		if selfTest() {
			exit(0)
		}
		exit(1)
	}

	// --no-prompt 照收不误：Windows 上没有授权框可弹。热键等父进程用 bind 下发，在那之前一个也不听
	keyboardHook = installHook(whKeyboardLL, keyboardCallback)
	listening = keyboardHook != 0
	emit(event{"event": "ready", "listen": listening, "trusted": true, "capture": listening})
	watchSystem()

	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		// 一次贴的字可能很长：放宽到 16 MB
		scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
		for scanner.Scan() {
			handle(append([]byte(nil), scanner.Bytes()...))
		}
		if err := scanner.Err(); err != nil {
			emit(event{"event": "error", "message": "读标准输入出错：" + err.Error()})
		}
		exit(0)
	}()

	var m msg
	for {
		result, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(result) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	exit(0)
}
