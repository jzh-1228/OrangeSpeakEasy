import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { msg } from "../../i18n/index.mjs";
import { discardInterruptedMove } from "../../move/index.mjs";
import { forgetLocation } from "../../storage/location.mjs";
import { STAGING_PREFIX } from "../../update/home.mjs";
import { noPositionals, parse, UsageError } from "../common.mjs";

// orangespeakeasy uninstall：停掉后台，把 OrangeSpeakEasy 的目录整个删掉；目录以外删不了的照实列出来。
// 目录以外装的时候动过什么记在 bin\links 里，一行一样：macOS 上是指向 orangespeakeasy 命令的链接（一个路径），
// Windows 上是 "path <用户 Path 里的那一项>" 和 "shortcut <开始菜单的快捷方式>"（install.ps1 写的）。
// Windows 上正在跑的程序删不掉，而这条命令自己就跑在装好的那份 Electron 上：删不掉的等它退出后再删（io.system）。

/** Electron（Chromium）在缓存目录里记加密钥匙的那个文件 */
const LOCAL_STATE = "Local State";
/** 家目录里程序留下的半截：安装脚本的临时目录（.install.）、换下来的旧程序（app.old 这些） */
const INSTALL_LEFTOVER = /^\.install\.|^(app|runtime)\.old(\..+)?$/;

/** 这个链接是不是指向我们自己的那条命令。清单里记的东西卸载前要再认一遍：那个位置上可能已经换成了别的 */
function isOurLink(link, binDir) {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    return resolve(dirname(link), readlinkSync(link)).startsWith(binDir + sep);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function recordedLinks(io) {
  try {
    // install.ps1 写的（Windows PowerShell 5.1）开头带 BOM、按 CRLF 换行
    return readFileSync(io.paths.linksFile, "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function uninstall(args, io) {
  const { values, positionals } = parse(args, {
    "keep-data": { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
  });
  noPositionals(positionals, "uninstall");
  const { paths, t } = io;
  const keepData = values["keep-data"];
  const named = { home: paths.home, yours: t("cli.uninstall.yours") };

  if (!values.yes) {
    if (!io.interactive) throw new UsageError(msg("cli.uninstall.needsConfirm"));
    io.out(t(keepData ? "cli.uninstall.planKeep" : "cli.uninstall.planAll", named));
    if (!(await io.confirm(t("cli.uninstall.confirm")))) {
      io.out(t("cli.uninstall.aborted"));
      return 1;
    }
  }

  // 它还开着那些文件。停不掉就不往下删，错误照直报出去
  await io.daemon.stop();

  const removed = [];
  const leftovers = [];
  for (const line of recordedLinks(io)) {
    const [kind, target] =
      line.startsWith("path ") || line.startsWith("shortcut ") ? line.split(/ (.*)/s) : ["link", line];
    if (kind === "path") {
      if (io.system.removePathEntry(target)) removed.push(t("cli.uninstall.pathEntry", { entry: target }));
    } else if (kind === "shortcut") {
      if (!io.system.isOurShortcut(target, paths.home)) continue;
      rmSync(target, { force: true });
      removed.push(target);
    } else if (isOurLink(target, paths.binDir)) {
      rmSync(target);
      removed.push(target);
    }
  }
  // App 设置里开过开机启动的话，那一条记在系统里（Windows 的注册表）
  if (io.platform === "win32" && io.system.removeLoginItem(paths.home)) removed.push(t("cli.uninstall.loginItem"));

  /** 删不掉、等这条命令退出后再删的（只有 Windows 会有） */
  const later = [];
  // Windows 上这条命令是 bin\orangespeakeasy.cmd 起的：cmd 等它退出后还要回头读这个批处理文件，现在删掉的话
  // 会报"找不到批处理文件"、退出码变成 1。bin 留到退出后再删（真机上试过，同一行接 exit 也躲不开）
  const deferBin = io.platform === "win32";
  const remove = (dir) => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (io.platform !== "win32" || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error;
      later.push(dir);
    }
  };

  if (keepData) {
    const logsDir = dirname(paths.logFile);
    // Windows 上程序在 versions 下（每个版本一个目录）、current 记着用哪个；0.9.2 及以前在 app、runtime 里
    const program = io.platform === "win32" ? [paths.versionsDir, paths.currentFile] : [];
    for (const dir of [paths.appDir, paths.runtimeDir, ...program, paths.runDir, logsDir]) remove(dir);
    // 更新拼了一半的（.update-，src/update/home.mjs）、安装脚本被打断留下的（.install.、换下来的 app.old 这些）也是程序
    if (existsSync(paths.home)) {
      for (const name of readdirSync(paths.home)) {
        if (name.startsWith(STAGING_PREFIX) || INSTALL_LEFTOVER.test(name)) remove(join(paths.home, name));
      }
    }
    // Windows 上留着的 key 是 Electron 的 safeStorage 加密的，解开它要的那把钥匙（DPAPI 加密过）记在
    // 缓存目录的 Local State 里：留着 key 就得留着它，缓存别的都删。macOS 上那把钥匙在钥匙串里，缓存整个删
    if (io.platform === "win32" && existsSync(paths.cacheDir)) {
      for (const name of readdirSync(paths.cacheDir)) if (name !== LOCAL_STATE) remove(join(paths.cacheDir, name));
    } else remove(paths.cacheDir);
    if (deferBin) later.push(paths.binDir);
    else remove(paths.binDir);
    removed.push(t("cli.uninstall.removedKeep", named));
  } else {
    try {
      if (io.removeKeychainKey()) removed.push(t("cli.uninstall.keychainItem"));
    } catch (error) {
      leftovers.push(t("cli.uninstall.keychainFailed", { reason: error.message }));
    }
    if (deferBin && existsSync(paths.home)) {
      // 能删的现在删（删不掉的报出来、或者先记着），退出后把整个家目录连同 bin 再删一遍
      for (const name of readdirSync(paths.home)) {
        if (join(paths.home, name) !== paths.binDir) remove(join(paths.home, name));
      }
      later.splice(0, later.length, paths.home);
    } else {
      remove(paths.home);
    }
    removed.push(t("cli.uninstall.removedAll", named));
    // 定位文件读不出来时照样卸完（程序、数据已经删了），说一声它还在
    try {
      // 上次搬到一半断了：拷过去的那一份也有录音、key，定位文件一删就没人知道它在哪了
      const half = discardInterruptedMove({ paths, platform: io.platform });
      if (half) removed.push(t("cli.uninstall.halfCopy", { dir: half }));
      // 装在默认位置以外的，还有一个记着它在哪的定位文件（storage/location.mjs）。--keep-data 时留着：重装后照它找回数据
      if (forgetLocation(paths.locationFile, paths.home, io.platform)) {
        removed.push(t("cli.uninstall.locationFile", { file: paths.locationFile }));
      }
    } catch (error) {
      leftovers.push(t("cli.uninstall.locationUnreadable", { file: paths.locationFile, reason: error.message }));
    }
  }
  if (later.length > 0) io.system.removeAfterExit(later);

  io.out(t("cli.uninstall.done"));
  for (const item of removed) io.out(`  ${t("cli.uninstall.removed", { item })}`);
  if (later.length > 0) io.out(`  ${t("cli.uninstall.afterExit")}`);
  if (keepData) io.out(`  ${t("cli.uninstall.kept", named)}`);
  // 删不了、或者不该由我们删的，照实列出来。Windows 上没有记在终端名下的权限
  if (io.platform !== "win32") leftovers.push(t("cli.uninstall.permissions"));
  if (io.sharedPreferencesFile && existsSync(io.sharedPreferencesFile)) {
    leftovers.push(t("cli.uninstall.sharedPrefs", { file: io.sharedPreferencesFile }));
  }
  // 从源码目录运行的那种，程序不在我们的目录里
  if (!io.packageDir.startsWith(paths.home + sep)) leftovers.push(t("cli.uninstall.sourceDir", { dir: io.packageDir }));
  if (leftovers.length > 0) {
    io.out(`  ${t("cli.uninstall.leftovers")}`);
    for (const item of leftovers) io.out(`    · ${item}`);
  }
  return 0;
}
