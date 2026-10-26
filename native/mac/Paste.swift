// 贴字：存剪贴板 → 写入文字 → 模拟 ⌘V → 恢复剪贴板。只有粘贴这一条路，和原版一样。
// 和划词的模拟 ⌘C（Selection.swift）排在同一队剪贴板的活里（clipboardJobs）。

import AppKit

private let vKeyCode: CGKeyCode = 9
/// 剪贴板管理工具之间的约定：带这个类型的内容是临时的，不要记进历史
private let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
/// 模拟粘贴之后等多久再恢复剪贴板。原版的值没有读到；太短的话目标应用还没来得及读
private let restoreDelay: TimeInterval = 0.3

// MARK: - 剪贴板

typealias PasteboardSnapshot = [[(NSPasteboard.PasteboardType, Data)]]

/// 存下剪贴板里每一项的每一种格式，这样图片、文件、富文本都能原样还回去（划词模拟 ⌘C 时也用，Selection.swift）
func snapshotPasteboard(_ pasteboard: NSPasteboard) -> PasteboardSnapshot {
    (pasteboard.pasteboardItems ?? []).map { item in
        item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
    }
}

func restorePasteboard(_ pasteboard: NSPasteboard, from snapshot: PasteboardSnapshot) {
    pasteboard.clearContents()
    let items = snapshot.map { entries -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in entries { item.setData(data, forType: type) }
        return item
    }
    if !items.isEmpty { pasteboard.writeObjects(items) }
}

private func writeTransientText(_ pasteboard: NSPasteboard, _ text: String) {
    pasteboard.clearContents()
    let item = NSPasteboardItem()
    item.setString(text, forType: .string)
    item.setData(Data(), forType: transientType)
    pasteboard.writeObjects([item])
}

// MARK: - 剪贴板的活一件一件来

/// 一件做完才开始下一件：每件拿到一个 finished，做完了调它（可以晚一点调，比如等剪贴板还原完）。只在主线程上用
final class SerialJobs {
    private var waiting: [(@escaping () -> Void) -> Void] = []
    private var busy = false

    func add(_ job: @escaping (_ finished: @escaping () -> Void) -> Void) {
        waiting.append(job)
        next()
    }

    private func next() {
        guard !busy, !waiting.isEmpty else { return }
        busy = true
        let job = waiting.removeFirst()
        var done = false
        job { [self] in
            // 同一件说两次做完只算一次，不多放一件进来
            guard !done else { return }
            done = true
            busy = false
            next()
        }
    }
}

/// 贴字、取选区的模拟 ⌘C 都是"存下 → 改 → 等 → 还原"，两件交叠的话剪贴板会被还原成另一件存下的东西，
/// 还可能把用户原来复制的字当成选区。排成一队，按来的先后做（同 Windows 版的 clipboardJobs）
let clipboardJobs = SerialJobs()

// MARK: - 贴字

/// 合成的 ⌘V 带上自己的记号：它会经过自己的 tap，匹配器认出来就不当成用户按的键
private func postCommandV() {
    let source = CGEventSource(stateID: .combinedSessionState)
    source?.userData = ourEventTag
    for keyDown in [true, false] {
        let event = CGEvent(keyboardEventSource: source, virtualKey: vKeyCode, keyDown: keyDown)
        event?.flags = .maskCommand
        event?.post(tap: .cghidEventTap)
    }
}

/// 排进剪贴板的活里：等着还原的那一会儿也占着，模拟 ⌘C 插不进来
func paste(id: Int, text: String) {
    clipboardJobs.add { finished in
        let pasteboard = NSPasteboard.general
        guard AXIsProcessTrusted() else {
            // 没有辅助功能权限时模拟按键不会生效。把文字留在剪贴板里，让用户自己按 ⌘V
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
            emit(["event": "pasted", "id": id, "ok": false, "reason": "not_trusted"])
            return finished()
        }
        let saved = snapshotPasteboard(pasteboard)
        writeTransientText(pasteboard, text)
        postCommandV()
        DispatchQueue.main.asyncAfter(deadline: .now() + restoreDelay) {
            restorePasteboard(pasteboard, from: saved)
            emit(["event": "pasted", "id": id, "ok": true])
            finished()
        }
    }
}

// MARK: - 自检（不发按键，只验证剪贴板存取能原样还原）

func selfTest() -> Bool {
    let pasteboard = NSPasteboard.general
    let before = snapshotPasteboard(pasteboard)
    writeTransientText(pasteboard, "orangespeakeasy 自检")
    let wroteText = pasteboard.string(forType: .string) == "orangespeakeasy 自检"
    let markedTransient = pasteboard.types?.contains(transientType) ?? false
    restorePasteboard(pasteboard, from: before)
    let after = snapshotPasteboard(pasteboard)
    let restored = before.count == after.count && zip(before, after).allSatisfy { old, new in
        old.count == new.count && zip(old, new).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
    }
    emit(["event": "selftest", "wrote_text": wroteText, "marked_transient": markedTransient,
          "restored": restored, "items": before.count])
    return wroteText && markedTransient && restored
}
