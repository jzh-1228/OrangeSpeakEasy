import { closeSync, openSync, readSync, statSync } from "node:fs";

// orangespeakeasy logs 在没有 tail 的系统上（Windows）用的：先打最后几行，-f 时接着把新写进来的打出来，按 Ctrl-C 停。
// macOS 上照旧用系统的 tail。

/** 文件最后 lines 行（不到 lines 行就是全部） */
export function lastLines(text, lines) {
  const all = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return all.slice(-lines).join("\n");
}

/** 从 from 这个位置读到文件末尾 */
function readFrom(file, from, size) {
  const length = size - from;
  if (length <= 0) return "";
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, from);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

/**
 * @param {string} file
 * @param {{ lines: number, follow: boolean, write: (text: string) => void, intervalMs?: number }} options
 * @returns {Promise<number>} 退出码；-f 时一直到 Ctrl-C 才回来
 */
export function tailFile(file, { lines, follow, write, intervalMs = 500 }) {
  let size = statSync(file).size;
  const head = lastLines(readFrom(file, 0, size), lines);
  if (head) write(`${head}\n`);
  if (!follow) return Promise.resolve(0);
  return new Promise((resolve) => {
    // 隔一会儿自己看一次大小，和读到的位置比。不用 fs.watchFile：它第一次看大小是放到线程池里异步做的，
    // 系统忙时会晚到刚开始写进来的那几行之后，把它们当成原本就有的，一直不报（test/cli/tail.test.mjs）
    const timer = setInterval(() => {
      let current;
      try {
        current = statSync(file).size;
      } catch (error) {
        // 轮换的那一下文件可能暂时不在：等下一次
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (current === size) return;
      // 日志被轮换（变小了）时从头读新的那一份
      if (current < size) size = 0;
      const added = readFrom(file, size, current);
      size = current;
      if (added) write(added);
    }, intervalMs);
    process.once("SIGINT", () => {
      clearInterval(timer);
      resolve(0);
    });
  });
}
