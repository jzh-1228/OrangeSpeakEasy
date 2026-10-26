import { noPositionals, parse } from "../common.mjs";

// orangespeakeasy update：把这台电脑上装着的 OrangeSpeakEasy（终端安装的这一份；装着 OrangeSpeakEasy.app 的话连它一起）都换成最新的，
// 原来在运行的重新打开。设置、key、历史、录音和词典不动。
// 怎么查、怎么换都在内核里（src/update），App 里"设置 › 通用"的更新按钮走的是同一套，两边看到的是同一份状态。
// 从源码跑的用 git pull；只装了 App、没有这个命令的，在 App 里更新。

export async function update(args, io) {
  noPositionals(parse(args).positionals, "update");
  const { t } = io;
  if (io.updates.self === null) {
    io.err(t("update.fromSource", { dir: io.packageDir }));
    return 1;
  }
  // 没换成时抛出的错由 main.mjs 照它的语言说出来、退出码 1；安装脚本自己说的话已经接在终端上了
  const result = await io.updates.run({ by: "cli", report: (message) => io.out(t.text(message)) });
  if (!result.updated) {
    io.out(t("cli.update.upToDate", { version: io.version }));
    return 0;
  }
  // 原来没在运行的不替它启动；在运行的已经重新打开了（家目录那一份的启动命令会自己说状态）
  if (!result.running) io.out(t("cli.update.startHint", { version: result.latest }));
  return 0;
}

/**
 * status 末尾提一句更新的事：正在更新、有新版本、上一次没更新成
 * @param {Awaited<ReturnType<ReturnType<import("../../update/index.mjs").createUpdates>["check"]>>} check
 * @param {object | null} progress update.json 里的那一条（updates.progress()）
 * @returns {string[]} 要说的话（已经翻好）
 */
export function updateNotes(io, check, progress) {
  const { t } = io;
  if (progress?.state === "running") return [t("cli.update.inProgress", { version: progress.version ?? "…" })];
  const notes = [];
  if (check.available) {
    const self = check.behind.find((copy) => copy.kind === "home");
    const other = check.behind[0];
    notes.push(
      self
        ? t("cli.update.available", { latest: check.latest, current: io.version })
        : t("cli.update.otherAvailable", {
            copy: t(`update.copies.${other.kind}`),
            current: other.version,
            latest: check.latest,
          }),
    );
  }
  // 没换成的那次要换的版本还比现在的新，才值得提：后来换成了（不管用的哪种办法）就不提
  if (progress?.state === "failed" && check.available) {
    notes.push(t("cli.update.lastFailed", { problem: t.text(progress.problem) }));
  }
  return notes;
}
