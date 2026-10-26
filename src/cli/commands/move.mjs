import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { msg } from "../../i18n/index.mjs";
import { sizeText } from "../../models/describe.mjs";
import { parse, UsageError } from "../common.mjs";

// orangespeakeasy move <文件夹>：把 OrangeSpeakEasy 整个目录（程序、本机模型、录音、设置）搬进那个文件夹里的 .orangespeakeasy；
// orangespeakeasy move ~ 搬回默认位置。不写文件夹就说现在在哪。
// 怎么搬在内核里（src/move），App 设置里的"存储位置"走的是同一套；这里只管问一句、报进度、说结果。

/** 敲进来的文件夹：~ 换成用户目录（PowerShell 不替外部命令展开它），相对路径按当前目录 */
function folderOf(typed, cwd) {
  const expanded = typed === "~" ? homedir() : /^~[\\/]/.test(typed) ? join(homedir(), typed.slice(2)) : typed;
  return resolve(cwd, expanded);
}

/** 拷的进度：每过两成说一次（和更新下载时一样），不在终端里时不说 */
function progressReporter(io) {
  let said = 0;
  return ({ bytes, total }) => {
    if (!io.interactive || total.bytes === 0) return;
    const step = Math.min(5, Math.floor((bytes / total.bytes) * 5));
    if (step > said) {
      said = step;
      io.out(io.t("cli.move.progress", { percent: step * 20, done: sizeText(bytes), total: sizeText(total.bytes) }));
    }
  };
}

export async function move(args, io) {
  const { values, positionals } = parse(args, { yes: { type: "boolean", short: "y", default: false } });
  const { t } = io;
  if (positionals.length === 0) {
    io.out(t("cli.move.where", { home: io.paths.home }));
    io.out(t("cli.move.how"));
    return 0;
  }
  if (positionals.length > 1) {
    throw new UsageError(msg("cli.extraArgs", { args: positionals.slice(1).join(" "), usage: msg("cli.syntax.move") }));
  }
  const mover = io.mover();
  const folder = folderOf(positionals[0], io.cwd());
  // 先检查（不动磁盘）：去不了的、这台电脑上有旧版本的，问"确定吗"之前就说
  const plan = await mover.plan(folder);
  if (!values.yes) {
    if (!io.interactive) throw new UsageError(msg("cli.move.needsConfirm"));
    io.out(t("cli.move.plan", { from: plan.from, to: plan.to, size: sizeText(plan.bytes), count: plan.files }));
    if (plan.unknown.length > 0) io.out(t("cli.move.unknown", { items: t.list(plan.unknown) }));
    if (!(await io.confirm(t("cli.move.confirm")))) {
      io.out(t("cli.move.aborted"));
      return 1;
    }
  }
  // 没搬成时抛出的错由 main.mjs 照它的语言说出来、退出码 1；安装脚本自己说的话接在终端上
  const result = await mover.run({
    folder,
    by: "cli",
    report: (message) => io.out(t.text(message)),
    onProgress: progressReporter(io),
  });
  io.out(t("cli.move.done", { to: result.to, size: sizeText(result.bytes), count: result.files }));
  if (result.left.length > 0) io.out(t("cli.move.left", { dir: result.from, items: t.list(result.left) }));
  else if (result.later) io.out(t("cli.move.later", { dir: result.from }));
  else io.out(t("cli.move.removed", { dir: result.from }));
  return 0;
}
