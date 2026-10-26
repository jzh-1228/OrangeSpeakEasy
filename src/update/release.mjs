import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { run } from "./exec.mjs";
import { CHANNEL, CHANNEL_FORMAT, objectPath } from "./layout.mjs";
import { parseManifest } from "./manifest.mjs";
import { unpackObject } from "./objects.mjs";
import { parseVersion } from "./versions.mjs";

// 和下载地址打交道：问最新的是哪个版本（channel.json），按 sha256 取对象（块和清单，objects.mjs）。
// 用 curl 而不是 Node 自己的 fetch：终端里设的代理（https_proxy 这些）它认，安装脚本也用它。Windows 10 起自带 curl.exe。

/** 发布包放在这里，和 install.sh、install.ps1 里的 DOWNLOAD_URL 是同一个 */
export const DOWNLOAD_URL = "https://github.com/jzh-1228/OrangeSpeakEasy/releases/latest/download";

/** 从哪下载。和安装脚本一样认 ORANGESPEAKEASY_INSTALL_BASE：一个网址前缀，或者本机的一个目录（npm run release 打出来的） */
export function downloadBase(env) {
  const base = env.ORANGESPEAKEASY_INSTALL_BASE || DOWNLOAD_URL;
  if (base.startsWith("/")) return `file://${base}`;
  // Windows 的盘符路径：C:\dist\release → file:///C:/dist/release
  if (/^[A-Za-z]:[\\/]/.test(base)) return `file:///${base.replaceAll("\\", "/")}`;
  return base;
}

/**
 * 跟着跳转走时只许跳到 https：channel.json 决定信哪份清单，它自己没有校验值，不能被一个跳到 http 的回应换掉
 * （块和清单都按 sha256 核对，换不了）
 */
const NO_DOWNGRADE = ["--proto-redir", "=https"];

/** 一次交给 curl 取多少个对象：取完一批报一次进度，断了重来只补没取到的 */
const BATCH = 64;
const SHA256 = /^[0-9a-f]{64}$/;

/** curl 配置文件里的一个值：双引号括起来，反斜杠和引号转义（Windows 的路径里全是反斜杠） */
const quoted = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** curl 能不能一次并行取好几个（7.66 起有 --parallel；Windows 10 早期自带的 7.55 没有） */
async function canParallel(env) {
  try {
    const [, major, minor] = /curl (\d+)\.(\d+)/.exec(await run("curl", ["--version"], { env })) ?? [];
    return Number(major) > 7 || (Number(major) === 7 && Number(minor) >= 66);
  } catch {
    return false;
  }
}

/**
 * 核对 channel.json：格式是这一版认得的，版本号像版本号，每种装法对着一份清单的 sha256。
 * 格式号比这一版认得的新：以后改了清单的格式或摆法，装着的老版本拼不出来，只能请用户重装一次
 * （0.10.1 就是这样卡在了不再更新的 latest 上），所以说清楚怎么办，不报成"无效"
 * @returns {{ version: string, electron: string, targets: Record<string, string> }}
 */
export function parseChannel(text) {
  const shown = JSON.stringify(String(text).slice(0, 80));
  let channel;
  try {
    channel = JSON.parse(text);
  } catch {
    throw new LocalizedError(msg("update.badChannel", { value: shown }));
  }
  const version = parseVersion(channel?.version);
  if (Number.isInteger(channel?.format) && channel.format > CHANNEL_FORMAT) {
    throw new LocalizedError(msg("update.reinstall", { version: version ?? String(channel.version) }));
  }
  if (channel?.format !== CHANNEL_FORMAT) throw new LocalizedError(msg("update.badChannel", { value: shown }));
  if (version === null) throw new LocalizedError(msg("update.badVersion", { value: JSON.stringify(channel.version) }));
  const targets = channel.targets;
  const valid =
    typeof targets === "object" && targets !== null && Object.values(targets).every((sha) => SHA256.test(sha));
  if (!valid) throw new LocalizedError(msg("update.badChannel", { value: shown }));
  return { version, electron: String(channel.electron ?? ""), targets };
}

/** 删不掉不碍事的临时文件：删不掉（Windows 上杀毒软件正扫着刚写的文件）就留着，缓存目录换成了会整个删 */
function removeQuietly(path, options = {}) {
  try {
    rmSync(path, { force: true, ...options });
  } catch {
    // 留着：只占一点地方，不影响结果
  }
}

/**
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env 代理、ORANGESPEAKEASY_INSTALL_BASE 从这里认
 */
export function createRelease({ env }) {
  const base = downloadBase(env);
  let parallel = null;

  /** 让 curl 照配置文件取一批，说的话收起来。退出码不是 0 也不抛：取到了哪些由调用方逐个核对 */
  function curlBatch(args) {
    return new Promise((resolve, reject) => {
      const child = spawn("curl", args, { stdio: ["ignore", "ignore", "pipe"], env, windowsHide: true });
      let said = "";
      child.stderr.on("data", (chunk) => {
        said += chunk;
      });
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, said: said.trim() }));
    });
  }

  /**
   * 把这些对象（压着的）取到 into 目录，文件名就是 sha256。取到的先叫 <sha>.part，解开核对过才改名，
   * 所以 into 里叫 <sha> 的一定是对的。哪个没取到（update.unreachable）、取到了内容不对（update.checksum）就抛，
   * 取到的留着，下次只补剩下的
   * @param {string[]} shas
   * @param {string} into
   * @param {(bytes: number) => void} [onBytes] 每取好一个报它的字节数（压着的）
   */
  async function fetchObjects(shas, into, onBytes) {
    parallel ??= await canParallel(env);
    for (let start = 0; start < shas.length; start += BATCH) {
      const batch = shas.slice(start, start + BATCH);
      // 上次被打断时留下的半截：curl 这次要是连上都没连上，它们会被当成这次取到的
      for (const sha of batch) removeQuietly(join(into, `${sha}.part`));
      const config = join(into, `.curl-${process.pid}-${start}.txt`);
      writeFileSync(
        config,
        batch
          .map(
            (sha) => `url = ${quoted(`${base}/${objectPath(sha)}`)}\noutput = ${quoted(join(into, `${sha}.part`))}\n`,
          )
          .join(""),
      );
      const { code, said } = await curlBatch([
        "-fsSL",
        ...NO_DOWNGRADE,
        "--retry",
        "2",
        "--connect-timeout",
        "20",
        // 慢但一直在下的不掐；一分钟一个字节都没收到算断了
        "--speed-limit",
        "1",
        "--speed-time",
        "60",
        ...(parallel ? ["--parallel", "--parallel-max", "8"] : []),
        "-K",
        config,
      ]);
      removeQuietly(config);
      const missing = [];
      let corrupt = null;
      for (const sha of batch) {
        const part = join(into, `${sha}.part`);
        if (!existsSync(part)) {
          missing.push(sha);
          continue;
        }
        const packed = readFileSync(part);
        try {
          unpackObject(packed, sha);
        } catch (error) {
          removeQuietly(part);
          // curl 说了没下完（断了、卡住了）：是没取到，不是取到了坏的
          if (code !== 0) missing.push(sha);
          else corrupt ??= { sha, error };
          continue;
        }
        // 核对过的内容另写一份到正式的名字，不改名：Windows 上刚写出来的文件常被杀毒软件占着，改名会失败
        writeFileSync(join(into, sha), packed);
        removeQuietly(part);
        onBytes?.(packed.length);
      }
      if (missing.length > 0) {
        const url = `${base}/${objectPath(missing[0])}`;
        const reason = said || `curl exit ${code}`;
        throw new LocalizedError(msg("update.unreachable", { url, reason }));
      }
      // 取到了、但解不开或者内容不是名字说的那份：路上坏了，或者下载地址上的坏了
      if (corrupt) {
        throw new LocalizedError(msg("update.checksum", { object: corrupt.sha.slice(0, 12) }), {
          cause: corrupt.error,
        });
      }
    }
  }

  return {
    /** 下载地址上某个文件的网址：自己换不了时告诉用户去哪下 */
    url: (path) => `${base}/${path}`,

    /**
     * 下载地址上最新的发布：版本号（不带 v）、用哪个 Electron、每种装法的清单
     * @param {number} timeoutSeconds 最多等多久
     */
    async channel(timeoutSeconds) {
      const url = `${base}/${CHANNEL}`;
      let text;
      try {
        text = await run("curl", ["-fsSL", ...NO_DOWNGRADE, "--max-time", String(timeoutSeconds), url], { env });
      } catch (error) {
        throw new LocalizedError(msg("update.unreachable", { url, reason: error.said }), { cause: error });
      }
      return parseChannel(text);
    },

    fetchObjects,

    /**
     * 取一份清单（也是一个对象）并核对
     * @returns {Promise<{ manifest: ReturnType<typeof parseManifest>, bytes: number }>} bytes：下了多少（压过的大小），算进这次更新的下载量
     */
    async manifest(sha) {
      const dir = mkdtempSync(join(tmpdir(), "orangespeakeasy-manifest-"));
      try {
        await fetchObjects([sha], dir);
        const packed = readFileSync(join(dir, sha));
        try {
          return { manifest: parseManifest(unpackObject(packed, sha)), bytes: packed.length };
        } catch (error) {
          // 哪里不对（error.message）是给排查的人看的，跟着 cause 进日志；给用户的话只说是哪份清单
          throw new LocalizedError(msg("update.badManifest", { manifest: sha.slice(0, 12) }), { cause: error });
        }
      } finally {
        removeQuietly(dir, { recursive: true });
      }
    },
  };
}
