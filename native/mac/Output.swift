// 往父进程写事件：一行一个 JSON。
// 写在一条单独的串行队列上，不在调用方的线程上等：tap 的回调里也要报事件，父进程一时读不过来、管道写满时，
// 当场写会把回调卡住，能改事件的 tap 一卡，全系统的按键都跟着卡（Windows 版第 0 步修的是同一件事）。

import Foundation

private let output = DispatchQueue(label: "orangespeakeasy.output")

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else {
        FileHandle.standardError.write("emit: 序列化失败 \(object)\n".data(using: .utf8)!)
        return
    }
    output.async {
        print(line)
        fflush(stdout)
    }
}

/// 等排着的事件都写出去再往下走：退出前用，出错的那一行不能丢
func flushOutput() {
    output.sync {}
}
