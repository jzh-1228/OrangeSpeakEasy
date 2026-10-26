import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";

// 让一个目录只有自己进得去：里面有录音和 key。目录里新建的文件跟着目录走，不用一个个设。
//   macOS：权限位 700。
//   Windows：权限位没有意义（chmod 只管只读属性），改的是目录的访问控制表：去掉从上层继承来的条目，
//     只留自己和 SYSTEM，往下的文件和子目录都继承这两条。账户名会按系统语言变，所以按 SID 给，不按名字。
//     放在用户目录下时继承来的本来就差不多是这样（自己、SYSTEM、Administrators），但 ORANGESPEAKEASY_HOME
//     可以指到别的盘上，那里 Users 组通常读得到。

/** SYSTEM 账户。系统服务（备份、杀毒）照常要能读，去掉它反而出怪问题 */
const SYSTEM_SID = "S-1-5-18";

/** 当前用户的 SID：whoami /user 的 CSV 输出是 "机器名\用户名","S-1-5-21-…" */
export function currentUserSid(run = execFileSync) {
  const line = run("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  const sid = line.trim().split(",").at(-1)?.replace(/"/g, "");
  if (!sid?.startsWith("S-1-")) throw new Error(`whoami /user 没给出 SID：${JSON.stringify(line.slice(0, 200))}`);
  return sid;
}

/**
 * @param {string} dir 已经建好的目录
 * @param {object} [options]
 * @param {NodeJS.Platform} [options.platform]
 * @param {typeof execFileSync} [options.run] 测试时换掉
 */
export function restrictToOwner(dir, { platform = process.platform, run = execFileSync } = {}) {
  if (platform !== "win32") {
    chmodSync(dir, 0o700);
    return;
  }
  const grant = (sid) => `*${sid}:(OI)(CI)F`;
  // /inheritance:r 去掉继承来的条目，/grant:r 把这两条换成只有这些（再跑一次结果一样）
  run("icacls", [dir, "/inheritance:r", "/grant:r", grant(currentUserSid(run)), grant(SYSTEM_SID)], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}
