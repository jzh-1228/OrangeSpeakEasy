import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runToEnd } from "../update/exec.mjs";

// 换家交给家目录里自带的安装脚本（install.sh、install.ps1 的 ORANGESPEAKEASY_PREVIOUS_HOME）：它试跑那里的程序，
// 把命令的链接、Path、开始菜单、开机启动、定位文件从旧目录改指过去。系统里这些入口长什么样只有安装脚本一处说了算。
// 搬失败时对旧目录再换一次家，就是换回去。

/** 家目录里那一份程序自带的安装脚本；没装程序（Mac 上只装了 dmg 的 App，家目录里只有数据）是 null */
export function installerIn(home, platform = process.platform) {
  if (platform !== "win32") {
    const script = join(home, "app", "install.sh");
    return existsSync(script) ? script : null;
  }
  let current;
  try {
    current = readFileSync(join(home, "current"), "utf8").trim();
  } catch {
    return null;
  }
  if (!current || /[\\/]/.test(current) || current === "." || current === "..") return null;
  const script = join(home, "versions", current, "app", "install.ps1");
  return existsSync(script) ? script : null;
}

/** 这份安装脚本会不会换家（0.12.0 起的才会）。更早的不认 ORANGESPEAKEASY_PREVIOUS_HOME，会当成一次全新的联网安装 */
export function canRehome(script) {
  try {
    return readFileSync(script, "utf8").includes("ORANGESPEAKEASY_PREVIOUS_HOME");
  } catch {
    return false;
  }
}

/** 只给安装、更新用的环境变量：换家时一个都不能带过去，不然它会去装别的、下别的 */
const INSTALLER_ONLY = [
  "ELECTRON_RUN_AS_NODE",
  "ORANGESPEAKEASY_INSTALL_FROM",
  "ORANGESPEAKEASY_INSTALL_DIR",
  "ORANGESPEAKEASY_INSTALL_BASE",
  "ORANGESPEAKEASY_VERSION",
  "ORANGESPEAKEASY_BIN_DIR",
];

/**
 * 让 home 里的安装脚本把 OrangeSpeakEasy 从 previous 换到 home 来
 * @param {{ home: string, previous: string, env: Record<string, string | undefined>, stdio: "inherit" | "forward",
 *   platform?: NodeJS.Platform }} options
 * @returns {Promise<number>} 安装脚本的退出码；home 里没有会换家的安装脚本时抛错
 */
export function rehome({ home, previous, env, stdio, platform = process.platform }) {
  const script = installerIn(home, platform);
  if (script === null || !canRehome(script)) throw new Error(`no installer that can move OrangeSpeakEasy in ${home}`);
  const installerEnv = { ...env, ORANGESPEAKEASY_HOME: home, ORANGESPEAKEASY_PREVIOUS_HOME: previous };
  for (const name of INSTALLER_ONLY) delete installerEnv[name];
  if (platform === "win32") {
    // 和 update/home.mjs 一样：按 UTF-8 读进来当脚本块跑（5.1 直接 -File 会按系统编码读）
    installerEnv.ORANGESPEAKEASY_NO_START = "1";
    installerEnv.ORANGESPEAKEASY_INSTALL_SCRIPT = script;
    const command =
      "& ([scriptblock]::Create([IO.File]::ReadAllText($env:ORANGESPEAKEASY_INSTALL_SCRIPT, [Text.Encoding]::UTF8))); exit $LASTEXITCODE";
    // 在要换到的那个家目录里跑：它起的后台进程（删旧版本的）不占着别的目录
    return runToEnd("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      env: installerEnv,
      stdio,
      cwd: home,
    });
  }
  return runToEnd("/bin/bash", [script, "--no-start"], { env: installerEnv, stdio, cwd: home });
}
