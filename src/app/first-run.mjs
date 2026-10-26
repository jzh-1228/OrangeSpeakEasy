import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { msg, problemOf } from "../i18n/index.mjs";
import { probeTarget } from "../move/probe.mjs";
import { checkLength, homeIn } from "../move/target.mjs";
import { canonicalDir, locationFileOf, writeLocation } from "../storage/location.mjs";
import { legacyDataDir, usedBefore } from "../storage/paths.mjs";

// macOS 上从"应用程序"第一次打开 OrangeSpeakEasy.app：还什么都没装过时，先问一句存储位置放哪（程序数据、本机模型、录音、设置
// 都在那一个文件夹里，模型一个就有零点几到一点几 GB）。默认就是用户目录下的 .orangespeakeasy；选了别处就把那里记进定位文件。
// 问完 App 重新启动一次，照常按定位文件找家目录（storage/paths.mjs）。
// Windows 上程序本身就装在家目录里，位置由安装程序在装之前问（native/windows-setup）；终端安装的由安装脚本问。

/**
 * 这一次是不是要先问：打成应用、不是命令行起的、没指定 ORANGESPEAKEASY_HOME、没有定位文件、默认位置还没有，
 * 也没有 0.1 版的旧数据（有的话是老用户，照旧搬进默认位置，不打扰）
 */
export function needsHomeChoice({ env, platform, packaged, launchedByCli, userHome, exists = existsSync }) {
  if (platform !== "darwin" || !packaged || launchedByCli || env.ORANGESPEAKEASY_HOME) return false;
  if (exists(locationFileOf(env, userHome, platform))) return false;
  if (exists(join(userHome, ".orangespeakeasy"))) return false;
  const legacy = legacyDataDir(userHome, platform);
  return !(legacy && exists(legacy));
}

/**
 * 问存储位置放哪，直到选定。选了默认位置：不写定位文件，只把默认位置的空目录建出来（只让自己进），重新启动后
 * needsHomeChoice 看到它就不再问，不然每次打开都问、App 一直起不来。
 * 选了别处：检查路径、试一下那块盘（exFAT 这类不行），记进定位文件
 * @param {object} options
 * @param {Electron.Dialog} options.dialog
 * @param {(key: string, params?: object) => string} options.t 按系统语言翻（这时还没有设置）
 * @returns {Promise<string>} 选定的家目录
 */
export async function chooseHome({
  dialog,
  t,
  env,
  userHome,
  platform = process.platform,
  probe = probeTarget,
  write = writeLocation,
}) {
  const defaultHome = join(userHome, ".orangespeakeasy");
  const useDefault = () => {
    mkdirSync(defaultHome, { recursive: true, mode: 0o700 });
    return defaultHome;
  };
  const shown = (path) => (path.startsWith(`${userHome}/`) ? `~${path.slice(userHome.length)}` : path);
  const warn = async (problem) => {
    await dialog.showMessageBox({
      type: "warning",
      message: t("firstRun.unusable"),
      detail: t.text(problem),
      buttons: [t("firstRun.again")],
    });
  };
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: "none",
      message: t("firstRun.title"),
      detail: t("firstRun.detail", { home: shown(defaultHome) }),
      buttons: [t("firstRun.useDefault"), t("firstRun.choose")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 0) return useDefault();

    const picked = await dialog.showOpenDialog({
      title: t("firstRun.pickTitle"),
      message: t("firstRun.pickMessage"),
      buttonLabel: t("firstRun.pickButton"),
      defaultPath: existsSync("/Volumes") ? "/Volumes" : userHome,
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || picked.filePaths.length === 0) continue;
    const home = canonicalDir(homeIn(picked.filePaths[0], platform), platform);
    if (home === canonicalDir(defaultHome, platform)) return useDefault();
    try {
      checkLength(home, platform);
      if (existsSync(home) && readdirSync(home).length > 0) {
        if (!usedBefore(home)) {
          await warn(msg("move.notEmpty", { home }));
          continue;
        }
        const { response: reuse } = await dialog.showMessageBox({
          type: "question",
          message: t("firstRun.existing", { home }),
          detail: t("firstRun.existingDetail"),
          buttons: [t("firstRun.reuse"), t("firstRun.again")],
          defaultId: 0,
          cancelId: 1,
        });
        if (reuse !== 0) continue;
      }
      await probe(home, { platform });
      write(locationFileOf(env, userHome, platform), { home });
      return home;
    } catch (error) {
      await warn(problemOf(error));
    }
  }
}
