#!/usr/bin/env node
// Mac 小帮手的回归脚本：起真的小帮手（build/key-helper，源码变了先重编），按场景下发绑定，让发键程序发合成按键，
// 对小帮手报的事件和漏到末尾的键（docs/hotkey-research.md 第 6 步"第 7 步"那一行）。查的是单元测试碰不到的那一半：
// 三个 tap 真的装得上、快速连发不漏（触发 tap 同步打开吞键 tap）、同一个事件经过几个 tap 只算一次、Carbon 吞得住单个 F 键、
// 截着时才吞 esc、自己合成的 ⌘V 不算；录键时只报按住的键码、录到的普通键吞到松开为止、离开后匹配器照常；
// probe 查得出系统快捷键（⌘空格、⌃空格），info 和 defaults 读到的一样。
//
// 用法：node scripts/dev/mac-hotkeys.mjs [--secure-input]
//   --secure-input  再查安全输入期间 Carbon 顶着的组合键（发键程序自己开安全输入，查完关掉）
//
// 合成的键都带记号，在 annotated session 层的末尾被发键程序接住，一个都不会到达任何应用（mac-hotkeys-poster.swift）。
// 跑的时候别碰键盘：自己按的键会混进匹配器。运行它的终端要有输入监控和辅助功能权限。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as same } from "node:util";
import { ensureHelper, helperPaths } from "../../src/cli/native-helper.mjs";

if (process.platform !== "darwin") {
  console.error("只在 Mac 上跑");
  process.exit(2);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const withSecureInput = process.argv.includes("--secure-input");

ensureHelper(ROOT, { onBuild: () => console.log("小帮手的源码变了，先编一遍…") });
const scratch = mkdtempSync(join(tmpdir(), "orangespeakeasy-hotkeys-"));
const posterBinary = join(scratch, "poster");
await run("swiftc", ["-O", "-o", posterBinary, join(ROOT, "scripts/dev/mac-hotkeys-poster.swift")]);
// 锁屏时不跑：末尾接不住的键会打进锁屏的密码框。每个场景开始前发键程序还会自己再查一次
try {
  await run(posterBinary, ["check"]);
} catch (error) {
  console.error(`现在不能发键，没跑：${error.message}`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
}

const helper = spawn(helperPaths(ROOT).binary, ["--no-prompt"], { stdio: ["pipe", "pipe", "inherit"] });
const events = [];
const waiters = [];
createInterface({ input: helper.stdout }).on("line", (line) => {
  events.push(JSON.parse(line));
  for (const waiter of waiters.splice(0)) waiter();
});
const send = (command) => helper.stdin.write(`${JSON.stringify(command)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const take = () => events.splice(0);

/** 等小帮手报出满足条件的事件，最多等 timeoutMs；等到了返回它，没等到是 undefined */
async function waitFor(test, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const found = events.find(test);
    if (found) return found;
    await Promise.race([new Promise((resolve) => waiters.push(resolve)), sleep(50)]);
  }
  return undefined;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} 退出码 ${code}：${out}`))));
  });
}

/** 让发键程序跑一个场景，返回漏到末尾的键 */
async function poster(scenario, ...args) {
  const out = await run(posterBinary, [scenario, ...args]);
  return JSON.parse(out.trim().split("\n").pop()).sink;
}

const short = (event) =>
  event.event === "binding"
    ? `${event.down ? "↓" : "↑"}${event.id}`
    : event.event === "interrupted"
      ? `✕${event.id}${event.to ? `→${event.to}` : ""}`
      : JSON.stringify(event);
const results = [];
const check = (name, ok, detail) => results.push(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
const KEY_DOWN = 10;
const KEY_UP = 11;
const FLAGS_CHANGED = 12;
const count = (sink, type, code) => sink.filter((event) => event.type === type && event.code === code).length;

const DICTATE = { id: "dictate#0", mods: [0x3d], when: "always" };
const CANCEL = { id: "cancel#0", mods: [], key: 0x35, when: "capturing" };
const CHORD = { id: "x#0", mods: [0x3d], key: 0x31, when: "always" };
async function bind(bindings) {
  send({ cmd: "bind", bindings });
  await waitFor((event) => event.event === "bound" || event.event === "error", 2000);
  return take();
}
async function bindings() {
  await sleep(150);
  return take().map(short);
}

try {
  const ready = await waitFor((event) => event.event === "ready", 5000);
  take();
  check("ready：两项权限都有、截得住", ready?.listen && ready?.trusted && ready?.capture, JSON.stringify(ready));

  let got = await bind([DICTATE, CANCEL]);
  check("bound 回执", same(got, [{ event: "bound", rejected: [] }]), JSON.stringify(got));

  let sink = await poster("single");
  got = await bindings();
  check(
    "单按右 Option 三次：按下松开各三次，不重复",
    got.join(" ") === "↓dictate#0 ↑dictate#0 ".repeat(3).trim(),
    got.join(" "),
  );
  check("修饰键不吞：末尾收到 6 个 flagsChanged", count(sink, FLAGS_CHANGED, 0x3d) === 6, JSON.stringify(sink));

  sink = await poster("interrupt");
  got = await bindings();
  check("按着右 Option 再按 K：只报一次打断", got.join(" ") === "↓dictate#0 ✕dictate#0", got.join(" "));
  check("组合外的 K 不吞", count(sink, KEY_DOWN, 0x28) === 1 && count(sink, KEY_UP, 0x28) === 1, JSON.stringify(sink));

  sink = await poster("injected");
  got = await bindings();
  check("自己合成的 ⌘V 不算用户按的键", got.join(" ") === "↓dictate#0 ↑dictate#0", got.join(" "));

  got = await bind([DICTATE, CHORD, CANCEL]);
  check("加了组合键的回执", same(got, [{ event: "bound", rejected: [] }]), JSON.stringify(got));
  // 跑三遍：吞键 tap 开得晚的毛病（比如挪到别的线程上）二十次里可能只露一两次
  let rounds = 0;
  let leaked = 0;
  let sample = "";
  for (let run = 0; run < 3; run++) {
    sink = await poster("chord");
    got = await bindings();
    const round = "↓dictate#0 ✕dictate#0→x#0 ↓x#0 ↑x#0";
    rounds += got.join(" ").split(round).length - 1;
    leaked += count(sink, KEY_DOWN, 0x31) + count(sink, KEY_UP, 0x31);
    if (got.length !== 80) sample ||= got.join(" ").slice(0, 400);
  }
  check("右 Option+空格 60 次（间隔 0–5 ms）：每次都升级成 x#0", rounds === 60 && !sample, `${rounds}/60：${sample}`);
  check("空格一个都没漏出去", leaked === 0, `漏了 ${leaked} 个按下松开`);

  got = await bind([{ id: "f#0", mods: [], key: 0x69, when: "always" }, CANCEL]);
  check("F13 单键的回执", same(got, [{ event: "bound", rejected: [] }]), JSON.stringify(got));
  sink = await poster("carbon");
  got = await bindings();
  check("F13 三次：按下松开各三次", got.join(" ") === "↓f#0 ↑f#0 ".repeat(3).trim(), got.join(" "));
  check(
    "F13 被 Carbon 吞掉，一个都没到末尾",
    count(sink, KEY_DOWN, 0x69) === 0 && count(sink, KEY_UP, 0x69) === 0,
    JSON.stringify(sink),
  );

  await bind([DICTATE, CANCEL]);
  sink = await poster("escape");
  got = await bindings();
  check(
    "不截时按 esc：不报、不吞",
    got.length === 0 && count(sink, KEY_DOWN, 0x35) === 1,
    `${got.join(" ")} ${JSON.stringify(sink)}`,
  );
  send({ cmd: "capture", regions: [] });
  await sleep(150);
  sink = await poster("escape");
  got = await bindings();
  check("截着时按 esc：取消按下松开", got.join(" ") === "↓cancel#0 ↑cancel#0", got.join(" "));
  check("截着时 esc 被吞", count(sink, KEY_DOWN, 0x35) === 0 && count(sink, KEY_UP, 0x35) === 0, JSON.stringify(sink));
  send({ cmd: "release" });
  await sleep(150);
  sink = await poster("escape");
  got = await bindings();
  check(
    "不截了之后 esc 照常放行",
    got.length === 0 && count(sink, KEY_DOWN, 0x35) === 1,
    `${got.join(" ")} ${JSON.stringify(sink)}`,
  );

  // 录键：匹配器停下，只报按住的键码；录到的普通键整段吞掉，修饰键照常放行
  await bind([DICTATE, CHORD, CANCEL]);
  const held = (mods, keys) => ({ event: "recording", on: true, mods, keys });
  send({ cmd: "record", on: true });
  await sleep(150);
  got = take();
  check("进入录键：立刻报一次空快照", same(got, [held([], [])]), JSON.stringify(got));
  sink = await poster("record");
  await sleep(150);
  got = take();
  check(
    "录键时按右 Option+空格：按下报两次快照、松开报两次，不报绑定",
    same(got, [held([0x3d], []), held([0x3d], [0x31]), held([0x3d], []), held([], [])]),
    JSON.stringify(got),
  );
  check(
    "录键时空格的按下、自动重复、松开都吞了",
    count(sink, KEY_DOWN, 0x31) === 0 && count(sink, KEY_UP, 0x31) === 0,
    JSON.stringify(sink),
  );
  check("录键时修饰键的 flagsChanged 照常到末尾", count(sink, FLAGS_CHANGED, 0x3d) === 2, JSON.stringify(sink));
  sink = await poster("injected");
  await sleep(150);
  got = take();
  check(
    "录键时自己合成的 ⌘V 不算、不吞",
    same(got, [held([0x3d], []), held([], [])]) && count(sink, KEY_DOWN, 0x09) === 1 && count(sink, KEY_UP, 0x09) === 1,
    `${JSON.stringify(got)} ${JSON.stringify(sink)}`,
  );
  send({ cmd: "record", on: true });
  await sleep(150);
  got = take();
  check("录着时再说开始：重新开始，再报一次空快照", same(got, [held([], [])]), JSON.stringify(got));
  // 按着空格离开录键模式，离开以后才松开
  const release = join(scratch, "release");
  const holding = poster("hold", release);
  await waitFor((event) => event.event === "recording" && event.keys?.length === 1, 3000);
  send({ cmd: "record", on: false });
  await waitFor((event) => event.event === "recording" && event.on === false, 2000);
  writeFileSync(release, "");
  sink = await holding;
  await sleep(150);
  got = take();
  check("离开录键：报 on:false", same(got, [held([], [0x31]), { event: "recording", on: false }]), JSON.stringify(got));
  check(
    "离开时还按着的空格：之后的自动重复和松开照样吞",
    count(sink, KEY_DOWN, 0x31) === 0 && count(sink, KEY_UP, 0x31) === 0,
    JSON.stringify(sink),
  );
  send({ cmd: "record", on: false });
  await sleep(150);
  got = take();
  check("没在录时说停：什么也不报", got.length === 0, JSON.stringify(got));
  await poster("single");
  got = await bindings();
  check(
    "离开录键以后匹配器照常：单按右 Option 三次",
    got.join(" ") === "↓dictate#0 ↑dictate#0 ".repeat(3).trim(),
    got.join(" "),
  );
  sink = await poster("chord");
  got = await bindings();
  check(
    "离开录键以后右 Option+空格 20 次照样升级、空格不漏",
    got.join(" ") === "↓dictate#0 ✕dictate#0→x#0 ↓x#0 ↑x#0 ".repeat(20).trim() &&
      count(sink, KEY_DOWN, 0x31) + count(sink, KEY_UP, 0x31) === 0,
    `${got.join(" ").slice(0, 400)} ${JSON.stringify(sink).slice(0, 400)}`,
  );

  // probe：⌘空格是 Spotlight、⌃空格是切换输入法（本机系统快捷键表里都启用着），右 Option+F13 没人占
  async function probe(command) {
    send({ cmd: "probe", ...command });
    await waitFor((event) => event.event === "probed" || event.event === "error", 2000);
    await sleep(100);
    return take();
  }
  got = await probe({ id: 1, mods: [0x37], key: 0x31 });
  check(
    "probe 左 ⌘空格：被系统快捷键占了",
    same(got, [{ event: "probed", id: 1, conflict: true, source: "symbolic" }]),
    JSON.stringify(got),
  );
  got = await probe({ id: 2, mods: [0x3e], key: 0x31 });
  check(
    "probe 右 Control+空格：左右合并，也被占了",
    same(got, [{ event: "probed", id: 2, conflict: true, source: "symbolic" }]),
    JSON.stringify(got),
  );
  got = await probe({ id: 3, mods: [0x3d], key: 0x69 });
  check("probe 右 Option+F13：没被占", same(got, [{ event: "probed", id: 3, conflict: false }]), JSON.stringify(got));
  got = await probe({ id: 4, mods: [0x3d] });
  check("probe 只有修饰键：直接不冲突", same(got, [{ event: "probed", id: 4, conflict: false }]), JSON.stringify(got));
  got = await probe({ id: 5, mods: [0x31], key: 0x31 });
  check(
    "probe 形状不对：报 error，照样回一条不冲突",
    got.length === 2 && got[0].event === "error" && same(got[1], { event: "probed", id: 5, conflict: false }),
    JSON.stringify(got),
  );
  got = await probe({ mods: [0x37], key: 0x31 });
  check("probe 没有 id：只报 error", got.length === 1 && got[0].event === "error", JSON.stringify(got));

  // info：和 defaults 读到的同一份；本机没有这一项时不带 fnUsage
  send({ cmd: "info" });
  await waitFor((event) => event.event === "info", 2000);
  got = take();
  const defaults = spawnSync("defaults", ["read", "com.apple.HIToolbox", "AppleFnUsageType"], { encoding: "utf8" });
  const fnUsage = defaults.status === 0 ? Number(defaults.stdout.trim()) : undefined;
  check(
    "info：fnUsage 和 defaults 读到的一样（读不到就不带）",
    same(got, [fnUsage === undefined ? { event: "info" } : { event: "info", fnUsage }]),
    `${JSON.stringify(got)}，defaults：${fnUsage}`,
  );

  if (withSecureInput) {
    await bind([DICTATE, CHORD, CANCEL]);
    const signal = join(scratch, "go");
    const secure = poster("secure", signal);
    const on = await waitFor((event) => event.event === "secure_input" && event.on, 4000);
    check("安全输入开了：报 secure_input，组合键都顶上了", same(on?.unavailable, []), JSON.stringify(on));
    // 顶上了才发键：安全输入下末尾接不住，顶不上的话空格会打进前台应用
    if (same(on?.unavailable, [])) writeFileSync(signal, "");
    await secure;
    const off = await waitFor((event) => event.event === "secure_input" && !event.on, 3000);
    got = take()
      .filter((event) => event.event === "binding" || event.event === "interrupted")
      .map(short);
    check("安全输入关了：报 secure_input", off !== undefined, "没等到");
    check(
      "安全输入下按右 Option+空格三次：由 Carbon 报，照样升级；单按右 Option 照常",
      got.join(" ") === `${"↓dictate#0 ✕dictate#0→x#0 ↓x#0 ↑x#0 ".repeat(3)}↓dictate#0 ↑dictate#0`,
      got.join(" "),
    );

    // 带 fn 的组合 Carbon 顶不了（没有 fn 的修饰位）：照实报出来。不建开始信号，发键程序不发键
    await bind([DICTATE, { id: "fn#0", mods: [0x3f], key: 0x31, when: "always" }, CANCEL]);
    const fnSecure = poster("secure", join(scratch, "never"));
    const fnOn = await waitFor((event) => event.event === "secure_input" && event.on, 4000);
    check("安全输入下带 fn 的组合顶不了：报在 unavailable 里", same(fnOn?.unavailable, ["fn#0"]), JSON.stringify(fnOn));
    await fnSecure;
    await waitFor((event) => event.event === "secure_input" && !event.on, 3000);
    take();
  }

  send({ cmd: "bind", bindings: [{ id: "", mods: [], when: "always" }, DICTATE] });
  await waitFor((event) => event.event === "bound", 2000);
  got = take();
  check(
    "坏绑定只退回那一个",
    same(got, [{ event: "bound", rejected: [{ id: "", reason: "invalid" }] }]),
    JSON.stringify(got),
  );
  send({ cmd: "bind", bindings: "nope" });
  await waitFor((event) => event.event === "error", 2000);
  got = take();
  check("整条形状不对报 error", got.length === 1 && got[0].event === "error", JSON.stringify(got));
} finally {
  helper.stdin.end();
}
const code = await new Promise((resolve) => helper.on("exit", resolve));
check("关掉标准输入后自己退出", code === 0, String(code));
if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });

console.log(results.join("\n"));
const passed = results.filter((line) => line.startsWith("PASS")).length;
console.log(`${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
