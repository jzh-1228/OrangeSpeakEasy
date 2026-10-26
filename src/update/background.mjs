import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInstance } from "../instance.mjs";
import { log } from "../log.mjs";
import { resolvePaths } from "../storage/paths.mjs";
import { createUpdates } from "./index.mjs";

// App 里点了"更新"之后起的那个进程：借 App 自己的 Electron 当 Node 跑（ELECTRON_RUN_AS_NODE=1），App 退出了它还在。
// 做的事和 orangespeakeasy update 一模一样（index.mjs 的 run）：下好新版本、请 App 退出、换上、再把它打开。
// 进行到哪一步写在 update.json 里，App 照着显示；说的话、出的错写进日志（App 起它时把标准输出、标准错误接到了日志上）。
// 安装脚本会把这份程序所在的目录整个换掉：用到的代码都在上面静态引入，换掉之后不再加载别的文件。

const packageDir = resolve(import.meta.dirname, "../..");

try {
  const paths = resolvePaths(process.env);
  const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const updates = createUpdates({
    paths,
    env: process.env,
    packageDir,
    version,
    instance: createInstance({ paths }),
    // 安装脚本、启动命令说的话经管道转进日志（Windows 上它们不会开控制台窗口，见 exec.mjs）
    stdio: "forward",
  });
  log.info("update_started", { version, self: updates.self });
  const result = await updates.run({
    by: "app",
    report: (message) => log.info("update_step", { step: message.key, ...message.params }),
  });
  log.info("update_finished", result);
  process.exit(0);
} catch (error) {
  log.error("update_failed", { error: String(error?.stack ?? error) });
  process.exit(1);
}
