// 把签好名、公证过的 OrangeSpeakEasy.app 装进一个 dmg：打开后左边是应用，右边是"应用程序"的替身，拖过去就装好了。
// dmg 自己也签名、交苹果公证、钉上票据：浏览器下回来的 dmg 带着"来自网络"的标记，系统打开前先查最外面这一层。

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * @param {{ appPath: string, dmgPath: string, signing: { identity: string, notaryProfile: string } }} options
 */
export function makeDmg({ appPath, dmgPath, signing }) {
  const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
  const stage = mkdtempSync(join(tmpdir(), "orangespeakeasy-dmg-"));
  try {
    // ditto 原样拷贝应用包，保留签名、票据和里面的符号链接
    run("ditto", [appPath, join(stage, basename(appPath))]);
    symlinkSync("/Applications", join(stage, "Applications"));
    // ULMO（LZMA）比默认的 UDZO（zlib）小三成（0.10.1 的 App 实测 179 → 125 MB），macOS 10.15 起都打得开（OrangeSpeakEasy 要 12 起）
    run("hdiutil", ["create", "-volname", "OrangeSpeakEasy", "-srcfolder", stage, "-format", "ULMO", "-ov", dmgPath]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  run("codesign", ["--sign", signing.identity, "--timestamp", dmgPath]);
  notarize(dmgPath, signing.notaryProfile);
  run("xcrun", ["stapler", "staple", dmgPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
  // 双击打开 dmg 时系统做的就是这一项检查
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose", dmgPath]);
}

/** 最多交几次、两次之间隔多久：只在没拿到苹果的结论时重交（0.9.4 发版时连苹果超时，整个 ship 断在最后一个包上） */
const NOTARIZE_ATTEMPTS = 3;
const NOTARIZE_RETRY_MS = 30_000;

/** 同步地等 ms 毫秒：打包这一路都是同步的 */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** notarytool 的标准输出里有没有苹果的结论（带编号的 JSON）；连不上苹果时是空的 */
function verdictOf(output) {
  try {
    const result = JSON.parse(output);
    return typeof result?.id === "string" ? result : null;
  } catch {
    return null;
  }
}

/**
 * 交给苹果公证，等结果。没通过时把苹果给的问题清单打出来，再报错。
 * 没拿到结论的失败（连不上、超时）隔一会儿重交；苹果给了不通过的结论就不重交，重交也是一样的结果。
 * @param {{ exec?: typeof execFileSync, wait?: (ms: number) => void, log?: (line: string) => void }} [deps] 测试时换掉
 */
export function notarize(file, profile, { exec = execFileSync, wait = sleep, log = console.log } = {}) {
  const submit = ["notarytool", "submit", file, "--keychain-profile", profile, "--wait", "--output-format", "json"];
  let result = null;
  for (let attempt = 1; result === null; attempt += 1) {
    try {
      const output = exec("xcrun", submit, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
      result = JSON.parse(output);
    } catch (error) {
      // 不通过时 notarytool 也可能非零退出，结论照样在标准输出里
      result = verdictOf(error.stdout);
      if (result !== null) break;
      if (attempt >= NOTARIZE_ATTEMPTS) throw error;
      const reason = error.message.split("\n").filter(Boolean).at(-1);
      log(
        `交给苹果公证没拿到结果（第 ${attempt} 次，共 ${NOTARIZE_ATTEMPTS} 次）：${reason}。${NOTARIZE_RETRY_MS / 1000} 秒后重交`,
      );
      wait(NOTARIZE_RETRY_MS);
    }
  }
  if (result.status === "Accepted") {
    log(`公证通过：${basename(file)}（${result.id}）`);
    return;
  }
  exec("xcrun", ["notarytool", "log", result.id, "--keychain-profile", profile], { stdio: "inherit" });
  throw new Error(`${basename(file)} 没过公证：${result.status} ${result.message ?? ""}（编号 ${result.id}）`);
}
