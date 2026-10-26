import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { assembleTree } from "./assemble.mjs";
import { runToEnd } from "./exec.mjs";
import { homeTarget } from "./layout.mjs";
import { parseVersion } from "./versions.mjs";

/** macOS 上拼新版本的目录名的开头（在家目录里）。install.sh 认它：只肯从家目录里的这种目录装；卸载（留数据）时也删它 */
export const STAGING_PREFIX = ".update-";

// 装在家目录里的那一份：安装脚本（install.sh、install.ps1）装的。Mac 上是终端安装，Windows 上两种安装都是它。
// 换成新版本：先照清单拼好新版本（只下本机缺的块），再让新版本自带的安装脚本把它换上（怎么装是新版本说了算）。
// 拼在停掉正在运行的那个之前就做完了，停着的只有换程序的那十几秒，下载失败也什么都没动。

/** 一个程序目录里 package.json 写的版本；没有、读不出、不像版本号的是 null */
function versionIn(appDir) {
  try {
    return parseVersion(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version);
  } catch {
    return null;
  }
}

/**
 * 家目录里装着的那一份的程序目录：Mac 是 app，Windows 是 current 指着的 versions 下那个版本里的 app。
 * 没装（或者 Windows 上 current 读不出来）是 null
 */
function homeAppDir(paths, platform) {
  if (platform !== "win32") return paths.appDir;
  try {
    const current = readFileSync(paths.currentFile, "utf8").trim();
    return current ? join(paths.versionsDir, current, "app") : null;
  } catch {
    return null;
  }
}

/**
 * 这一份程序是不是家目录里装的那一份：程序在家目录的 app 里（macOS），或者 versions 下某一个版本的 app 里
 * （Windows，不分大小写）。比真实的路径：家目录可能经过符号链接（/tmp 其实是 /private/tmp），
 * 而程序算出来的自己在哪是真实的路径
 */
export function isHomeCopy(packageDir, paths, platform) {
  try {
    const program = realpathSync(packageDir);
    if (platform !== "win32") return program === realpathSync(paths.appDir);
    const versions = realpathSync(paths.versionsDir).toLowerCase();
    return basename(program).toLowerCase() === "app" && dirname(dirname(program)).toLowerCase() === versions;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** 安装脚本上次把 orangespeakeasy 命令的链接建在了哪个目录（bin/links 里记着，一行一个）；没记、链接不在了是 null */
function existingLinkDir(paths) {
  let lines;
  try {
    lines = readFileSync(paths.linksFile, "utf8").split("\n");
  } catch {
    return null;
  }
  const link = lines.map((line) => line.trim()).find((line) => line.startsWith("/") && isSymlink(line));
  return link ? dirname(link) : null;
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 安装脚本按什么芯片取包：Apple 芯片上即使这个进程跑在转译里，install.sh 也装 arm64 的（它看 sysctl.proc_translated）
 * @returns {"arm64" | "x64"}
 */
export function homeArch(platform, arch, translated = () => sysctlTranslated()) {
  if (platform === "win32" || arch === "arm64") return arch === "arm64" ? "arm64" : "x64";
  return translated() ? "arm64" : "x64";
}

function sysctlTranslated() {
  try {
    return execFileSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" }).trim() === "1";
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {ReturnType<import("../storage/paths.mjs").resolvePaths>} options.paths
 * @param {Record<string, string | undefined>} options.env 安装脚本也在这个环境里跑（代理这些传过去）
 * @param {ReturnType<import("./release.mjs").createRelease>} options.release
 * @param {"inherit" | "forward"} options.stdio 安装脚本和启动时说的话接到哪：终端，或者转到这个进程的输出上（exec.mjs）
 */
export function createHomes({
  paths,
  env,
  release,
  stdio,
  platform = process.platform,
  arch = process.arch,
  translated,
}) {
  const windows = platform === "win32";
  return {
    /** 家目录里装着的那一份是哪个版本；没装是 null */
    find() {
      const appDir = homeAppDir(paths, platform);
      const version = appDir ? versionIn(appDir) : null;
      return version ? { version } : null;
    },

    /**
     * 清掉上次被打断（进程被杀、关机）时拼了一半的（macOS 家目录里 .update- 开头的）。同一时间只有一个更新（state.mjs 的锁）。
     * Windows 上拼在 versions 下，install.ps1 装下一个版本时会清。删不掉的交回在哪、为什么
     */
    clean() {
      if (windows || !existsSync(paths.home)) return null;
      for (const name of readdirSync(paths.home)) {
        if (!name.startsWith(STAGING_PREFIX)) continue;
        try {
          rmSync(join(paths.home, name), { recursive: true, force: true });
        } catch (error) {
          return { dir: join(paths.home, name), reason: error.code ?? error.message };
        }
      }
      return null;
    },

    /** 本机装着的这一份在哪几个目录：拼新版本时当种子（没变的块从这里拷） */
    seeds() {
      if (!windows) return [paths.appDir, paths.runtimeDir];
      const appDir = homeAppDir(paths, platform);
      return appDir ? [dirname(appDir)] : [];
    },

    /**
     * 把这个版本拼好（只下本机缺的块，assemble.mjs），交给它自带的安装脚本去换。
     * 拼在哪：Windows 直接拼进 versions 下一个新目录（install.ps1 原地用它，不挪：刚写出来的文件杀毒软件正扫着，挪不动）；
     * macOS 拼在家目录里一个 .update- 开头的目录（同一块盘，install.sh 改名就换上）
     * @param {{ version: string, targets: Record<string, string> }} channel release.channel() 问到的
     * @param {{ seeds: string[], cacheDir: string, onProgress?: Function }} options
     * @returns {Promise<{ dir: string, discard: () => { dir: string, reason: string } | null,
     *   downloadedBytes: number, reusedBytes: number }>} discard 交回删不掉的
     */
    async stage(channel, { seeds, cacheDir, onProgress }) {
      const target = homeTarget(platform, homeArch(platform, arch, translated));
      if (!channel.targets[target])
        throw new LocalizedError(msg("update.noTarget", { target, version: channel.version }));
      const { manifest, bytes: manifestBytes } = await release.manifest(channel.targets[target]);
      const suffix = randomBytes(4).toString("hex");
      let dir;
      if (windows) {
        // 和 install.ps1 的 versions 目录名同一种：<版本>-<8 位编号>
        dir = join(paths.versionsDir, `${channel.version}-${suffix}`);
      } else {
        dir = join(paths.home, `${STAGING_PREFIX}${channel.version}-${suffix}`);
      }
      // 删不掉（Windows 上杀毒软件正扫着刚写的文件）不算出错：交回留在了哪、为什么，由更新那一层说一声
      const discard = () => {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          return null;
        } catch (error) {
          return { dir, reason: error.code ?? error.message };
        }
      };
      try {
        const stats = await assembleTree({
          manifest,
          dest: dir,
          seeds,
          fetchObjects: release.fetchObjects,
          cacheDir,
          onProgress,
        });
        // 下了多少：缺的块加上清单本身
        return { dir, discard, downloadedBytes: stats.downloadedBytes + manifestBytes, reusedBytes: stats.reusedBytes };
      } catch (error) {
        discard();
        if (error instanceof LocalizedError) throw error;
        // 磁盘满了、没有权限这些：说清是在哪拼的、系统怎么说的
        throw new LocalizedError(msg("update.prepareFailed", { dir, reason: error.code ?? error.message }), {
          cause: error,
        });
      }
    },

    /**
     * 让拼好的这个版本自带的安装脚本（app 里的 install.sh、install.ps1）把它换上：怎么装是新版本说了算。
     * 只装不启动（谁原来在跑、装完重新打开谁，由更新那一层管）。它说的话照 stdio 接
     * @returns {Promise<number>} 安装脚本的退出码
     */
    install(staged) {
      const installerEnv = { ...env, ORANGESPEAKEASY_HOME: paths.home, ORANGESPEAKEASY_INSTALL_FROM: staged.dir };
      // 它自己用拼好的那份 Electron 当 Node 跑命令，不要把这边的带过去；也不要被这边的版本、下载地址带偏。
      // 第一次安装时设的 ORANGESPEAKEASY_INSTALL_DIR（同一个终端、或者一路带进了 App）和换家用的 ORANGESPEAKEASY_PREVIOUS_HOME
      // 也不带：更新只换这个家目录里的程序，安装脚本见到它们会以为要装到别处、换家
      const installOnly = [
        "ELECTRON_RUN_AS_NODE",
        "ORANGESPEAKEASY_VERSION",
        "ORANGESPEAKEASY_INSTALL_BASE",
        "ORANGESPEAKEASY_INSTALL_DIR",
        "ORANGESPEAKEASY_PREVIOUS_HOME",
      ];
      for (const name of installOnly) delete installerEnv[name];
      if (windows) {
        // install.ps1 从 irm | iex 跑时传不了参数，只认环境变量。按 UTF-8 读进来再当脚本块跑：存成文件直接 -File 的话，
        // 5.1 把没有 BOM 的脚本当成系统编码（GBK）读；也绕开了执行策略（只允许跑文件这一层管着的那种）
        installerEnv.ORANGESPEAKEASY_NO_START = "1";
        installerEnv.ORANGESPEAKEASY_INSTALL_SCRIPT = join(staged.dir, "app", "install.ps1");
        const command =
          "& ([scriptblock]::Create([IO.File]::ReadAllText($env:ORANGESPEAKEASY_INSTALL_SCRIPT, [Text.Encoding]::UTF8))); exit $LASTEXITCODE";
        return runToEnd("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
          env: installerEnv,
          stdio,
        });
      }
      // 命令的链接放在原来那个地方：从 App 起的进程拿到的是系统给的精简 PATH，安装脚本按 PATH 挑的话会另挑一处
      if (!installerEnv.ORANGESPEAKEASY_BIN_DIR) {
        const linkDir = existingLinkDir(paths);
        if (linkDir) installerEnv.ORANGESPEAKEASY_BIN_DIR = linkDir;
      }
      return runToEnd("/bin/bash", [join(staged.dir, "app", "install.sh"), "--no-start"], { env: installerEnv, stdio });
    },

    /**
     * 启动家目录里的这一份（装好的 orangespeakeasy 命令的 start）：和装完以后在终端里敲 orangespeakeasy 是一回事
     * @returns {Promise<number>} 退出码
     */
    start() {
      const { ELECTRON_RUN_AS_NODE: _asNode, ...startEnv } = env;
      startEnv.ORANGESPEAKEASY_HOME = paths.home;
      if (windows) {
        // .cmd 要经 cmd 才跑得起来。整条命令写成一串交给它（参数另给的话 Node 会警告不转义）；路径里可能有空格，用引号括起来
        return runToEnd(`"${join(paths.binDir, "orangespeakeasy.cmd")}" start`, [], {
          env: startEnv,
          stdio,
          shell: true,
        });
      }
      return runToEnd(join(paths.binDir, "orangespeakeasy"), ["start"], { env: startEnv, stdio });
    },
  };
}
