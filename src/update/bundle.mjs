import { execFile } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { assembleTree } from "./assemble.mjs";
import { run } from "./exec.mjs";
import { appTarget, dmgName, versionDir } from "./layout.mjs";

// Mac 上的 OrangeSpeakEasy.app（拖进"应用程序"的那个）：在哪、是哪个版本，换成新版本，重新打开。
// 换的时候先在它旁边拼好新的、核对好（这时它还可以照常运行；只下本机缺的块，见 assemble.mjs），
// 等它退出了再两次改名对调：换到一半出了错，装着的那个原样留着。Windows 上没有单独的应用包。

/** 打包时写进 App 的应用标识（scripts/build/mac-app.mjs）：名字叫 OrangeSpeakEasy.app 的不一定是我们的 */
const APP_BUNDLE_ID = "com.juzihai.orangespeakeasy";
const APP_NAME = "OrangeSpeakEasy.app";

/** 一个应用包的应用标识和版本号；不是应用包（不存在、没有 Info.plist）是 null */
export async function bundleInfo(app) {
  const plist = join(app, "Contents", "Info.plist");
  if (!existsSync(plist)) return null;
  const read = async (key) => (await run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist])).trim();
  try {
    return { id: await read("CFBundleIdentifier"), version: await read("CFBundleShortVersionString") };
  } catch {
    return null;
  }
}

/** 正在跑的那个进程的程序在哪个应用包里（…/OrangeSpeakEasy.app/Contents/MacOS/OrangeSpeakEasy → …/OrangeSpeakEasy.app） */
async function bundleOfProcess(pid) {
  let executable;
  try {
    executable = (await run("ps", ["-o", "comm=", "-p", String(pid)])).trim();
  } catch {
    // 进程刚好退出了：当没在跑
    return null;
  }
  const at = executable.indexOf(".app/Contents/MacOS/");
  return at === -1 ? null : executable.slice(0, at + ".app".length);
}

/** 程序目录在哪个应用包里（…/OrangeSpeakEasy.app/Contents/Resources/app → …/OrangeSpeakEasy.app）；不在应用包里是 null */
export function bundleOfPackage(packageDir) {
  const suffix = /\.app[\\/]Contents[\\/]Resources[\\/]app[\\/]?$/;
  const match = suffix.exec(packageDir);
  return match ? packageDir.slice(0, match.index + ".app".length) : null;
}

/** 下载来的应用包签名完好：每个文件都和签名对得上 */
async function verifySignature(app) {
  try {
    await run("codesign", ["--verify", "--deep", "--strict", app]);
  } catch (error) {
    throw new LocalizedError(msg("update.appUnsigned", { reason: error.said }), { cause: error });
  }
}

/** 签名的开发者编号。临时签名的是 "not set"，没签名的是 null */
async function teamOf(app) {
  // codesign -d 把说明写在标准错误里；没签名时它报错退出，说明里也就没有这一行
  const described = await new Promise((resolve) => {
    execFile("codesign", ["-dv", app], { encoding: "utf8" }, (_error, _stdout, stderr) => resolve(stderr));
  });
  return /^TeamIdentifier=(.*)$/m.exec(described)?.[1] ?? null;
}

/**
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env ORANGESPEAKEASY_APP 指定 App 在哪（测试用）；打开 App 时交给它
 * @param {ReturnType<import("./release.mjs").createRelease>} options.release
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.arch] 拼哪种芯片的 App：和装着的这一份一样
 */
export function createBundles({ env, release, platform = process.platform, arch = process.arch }) {
  return {
    /**
     * 装着的 OrangeSpeakEasy.app 在哪、是哪个版本。先看 ORANGESPEAKEASY_APP 指的；再看正在跑的那个、这份程序自己所在的那个
     * （用户可能没放在"应用程序"里）；再看两个"应用程序"文件夹
     * @param {{ pid?: number | null, self?: string | null }} [where] pid：正在跑的 App 的进程号；self：这份程序所在的应用包
     * @returns {Promise<{ path: string, version: string } | null>}
     */
    async find({ pid = null, self = null } = {}) {
      if (platform !== "darwin") return null;
      const candidates = env.ORANGESPEAKEASY_APP
        ? [env.ORANGESPEAKEASY_APP]
        : [
            pid === null ? null : await bundleOfProcess(pid),
            self,
            join("/Applications", APP_NAME),
            join(env.HOME || homedir(), "Applications", APP_NAME),
          ];
      for (const path of candidates) {
        if (path === null) continue;
        const info = await bundleInfo(path);
        if (info?.id === APP_BUNDLE_ID) return { path, version: info.version };
      }
      return null;
    },

    /**
     * 清掉上次被打断时在 app 旁边拼了一半的 .OrangeSpeakEasy.app.new（.old 不碰：对调到一半被打断时，装着的那个可能就在它那里）。
     * 删不掉的交回在哪、为什么
     */
    clean(app) {
      const staged = join(dirname(app), `.${basename(app)}.new`);
      try {
        rmSync(staged, { recursive: true, force: true });
        return null;
      } catch (error) {
        return { dir: staged, reason: error.code ?? error.message };
      }
    },

    /**
     * 把这个版本的 OrangeSpeakEasy.app 拼好、核对好，放在 app 旁边待换。这一步不碰装着的那个，它可以照常运行。
     * 拼：照清单只下本机缺的块，没变的从装着的几份里拷（assemble.mjs）。
     * 核对：拼出来的确实是这个版本的 OrangeSpeakEasy、签名完好，而且和装着的出自同一个开发者
     * （块按 sha256 认，只防得住路上坏了；同一个开发者才防得住被人换了）
     * @param {{ version: string, targets: Record<string, string> }} channel release.channel() 问到的
     * @param {string} app 装着的 App
     * @param {{ seeds: string[], cacheDir: string, onProgress?: Function }} options seeds：本机装着的几份；cacheDir：下到的块放哪
     * @returns {Promise<{ commit: () => void, discard: () => { dir: string, reason: string } | null,
     *   downloadedBytes: number, reusedBytes: number }>} commit 换上（调用前 App 要已经退出），discard 不换了、删掉待换的
     */
    async stage(channel, app, { seeds, cacheDir, onProgress }) {
      const { version } = channel;
      const target = appTarget(arch === "arm64" ? "arm64" : "x64");
      // 新旧两个都放在 App 旁边：同一个磁盘上改名是一步到位的。名字带点开头，访达里看不见
      const staged = join(dirname(app), `.${basename(app)}.new`);
      const old = join(dirname(app), `.${basename(app)}.old`);
      const dmgUrl = release.url(`${versionDir(version)}/${dmgName(arch === "arm64" ? "arm64" : "x64")}`);
      const cannotReplace = (error, reason = error.message) =>
        new LocalizedError(msg("update.appReplace", { path: app, reason, url: dmgUrl }), { cause: error });
      let stats;
      let manifestBytes = 0;
      try {
        if (!channel.targets[target]) throw new LocalizedError(msg("update.noTarget", { target, version }));
        const { manifest, bytes } = await release.manifest(channel.targets[target]);
        manifestBytes = bytes;
        // 上次没拼完留下的：拼之前清掉（同一时间只有一个更新，见 state.mjs 的锁）
        rmSync(staged, { recursive: true, force: true });
        try {
          stats = await assembleTree({
            manifest,
            dest: staged,
            // 装着的这个一定在里面（更新那一层交来的种子里通常已经有它）
            seeds: [...new Set([app, ...seeds])],
            fetchObjects: release.fetchObjects,
            cacheDir,
            onProgress,
          });
        } catch (error) {
          if (error instanceof LocalizedError) throw error;
          throw cannotReplace(error);
        }
        const info = await bundleInfo(staged);
        if (info?.id !== APP_BUNDLE_ID || info.version !== version) {
          throw new LocalizedError(msg("update.appWrongPackage", { version }));
        }
        await verifySignature(staged);
        const [incoming, current] = [await teamOf(staged), await teamOf(app)];
        if (incoming !== current) {
          throw new LocalizedError(
            msg("update.appOtherDeveloper", { found: incoming ?? "-", installed: current ?? "-" }),
          );
        }
      } catch (error) {
        // 没走到可以换的那一步：不在 App 旁边留下拼了一半、或者拼好了的几百兆
        rmSync(staged, { recursive: true, force: true });
        throw error;
      }

      return {
        // 下了多少：缺的块加上清单本身
        downloadedBytes: stats.downloadedBytes + manifestBytes,
        reusedBytes: stats.reusedBytes,
        commit() {
          rmSync(old, { recursive: true, force: true });
          try {
            renameSync(app, old);
          } catch (error) {
            rmSync(staged, { recursive: true, force: true });
            throw cannotReplace(error);
          }
          try {
            renameSync(staged, app);
          } catch (error) {
            renameSync(old, app);
            rmSync(staged, { recursive: true, force: true });
            throw cannotReplace(error);
          }
          rmSync(old, { recursive: true, force: true });
        },
        /** 不换了：删掉待换的。删不掉交回留在了哪、为什么 */
        discard() {
          try {
            rmSync(staged, { recursive: true, force: true });
            return null;
          } catch (error) {
            return { dir: staged, reason: error.code ?? error.message };
          }
        },
      };
    },

    /**
     * 打开 App（换完之后把原来在跑的那个重新打开）。open 会把自己的环境变量交给打开的 App，
     * 而更新是借 Electron 当 Node 跑的（ELECTRON_RUN_AS_NODE=1）：带过去的话 App 也当成 Node 跑，一启动就退出。
     * 别的照样带过去，ORANGESPEAKEASY_HOME 这些和这边一致。
     * fresh：另开一个，不管同一个应用包是不是已经有进程在跑（搬家的进度窗口就是这个应用包，不加的话 open 只会把它叫到前面）
     */
    async open(app, { fresh = false } = {}) {
      const { ELECTRON_RUN_AS_NODE: _asNode, ...appEnv } = env;
      await run("open", fresh ? ["-n", app] : [app], { env: appEnv });
    },
  };
}
