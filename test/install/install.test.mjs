import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

// 安装脚本的测试：拿一个假的发布包（里面的"Electron"是个记下自己怎么被调用的小脚本）真的跑 install.sh，
// 装进临时的家目录。系统信息（系统版本、芯片、磁盘、是不是 root、连不连得上各家模型）用排在 PATH 前面的
// 同名小脚本冒充，所以不联网，也不碰真的 ~/.orangespeakeasy。
// 每条都要真的执行几个刚生成的脚本，macOS 第一次执行新文件时会先检查它，一次安装要 3–6 秒，
// 所以这一组单独跑、限时放得宽（npm run test:install），不拖慢平时的那一组。

const INSTALLER = resolve(import.meta.dirname, "..", "..", "install.sh");

let root;
/** 冒充用户的家目录 */
let userHome;
/** 放着假发布包的目录，当下载地址用 */
let release;
let shims;
/** 假 Electron 把每次被调用的情况记在这里 */
let callLog;

/** 假的 Electron：记下环境和参数，按第二个参数（脚本路径后面的那个）装样子 */
const FAKE_ELECTRON = `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$ELECTRON_RUN_AS_NODE" "$ORANGESPEAKEASY_HOME" "$#" "$*" >> "$FAKE_CALL_LOG"
case "$2" in
  --version) [ -z "$FAKE_BROKEN" ] || exit 1; echo "$FAKE_VERSION" ;;
  # 真的命令行按终端的语言说话：没指定英文时就说中文（安装脚本靠它说的话判断停没停、搬没搬）
  stop) [ -z "$FAKE_STOP_FAILS" ] || { echo "Couldn't stop OrangeSpeakEasy (pid 1)" >&2; exit 1; }
    [ "$ORANGESPEAKEASY_LANGUAGE" = en ] || { echo "OrangeSpeakEasy 本来就没有在运行。"; exit 0; }; echo "\${FAKE_STOP_SAYS:-OrangeSpeakEasy was not running.}" ;;
esac
`;

/** 排在 PATH 前面、冒充系统命令的小脚本。没被要求装样子时照常转给真的 */
const SHIMS = {
  sw_vers: `#!/bin/sh\necho "\${FAKE_MACOS:-14.5}"\n`,
  uname: `#!/bin/sh\ncase "$1" in -s) echo "\${FAKE_OS:-Darwin}" ;; -m) echo "\${FAKE_ARCH:-arm64}" ;; *) exec /usr/bin/uname "$@" ;; esac\n`,
  id: `#!/bin/sh\n[ "$1" = "-u" ] && [ -n "$FAKE_UID" ] && { echo "$FAKE_UID"; exit 0; }\nexec /usr/bin/id "$@"\n`,
  df: `#!/bin/sh\n[ -n "$FAKE_FREE_KB" ] && { echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/x 9 9 $FAKE_FREE_KB 1% /"; exit 0; }\nexec /bin/df "$@"\n`,
  // 装样子说所有的盘都是 FAKE_FS 格式（比如 exfat）；FAKE_MOUNT_PAD 在后面再列一大串（挂载的盘很多，比管道一次装得下的还多）
  mount: `#!/bin/sh\n[ -n "$FAKE_FS$FAKE_MOUNT_PAD" ] || exec /sbin/mount "$@"\n/sbin/mount | sed "s/ (apfs/ (\${FAKE_FS:-apfs}/"\n[ -z "$FAKE_MOUNT_PAD" ] || awk 'BEGIN { for (i = 0; i < 2000; i++) print "map auto_pad" i " on /Volumes/pad" i " (autofs, automounted, nobrowse)" }'\n`,
  // 只有问各家模型连不连得上的那几次是假的；下载用的 file:// 照常交给真的 curl
  curl: `#!/bin/sh\ncase "$*" in *generativelanguage.googleapis.com*) exit "\${FAKE_GEMINI_EXIT:-0}" ;; *api.openai.com*) exit "\${FAKE_OPENAI_EXIT:-0}" ;; *dashscope.aliyuncs.com*) exit "\${FAKE_BAILIAN_EXIT:-0}" ;; esac\nexec /usr/bin/curl "$@"\n`,
};

/** 摆一棵和包里一样的树（app/ 和 runtime/）：假的 Electron 报这个版本 */
function makeTree(version) {
  const staging = mkdtempSync(join(root, "pkg-"));
  const electron = join(staging, "runtime", "Electron.app", "Contents", "MacOS", "Electron");
  mkdirSync(join(electron, ".."), { recursive: true });
  writeFileSync(electron, FAKE_ELECTRON.replace('"$FAKE_VERSION"', `"${version}"`));
  chmodSync(electron, 0o755);
  mkdirSync(join(staging, "app", "bin"), { recursive: true });
  writeFileSync(join(staging, "app", "bin", "orangespeakeasy.mjs"), "// 假的\n");
  writeFileSync(
    join(staging, "app", "package.json"),
    `{\n  "name": "orangespeakeasy",\n  "version": "${version}"\n}\n`,
  );
  return staging;
}

function makeArchive(arch, version = "9.9.9") {
  const staging = makeTree(version);
  // 和真的下载地址一个样子：每个版本的包在各自的目录里，根上的 channel.json 记着最新的是哪个（release.mjs 写的那种）
  mkdirSync(join(release, `v${version}`), { recursive: true });
  const archive = join(release, `v${version}`, `orangespeakeasy-darwin-${arch}.tar.xz`);
  execFileSync("tar", ["-cJf", archive, "-C", staging, "app", "runtime"]);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  orangespeakeasy-darwin-${arch}.tar.xz\n`);
  const channel = { version, electron: "44.0.0", targets: { [`darwin-${arch}`]: "a".repeat(64) } };
  writeFileSync(join(release, "channel.json"), `${JSON.stringify(channel, null, 2)}\n`);
  rmSync(staging, { recursive: true });
}

beforeEach(() => {
  // 真实路径（/var 其实是 /private/var）：安装脚本把家目录规范成真实路径，比较时两边才一样
  root = realpathSync(mkdtempSync(join(tmpdir(), "smi-")));
  userHome = join(root, "u");
  release = join(root, "release");
  shims = join(root, "shims");
  callLog = join(root, "calls.log");
  for (const dir of [userHome, release, shims]) mkdirSync(dir);
  for (const [name, script] of Object.entries(SHIMS)) {
    writeFileSync(join(shims, name), script);
    chmodSync(join(shims, name), 0o755);
  }
  makeArchive("arm64");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 跑一次安装脚本。env 里可以放 FAKE_* 让某项检查装样子 */
function install({ env = {}, args = [], path = "" } = {}) {
  const result = spawnSync("/bin/bash", [INSTALLER, ...args], {
    encoding: "utf8",
    env: {
      HOME: userHome,
      PATH: `${shims}:${path}/usr/bin:/bin:/usr/sbin:/sbin`,
      ORANGESPEAKEASY_INSTALL_BASE: release,
      FAKE_CALL_LOG: callLog,
      ...env,
    },
  });
  return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr };
}

const home = () => join(userHome, ".orangespeakeasy");
const calls = () => (existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : []);
const installedVersion = (dir = home()) => JSON.parse(readFileSync(join(dir, "app", "package.json"), "utf8")).version;

/** 定位文件（src/storage/location.mjs）：装在默认位置以外时记着 OrangeSpeakEasy 的目录在哪 */
const locationFile = () =>
  join(userHome, "Library", "Application Support", "com.juzihai.orangespeakeasy", "location.json");
const recorded = () => (existsSync(locationFile()) ? JSON.parse(readFileSync(locationFile(), "utf8")).home : null);

test("全新安装：程序和运行环境进了 ~/.orangespeakeasy，命令能用，家目录以外只多一个链接", () => {
  const { code, out, all } = install();
  assert.equal(code, 0, all);
  assert.match(out, /Checks[\s\S]*Install[\s\S]*Installed OrangeSpeakEasy 9\.9\.9/);
  assert.equal(installedVersion(), "9.9.9");
  assert.equal(statSync(home()).mode & 0o777, 0o700, "里面有录音和 key，只有自己进得去");
  // 下载和解包用的临时目录不留下
  assert.deepEqual(readdirSync(home()).sort(), ["app", "bin", "runtime"]);

  const link = join(userHome, ".local", "bin", "orangespeakeasy");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), join(home(), "bin", "orangespeakeasy"));
  assert.equal(readFileSync(join(home(), "bin", "links"), "utf8"), `${link}\n`);
  // 装在默认位置不要定位文件；用户的家目录里除了这两处，没有别的东西
  assert.equal(recorded(), null);
  assert.deepEqual(readdirSync(userHome).sort(), [".local", ".orangespeakeasy"]);

  // 从链接运行：拿自带的 Electron 当 Node，跑的是装好的那份程序，参数原样传过去
  execFileSync(link, ["config", "set", "model", "a b"], { env: { PATH: "/usr/bin:/bin", FAKE_CALL_LOG: callLog } });
  assert.equal(
    calls().at(-1),
    `1|${home()}|5|${join(home(), "app", "bin", "orangespeakeasy.mjs")} config set model a b`,
  );
});

test("没有终端可用时只装不启动，并说怎么启动", () => {
  const { out } = install();
  assert.match(out, /Run orangespeakeasy to start/);
  // 安装过程中只为了问版本和停掉旧的调过程序
  assert.deepEqual(
    calls().map((line) => line.split(" ").at(-1)),
    ["--version", "stop"],
  );
});

test("命令的链接建在 PATH 里的位置；~/.local/bin 不在 PATH 里时说清楚怎么加", () => {
  const missing = install();
  assert.match(missing.out, /isn't on your PATH/);
  assert.match(missing.out, /export PATH=/);

  rmSync(home(), { recursive: true });
  const present = install({ path: `${join(userHome, ".local", "bin")}:` });
  assert.equal(present.code, 0);
  assert.doesNotMatch(present.out, /isn't on your PATH/);
});

test("再装一次就是升级：程序换成新的，设置、key、历史和录音不动；先停掉正在运行的", () => {
  assert.equal(install().code, 0);
  for (const [file, content] of [
    ["settings.json", '{"hotkey":"fn"}'],
    ["gemini-key.bin", "密文"],
    ["data/history.db", "历史"],
    ["data/Recordings/a.webm", "录音"],
  ]) {
    mkdirSync(join(home(), file, ".."), { recursive: true });
    writeFileSync(join(home(), file), content);
  }
  rmSync(callLog);
  makeArchive("arm64", "10.0.0");

  const { code, out } = install({ env: { FAKE_STOP_SAYS: "OrangeSpeakEasy stopped." } });
  assert.equal(code, 0, out);
  assert.match(out, /Found 9\.9\.9/);
  assert.match(out, /Stopped the running OrangeSpeakEasy/);
  assert.match(out, /Upgraded: 9\.9\.9 → 10\.0\.0/);
  assert.equal(installedVersion(), "10.0.0");
  assert.equal(readFileSync(join(home(), "settings.json"), "utf8"), '{"hotkey":"fn"}');
  assert.equal(readFileSync(join(home(), "data", "Recordings", "a.webm"), "utf8"), "录音");
  assert.equal(readFileSync(join(home(), "gemini-key.bin"), "utf8"), "密文");
  assert.deepEqual(readdirSync(home()).sort(), ["app", "bin", "data", "gemini-key.bin", "runtime", "settings.json"]);
  // 链接的清单不重复记
  assert.equal(
    readFileSync(join(home(), "bin", "links"), "utf8")
      .trim()
      .split("\n").length,
    1,
  );
});

test("安装时把 0.1 版搬数据的结果说出来", () => {
  const { out } = install({
    env: { FAKE_STOP_SAYS: "Moved the old version's data to /x/.orangespeakeasy (history.db, Recordings)." },
  });
  assert.match(out, /✓ Moved the old version's data to \/x\/\.orangespeakeasy/);
});

/** 预检查没过、或者中途出错：以非零退出，把原因说清楚，已经装着的不动，没装过的不留下东西 */
function assertRefused(result, reason) {
  assert.equal(result.code, 1, result.all);
  assert.match(result.err, reason);
  assert.match(result.err, /Nothing was installed/);
}

test("预检查不过就不往下走：不是 macOS、系统太旧、用了 sudo、磁盘不够", () => {
  for (const [env, reason] of [
    [{ FAKE_OS: "Linux" }, /only supports macOS/],
    [{ FAKE_MACOS: "11.7.10" }, /macOS 11\.7\.10 is too old/],
    [{ FAKE_UID: "0" }, /Don't run this with sudo/],
    [{ FAKE_FREE_KB: "20480" }, /Not enough disk space: 20 MB free/],
    [{ FAKE_ARCH: "riscv64" }, /Unknown chip/],
  ]) {
    assertRefused(install({ env }), reason);
    assert.equal(existsSync(home()), false, `没装成就不留下目录：${JSON.stringify(env)}`);
    assert.deepEqual(calls(), []);
  }
});

test("Intel 芯片下的是 x64 的包；这个版本没有那种包时在下载之前就说清楚", () => {
  const result = install({ env: { FAKE_ARCH: "x86_64" } });
  assertRefused(result, /Couldn't reach the release package/);
  assert.match(result.err, /orangespeakeasy-darwin-x64\.tar\.xz/);
  assert.equal(existsSync(home()), false);

  makeArchive("x64", "9.9.9");
  assert.equal(install({ env: { FAKE_ARCH: "x86_64" } }).code, 0);
});

test("默认装下载地址上标着最新的那个版本；ORANGESPEAKEASY_VERSION 可以指定另一个，带不带 v 都行", () => {
  makeArchive("arm64", "10.0.0");
  assert.equal(install().code, 0);
  assert.equal(installedVersion(), "10.0.0");

  assert.equal(install({ env: { ORANGESPEAKEASY_VERSION: "v9.9.9" } }).code, 0);
  assert.equal(installedVersion(), "9.9.9");
  assert.equal(install({ env: { ORANGESPEAKEASY_VERSION: "10.0.0" } }).code, 0);
  assert.equal(installedVersion(), "10.0.0");
});

test("问不到最新版本、问到的不像版本号、指定的版本不存在：都在下载之前说清楚，不装", () => {
  writeFileSync(join(release, "channel.json"), '{ "version": "<html>出错了</html>" }\n');
  assertRefused(install(), /returned a bad version number/);
  writeFileSync(join(release, "channel.json"), "<html>出错了</html>\n");
  assertRefused(install(), /Couldn't find the latest version/);

  rmSync(join(release, "channel.json"));
  assertRefused(install(), /Couldn't find the latest version/);

  assertRefused(
    install({ env: { ORANGESPEAKEASY_VERSION: "v1.2.3" } }),
    /Couldn't reach the release package[\s\S]*v1\.2\.3/,
  );
  assertRefused(
    install({ env: { ORANGESPEAKEASY_VERSION: "../../etc" } }),
    /ORANGESPEAKEASY_VERSION doesn't look like a version/,
  );
});

test("安装脚本里查的几家，和程序里登记的模型厂商是同一份", async () => {
  const { PROVIDERS } = await import("../../src/server/providers/index.mjs");
  const listed = readFileSync(INSTALLER, "utf8")
    .match(/^MODEL_HOSTS=\((.*)\)$/m)[1]
    .match(/"[^"]*"/g);
  const names = listed.filter((_, index) => index % 2 === 0).map((quoted) => quoted.slice(1, -1));
  assert.deepEqual(
    names,
    PROVIDERS.map(({ name }) => name),
  );
});

test("能用的几家模型都查一遍连不连得上：连得上的打勾，连不上的只提醒，不拦着安装", () => {
  const both = install();
  assert.equal(both.code, 0);
  assert.match(both.out, /✓ Gemini reachable/);
  assert.match(both.out, /✓ OpenAI reachable/);
  assert.match(both.out, /✓ Bailian reachable/);

  const noGemini = install({ env: { FAKE_GEMINI_EXIT: "7" } });
  assert.equal(noGemini.code, 0);
  assert.match(noGemini.out, /! Can't reach Gemini/);
  assert.match(noGemini.out, /✓ OpenAI reachable/);

  const neither = install({ env: { FAKE_GEMINI_EXIT: "7", FAKE_OPENAI_EXIT: "7" } });
  assert.equal(neither.code, 0);
  assert.match(neither.out, /! Can't reach Gemini/);
  assert.match(neither.out, /! Can't reach OpenAI/);
  // 怎么办只说一遍
  assert.equal(neither.out.match(/need a proxy/g)?.length, 1);
  assert.equal(installedVersion(), "9.9.9");
});

test("下到的包和发布时的不一样（校验不过）：不装，已经装着的那一份不动", () => {
  assert.equal(install().code, 0);
  makeArchive("arm64", "10.0.0");
  writeFileSync(join(release, "v10.0.0", "orangespeakeasy-darwin-arm64.tar.xz.sha256"), `${"0".repeat(64)}  x\n`);
  assertRefused(install(), /Checksum mismatch/);
  assert.equal(installedVersion(), "9.9.9");
  assert.deepEqual(readdirSync(home()).sort(), ["app", "bin", "runtime"]);
});

test("下到的程序在这台机器上跑不起来：换掉旧的之前就发现，旧的不动", () => {
  assert.equal(install().code, 0);
  makeArchive("arm64", "10.0.0");
  assertRefused(install({ env: { FAKE_BROKEN: "1" } }), /won't run on this Mac/);
  assert.equal(installedVersion(), "9.9.9");
});

test("正在运行的停不掉：不换（它还开着旧程序的文件）", () => {
  assert.equal(install().code, 0);
  makeArchive("arm64", "10.0.0");
  const result = install({ env: { FAKE_STOP_FAILS: "1" } });
  assertRefused(result, /Couldn't stop the running OrangeSpeakEasy/);
  assert.equal(installedVersion(), "9.9.9");
});

test("链接的位置上已经有别人的同名文件：不动它，告诉用户用完整路径", () => {
  const theirs = join(userHome, ".local", "bin", "orangespeakeasy");
  mkdirSync(join(theirs, ".."), { recursive: true });
  writeFileSync(theirs, "别人的");
  const { code, out } = install();
  assert.equal(code, 0);
  assert.match(out, /is another orangespeakeasy; left it alone/);
  assert.equal(readFileSync(theirs, "utf8"), "别人的");
  assert.equal(existsSync(join(home(), "bin", "links")), false);
});

test("PATH 里排在前面的是另一个 orangespeakeasy 时提醒一句", () => {
  const other = join(root, "other-bin");
  mkdirSync(other);
  writeFileSync(join(other, "orangespeakeasy"), "#!/bin/sh\n");
  chmodSync(join(other, "orangespeakeasy"), 0o755);
  const { out } = install({ path: `${other}:${join(userHome, ".local", "bin")}:` });
  assert.match(out, /Another orangespeakeasy comes first on your PATH/);
});

test("装到别处（ORANGESPEAKEASY_HOME），路径里有空格和引号也行；链接可以另指一个目录", () => {
  const custom = join(root, "my 'own' home");
  const bin = join(root, "bin dir");
  const { code, out } = install({ env: { ORANGESPEAKEASY_HOME: custom, ORANGESPEAKEASY_BIN_DIR: bin } });
  assert.equal(code, 0, out);
  assert.equal(installedVersion(custom), "9.9.9");
  assert.equal(existsSync(home()), false);
  execFileSync(join(bin, "orangespeakeasy"), ["status"], { env: { PATH: "/usr/bin:/bin", FAKE_CALL_LOG: callLog } });
  assert.equal(calls().at(-1), `1|${custom}|2|${join(custom, "app", "bin", "orangespeakeasy.mjs")} status`);
  // ORANGESPEAKEASY_HOME 只管这一次：不写定位文件（开发时装进临时目录，不能把正式的 App 也指过去）
  assert.equal(recorded(), null);
});

test("装在路径里带反斜杠的文件夹：校验照样对得上，定位文件里记得对", () => {
  // 临时目录的路径本来就长，名字取短：家目录最长 86 个字节
  const folder = join(root, "a\\b");
  mkdirSync(folder);
  const result = install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder } });
  assert.equal(result.code, 0, result.all);
  assert.equal(installedVersion(join(folder, ".orangespeakeasy")), "9.9.9");
  assert.equal(recorded(), join(folder, ".orangespeakeasy"));
});

test("ORANGESPEAKEASY_HOME 装一份试试：不动已有的定位文件", () => {
  const custom = join(root, "Data");
  mkdirSync(custom);
  assert.equal(install({ env: { ORANGESPEAKEASY_INSTALL_DIR: custom } }).code, 0);
  assert.equal(install({ env: { ORANGESPEAKEASY_HOME: join(root, "try") } }).code, 0);
  assert.equal(recorded(), join(custom, ".orangespeakeasy"));
});

test("第一次安装选了文件夹（ORANGESPEAKEASY_INSTALL_DIR）：装进它里面的 .orangespeakeasy、记进定位文件；再运行安装命令照定位文件装回原处", () => {
  const folder = join(root, "my data");
  mkdirSync(folder);
  const first = install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder } });
  assert.equal(first.code, 0, first.all);
  const custom = join(folder, ".orangespeakeasy");
  assert.equal(installedVersion(custom), "9.9.9");
  assert.equal(recorded(), custom);
  assert.equal(existsSync(home()), false);

  makeArchive("arm64", "10.0.0");
  const { code, out } = install();
  assert.equal(code, 0, out);
  assert.match(out, /Found 9\.9\.9/);
  assert.equal(installedVersion(custom), "10.0.0");
  assert.equal(existsSync(home()), false);
});

/**
 * 在终端里跑一次：expect 给它一个伪终端，每看到一次"Folder:"的提问敲进一个回答（answers 按顺序）。
 * 回答用 Tcl 的花括号原样送（里面的反斜杠、空格不转义），所以回答里不能有花括号
 */
function installInTerminal(answers, { env = {} } = {}) {
  const lines = ["set timeout 60", `spawn /bin/bash {${INSTALLER}} --no-start`];
  for (const answer of answers) {
    assert.doesNotMatch(answer, /[{}]/);
    lines.push('expect "Folder: "', `send -- {${answer}}`, 'send "\\r"');
  }
  lines.push("expect eof", "lassign [wait] pid spawnid os code", "exit $code");
  const script = join(root, "answers.exp");
  writeFileSync(script, `${lines.join("\n")}\n`);
  const result = spawnSync("/usr/bin/expect", [script], {
    encoding: "utf8",
    env: {
      HOME: userHome,
      PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ORANGESPEAKEASY_INSTALL_BASE: release,
      FAKE_CALL_LOG: callLog,
      NO_COLOR: "1",
      TERM: "dumb",
      ...env,
    },
  });
  return { code: result.status, all: result.stdout + result.stderr };
}

test("第一次安装、在终端里：先说默认装在哪，回车就装在那里，不多出定位文件", () => {
  const { code, all } = installInTerminal([""]);
  assert.equal(code, 0, all);
  assert.match(all, /Where to install[\s\S]*Press Enter to use ~\/\.orangespeakeasy/);
  assert.equal(installedVersion(), "9.9.9");
  assert.equal(recorded(), null);
});

test("第一次安装、在终端里：输入（或从访达拖进来）一个文件夹就装进它里面的 .orangespeakeasy、记进定位文件；不能装的说清楚再问", () => {
  const disk = join(root, "My Disk");
  mkdirSync(disk);
  // 拖进终端的路径：空格前带反斜杠，末尾一个空格
  const dragged = `${disk.replaceAll(" ", "\\ ")} `;
  const { code, all } = installInTerminal([join(root, "nowhere"), "relative/dir", dragged]);
  assert.equal(code, 0, all);
  assert.match(all, /No such folder/);
  assert.match(all, /Use a full path/);
  const custom = join(disk, ".orangespeakeasy");
  assert.equal(installedVersion(custom), "9.9.9");
  assert.equal(recorded(), custom);
  assert.equal(existsSync(home()), false);
  // 再装一次（升级）不再问
  makeArchive("arm64", "10.0.0");
  const again = installInTerminal([]);
  assert.equal(again.code, 0, again.all);
  assert.doesNotMatch(again.all, /Where to install/);
  assert.equal(installedVersion(custom), "10.0.0");
});

test("第一次安装、在终端里：选的地方已经有别的东西不装；有一份 OrangeSpeakEasy 的就沿用；输入 ~ 是默认位置", () => {
  const taken = join(root, "Taken");
  mkdirSync(join(taken, ".orangespeakeasy"), { recursive: true });
  writeFileSync(join(taken, ".orangespeakeasy", "notes.txt"), "别人的");
  const reused = join(root, "Old");
  mkdirSync(join(reused, ".orangespeakeasy"), { recursive: true });
  writeFileSync(join(reused, ".orangespeakeasy", "settings.json"), '{"hotkey":"fn"}');
  const { code, all } = installInTerminal([taken, `"${reused}"`]);
  assert.equal(code, 0, all);
  assert.match(all, /already has other things in it/);
  assert.match(all, /Found OrangeSpeakEasy data there/);
  assert.equal(recorded(), join(reused, ".orangespeakeasy"));
  assert.equal(readFileSync(join(reused, ".orangespeakeasy", "settings.json"), "utf8"), '{"hotkey":"fn"}');

  rmSync(locationFile());
  rmSync(reused, { recursive: true });
  const tilde = installInTerminal(["~"]);
  assert.equal(tilde.code, 0, tilde.all);
  assert.equal(installedVersion(), "9.9.9");
  assert.equal(recorded(), null);
});

test("选的文件夹在 exFAT、FAT32 这类盘上（套接字、符号链接建不了）：不装，说要哪种格式；问的时候说完再问", () => {
  const folder = join(root, "Stick");
  mkdirSync(folder);
  assertRefused(
    install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder, FAKE_FS: "exfat" } }),
    /is on a disk formatted as exFAT; OrangeSpeakEasy needs APFS or Mac OS Extended/,
  );
  assert.equal(existsSync(join(folder, ".orangespeakeasy")), false);
  const asked = installInTerminal([folder, ""], { env: { FAKE_FS: "exfat" } });
  assert.equal(asked.code, 0, asked.all);
  assert.match(asked.all, /formatted as exFAT/);
  assert.equal(installedVersion(), "9.9.9");
});

test("挂载的盘很多（mount 说的比管道一次装得下的还多）：照样看得出盘是什么格式，不一声不吭地退出", () => {
  const folder = join(root, "Data");
  mkdirSync(folder);
  assertRefused(
    install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder, FAKE_FS: "exfat", FAKE_MOUNT_PAD: "1" } }),
    /formatted as exFAT/,
  );
  const result = install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder, FAKE_MOUNT_PAD: "1" } });
  assert.equal(result.code, 0, result.all);
  assert.equal(installedVersion(join(folder, ".orangespeakeasy")), "9.9.9");
});

test("不在终端里（脚本、CI 调的）：不问，装在默认位置", () => {
  const { code, all } = install();
  assert.equal(code, 0, all);
  assert.doesNotMatch(all, /Where to install/);
});

test("选文件夹：文件夹要已经在；选的就是一个 .orangespeakeasy 时用它本身，不再套一层", () => {
  const custom = join(root, "Data", ".orangespeakeasy");
  assertRefused(install({ env: { ORANGESPEAKEASY_INSTALL_DIR: join(root, "Data") } }), /No such folder/);
  mkdirSync(custom, { recursive: true });
  assert.equal(install({ env: { ORANGESPEAKEASY_INSTALL_DIR: `${custom}/` } }).code, 0);
  assert.equal(recorded(), custom);
  assert.equal(existsSync(join(custom, ".orangespeakeasy")), false);
});

test("选文件夹只用于第一次安装：默认位置已经用过的就停下，说用 orangespeakeasy move；和 ORANGESPEAKEASY_HOME 不能一起给", () => {
  mkdirSync(home());
  writeFileSync(join(home(), "settings.json"), "{}");
  const folder = join(root, "Data");
  mkdirSync(folder);
  assertRefused(
    install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder } }),
    /already set up in[\s\S]*orangespeakeasy move/,
  );
  assert.equal(existsSync(join(folder, ".orangespeakeasy")), false);
  assert.equal(recorded(), null);
  assertRefused(
    install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder, ORANGESPEAKEASY_HOME: home() } }),
    /ORANGESPEAKEASY_INSTALL_DIR or ORANGESPEAKEASY_HOME, not both/,
  );
});

test("选文件夹时别处已经装过：建议的 orangespeakeasy move 命令照抄就能用（路径里有空格、引号）", () => {
  mkdirSync(home());
  writeFileSync(join(home(), "settings.json"), "{}");
  for (const [folder, shown] of [
    [join(root, "a 'b'"), /run: orangespeakeasy move '/],
    [join(userHome, "Data"), /run: orangespeakeasy move ~\/Data$/m],
  ]) {
    mkdirSync(folder);
    const result = install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder } });
    assertRefused(result, /already set up in/);
    assert.match(result.err, shown);
    const command = result.err.match(/run: (orangespeakeasy move .*)$/m)[1];
    const words = execFileSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], {
      encoding: "utf8",
      env: { HOME: userHome },
    });
    assert.deepEqual(words.trim().split("\n"), ["orangespeakeasy", "move", folder]);
  }
});

test("选文件夹（ORANGESPEAKEASY_INSTALL_DIR）时定位文件记着别处：那里现在不在（移动硬盘没接）也停下，不改定位文件", () => {
  // 名字取短：临时目录的路径本来就长，家目录最长 86 个字节
  const unplugged = join(root, "usb", ".orangespeakeasy");
  mkdirSync(join(locationFile(), ".."), { recursive: true });
  writeFileSync(locationFile(), JSON.stringify({ home: unplugged }));
  const folder = join(root, "Data");
  mkdirSync(folder);
  assertRefused(
    install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder } }),
    /Can't find the OrangeSpeakEasy folder[\s\S]*connect the drive[\s\S]*delete/,
  );
  assert.equal(recorded(), unplugged);
  assert.equal(existsSync(join(folder, ".orangespeakeasy")), false);
  // 接上了：说已经装在那里，用 orangespeakeasy move 搬
  mkdirSync(unplugged, { recursive: true });
  writeFileSync(join(unplugged, "settings.json"), "{}");
  assertRefused(
    install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder } }),
    /already set up in[\s\S]*orangespeakeasy move/,
  );
  assert.equal(recorded(), unplugged);
  // 选的就是记着的那一处：照常装
  const same = install({ env: { ORANGESPEAKEASY_INSTALL_DIR: join(root, "usb") } });
  assert.equal(same.code, 0, same.all);
  assert.equal(installedVersion(unplugged), "9.9.9");
});

test("定位文件坏了：不装，也不改装到默认位置（那样看着像数据丢了），说清楚怎么办", () => {
  mkdirSync(join(locationFile(), ".."), { recursive: true });
  for (const text of ["{ 坏了", '{"home": "relative"}', '{"other": "/x"}']) {
    writeFileSync(locationFile(), text);
    const result = install();
    assertRefused(result, /location file is invalid[\s\S]*Delete it to use the default place/);
    assert.equal(existsSync(home()), false);
  }
  // 指定了这一次用哪个目录的不看定位文件：0.11.0 的 orangespeakeasy update 就是这样调新版本的安装脚本的
  assert.equal(install({ env: { ORANGESPEAKEASY_HOME: home() } }).code, 0);
});

test("定位文件说装在一个现在不在的地方（移动硬盘没接、盘被换了）：不在那里新建，也不改装到默认位置", () => {
  mkdirSync(join(locationFile(), ".."), { recursive: true });
  writeFileSync(locationFile(), JSON.stringify({ home: join(root, "unplugged", ".orangespeakeasy") }));
  assertRefused(install(), /Can't find the OrangeSpeakEasy folder[\s\S]*connect the drive/);
  assert.equal(existsSync(join(root, "unplugged")), false);
  // 上一级在、家目录本身不在（盘符现在是另一块盘）：一样不建
  mkdirSync(join(root, "unplugged"));
  assertRefused(install(), /Can't find the OrangeSpeakEasy folder/);
  assert.equal(existsSync(join(root, "unplugged", ".orangespeakeasy")), false);
  assert.equal(existsSync(home()), false);
});

test("定位文件指着一个已经在、还空着的文件夹（App 第一次打开时选的）：装到一半出错也不删它", () => {
  const picked = join(root, "Picked", ".orangespeakeasy");
  mkdirSync(picked, { recursive: true });
  mkdirSync(join(locationFile(), ".."), { recursive: true });
  writeFileSync(locationFile(), JSON.stringify({ home: picked }));
  writeFileSync(join(release, "v9.9.9", "orangespeakeasy-darwin-arm64.tar.xz.sha256"), `${"0".repeat(64)}  x\n`);
  assertRefused(install(), /Checksum mismatch/);
  assert.equal(existsSync(picked), true, "不是这一次建的，不删");
  assert.equal(recorded(), picked);
  makeArchive("arm64");
  assert.equal(install().code, 0);
  assert.equal(installedVersion(picked), "9.9.9");
});

test("启动脚本里不写死路径：整个目录搬到别处、链接改指过去照样能用；外面残留的 ORANGESPEAKEASY_HOME 带不偏", () => {
  assert.equal(install().code, 0);
  const launcher = readFileSync(join(home(), "bin", "orangespeakeasy"), "utf8");
  assert.equal(launcher.includes(userHome), false, launcher);
  const moved = join(root, "moved home", ".orangespeakeasy");
  mkdirSync(join(moved, ".."));
  execFileSync("mv", [home(), moved]);
  const link = join(userHome, ".local", "bin", "orangespeakeasy");
  execFileSync("ln", ["-sfn", join(moved, "bin", "orangespeakeasy"), link]);
  execFileSync(link, ["status"], {
    env: { PATH: "/usr/bin:/bin", FAKE_CALL_LOG: callLog, ORANGESPEAKEASY_HOME: "/old/place/.orangespeakeasy" },
  });
  assert.equal(calls().at(-1), `1|${moved}|2|${join(moved, "app", "bin", "orangespeakeasy.mjs")} status`);
  // 不经链接、直接从 bin 里运行也一样
  execFileSync("./orangespeakeasy", ["status"], {
    cwd: join(moved, "bin"),
    env: { PATH: "/usr/bin:/bin", FAKE_CALL_LOG: callLog },
  });
  assert.equal(calls().at(-1), `1|${moved}|2|${join(moved, "app", "bin", "orangespeakeasy.mjs")} status`);
  // 被复制（不是链接）到别处的：说清楚，不拿错的目录去跑
  const copy = join(root, "copied-orangespeakeasy");
  execFileSync("cp", [join(moved, "bin", "orangespeakeasy"), copy]);
  const copied = spawnSync(copy, ["status"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", FAKE_CALL_LOG: callLog },
  });
  assert.equal(copied.status, 1);
  assert.match(copied.stderr, /must stay in OrangeSpeakEasy's bin folder; link to it/);
});

test("0.11.0 及以前装的（启动脚本里写死了路径）：升级时启动脚本换成新的，你的东西不动，默认位置不多出定位文件", () => {
  // 照 0.11.0 的安装脚本摆出来的样子
  mkdirSync(join(home(), "bin"), { recursive: true });
  execFileSync("tar", ["-xJf", join(release, "v9.9.9", "orangespeakeasy-darwin-arm64.tar.xz"), "-C", home()]);
  const old = `#!/bin/sh\ninstalled_in='${home()}'\nORANGESPEAKEASY_HOME="\${ORANGESPEAKEASY_HOME:-$installed_in}"\nexport ORANGESPEAKEASY_HOME\nELECTRON_RUN_AS_NODE=1 exec '${home()}/runtime/Electron.app/Contents/MacOS/Electron' '${home()}/app/bin/orangespeakeasy.mjs' "$@"\n`;
  writeFileSync(join(home(), "bin", "orangespeakeasy"), old);
  chmodSync(join(home(), "bin", "orangespeakeasy"), 0o755);
  const link = join(userHome, ".local", "bin", "orangespeakeasy");
  mkdirSync(join(link, ".."), { recursive: true });
  execFileSync("ln", ["-s", join(home(), "bin", "orangespeakeasy"), link]);
  writeFileSync(join(home(), "bin", "links"), `${link}\n`);
  writeFileSync(join(home(), "settings.json"), '{"hotkey":"fn"}');
  makeArchive("arm64", "10.0.0");

  const { code, out } = install();
  assert.equal(code, 0, out);
  assert.match(out, /Upgraded: 9\.9\.9 → 10\.0\.0/);
  assert.equal(readFileSync(join(home(), "bin", "orangespeakeasy"), "utf8").includes(home()), false);
  assert.equal(recorded(), null);
  assert.equal(readFileSync(join(home(), "settings.json"), "utf8"), '{"hotkey":"fn"}');
  assert.equal(readFileSync(join(home(), "bin", "links"), "utf8"), `${link}\n`);
  execFileSync(link, ["status"], { env: { PATH: "/usr/bin:/bin", FAKE_CALL_LOG: callLog } });
  assert.equal(calls().at(-1), `1|${home()}|2|${join(home(), "app", "bin", "orangespeakeasy.mjs")} status`);
});

test("选了别处却记不下装在哪（放定位文件的地方被占了）：照实报错，说清楚程序已经装在哪", () => {
  writeFileSync(join(userHome, "Library"), "不是目录");
  const folder = join(root, "Data");
  mkdirSync(folder);
  const result = install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder } });
  assert.equal(result.code, 1, result.all);
  assert.match(result.err, /Couldn't write[\s\S]*OrangeSpeakEasy 9\.9\.9 is in/);
  assert.doesNotMatch(result.err, /Nothing was installed/);
});

/** 把整个目录拷到另一处（orangespeakeasy move 做的那一步），符号链接原样 */
function copyHome(from, to) {
  mkdirSync(join(to, ".."), { recursive: true });
  execFileSync("cp", ["-pPR", from, to]);
}

test("换家（orangespeakeasy move 拷完以后）：不联网、不换程序；命令的链接和定位文件改指到新目录；换回默认位置就删掉定位文件", () => {
  assert.equal(install().code, 0);
  const link = join(userHome, ".local", "bin", "orangespeakeasy");
  const moved = join(root, "Data", ".orangespeakeasy");
  copyHome(home(), moved);
  rmSync(callLog);
  const offline = { ORANGESPEAKEASY_INSTALL_BASE: join(root, "nowhere") };
  const { code, out } = install({
    env: { ...offline, ORANGESPEAKEASY_HOME: moved, ORANGESPEAKEASY_PREVIOUS_HOME: home() },
  });
  assert.equal(code, 0, out);
  assert.match(out, /Copied OrangeSpeakEasy 9\.9\.9[\s\S]*Moved OrangeSpeakEasy 9\.9\.9 to/);
  assert.doesNotMatch(out, /Download server reachable/);
  assert.equal(readlinkSync(link), join(moved, "bin", "orangespeakeasy"));
  assert.equal(recorded(), moved);
  // 只在新目录里试跑、停过，旧目录的程序没动
  assert.deepEqual(
    calls().map((line) => line.split("|")[1]),
    [moved, moved],
  );
  assert.equal(readFileSync(join(moved, "bin", "links"), "utf8"), `${link}\n`);

  // 搬失败时由 orangespeakeasy move 换回去：对旧目录再换一次家
  const back = install({ env: { ...offline, ORANGESPEAKEASY_HOME: home(), ORANGESPEAKEASY_PREVIOUS_HOME: moved } });
  assert.equal(back.code, 0, back.all);
  assert.equal(readlinkSync(link), join(home(), "bin", "orangespeakeasy"));
  assert.equal(recorded(), null);
});

test("换家：新目录里拷过去的程序跑不起来（比如那块盘不让执行）就不改指，原来的照常用", () => {
  assert.equal(install().code, 0);
  const link = join(userHome, ".local", "bin", "orangespeakeasy");
  const moved = join(root, "Data", ".orangespeakeasy");
  copyHome(home(), moved);
  const result = install({
    env: { ORANGESPEAKEASY_HOME: moved, ORANGESPEAKEASY_PREVIOUS_HOME: home(), FAKE_BROKEN: "1" },
  });
  assertRefused(result, /won't run on this Mac/);
  assert.equal(readlinkSync(link), join(home(), "bin", "orangespeakeasy"));
  assert.equal(recorded(), null);
});

test("换家时改不了指着旧目录的命令链接（所在的目录不让写）：停下，不说“装好了、再运行一次”（orangespeakeasy move 接着会换回去）", () => {
  assert.equal(install().code, 0);
  const bin = join(userHome, ".local", "bin");
  const link = join(bin, "orangespeakeasy");
  const moved = join(root, "Data", ".orangespeakeasy");
  copyHome(home(), moved);
  chmodSync(bin, 0o555);
  try {
    const result = install({ env: { ORANGESPEAKEASY_HOME: moved, ORANGESPEAKEASY_PREVIOUS_HOME: home() } });
    assert.equal(result.code, 1, result.all);
    assert.match(result.err, /Couldn't update the link/);
    assert.match(result.err, /Switching OrangeSpeakEasy to .*Data\/\.orangespeakeasy didn't finish/);
    assert.doesNotMatch(result.err, /run this again|Nothing was installed/);
    assert.equal(readlinkSync(link), join(home(), "bin", "orangespeakeasy"));
  } finally {
    chmodSync(bin, 0o755);
  }
});

test("换家换回去（或启动时收拾半路断掉的搬家）：已经指着这里的命令链接不动，所在的目录不让写也照常换完", () => {
  assert.equal(install().code, 0);
  const bin = join(userHome, ".local", "bin");
  const link = join(bin, "orangespeakeasy");
  // 另一条也指着这里，只是写法经过一个符号链接
  const otherBin = join(root, "other bin");
  const other = join(otherBin, "orangespeakeasy");
  const spelled = join(root, "linked-u", ".orangespeakeasy", "bin", "orangespeakeasy");
  execFileSync("ln", ["-s", userHome, join(root, "linked-u")]);
  mkdirSync(otherBin);
  execFileSync("ln", ["-s", spelled, other]);
  writeFileSync(join(home(), "bin", "links"), `${link}\n${other}\n`);
  const moved = join(root, "Data", ".orangespeakeasy");
  copyHome(home(), moved);
  chmodSync(bin, 0o555);
  chmodSync(otherBin, 0o555);
  try {
    const back = install({ env: { ORANGESPEAKEASY_HOME: home(), ORANGESPEAKEASY_PREVIOUS_HOME: moved } });
    assert.equal(back.code, 0, back.all);
    assert.equal(readlinkSync(link), join(home(), "bin", "orangespeakeasy"));
    assert.equal(readlinkSync(other), spelled);
    assert.match(back.out, /orangespeakeasy command: ~\/\.local\/bin\/orangespeakeasy/);
  } finally {
    chmodSync(bin, 0o755);
    chmodSync(otherBin, 0o755);
  }
});

test("换家要和 ORANGESPEAKEASY_HOME 一起给；新目录里没有拷过去的程序不换", () => {
  assert.equal(install().code, 0);
  assertRefused(install({ env: { ORANGESPEAKEASY_PREVIOUS_HOME: home() } }), /goes with ORANGESPEAKEASY_HOME/);
  const empty = join(root, "empty");
  mkdirSync(empty);
  assertRefused(
    install({ env: { ORANGESPEAKEASY_HOME: empty, ORANGESPEAKEASY_PREVIOUS_HOME: home() } }),
    /has no copy of OrangeSpeakEasy/,
  );
  assert.equal(recorded(), null);
});

test("从拼好的树装（orangespeakeasy update）：不联网，家目录里 .update- 开头的那个改名换上，原来的东西不动", () => {
  assert.equal(install().code, 0);
  writeFileSync(join(home(), "settings.json"), '{"hotkey":"fn"}');
  const tree = makeTree("10.0.0");
  const prepared = join(home(), ".update-10.0.0-0badf00d");
  execFileSync("mv", [tree, prepared]);
  // 下载地址指到一个不存在的地方：从拼好的树装不该去问
  const { code, out } = install({
    env: { ORANGESPEAKEASY_INSTALL_FROM: prepared, ORANGESPEAKEASY_INSTALL_BASE: join(root, "nowhere") },
    args: ["--no-start"],
  });
  assert.equal(code, 0, out);
  assert.match(out, /Prepared OrangeSpeakEasy 10\.0\.0/);
  assert.doesNotMatch(out, /Download server reachable/);
  assert.equal(installedVersion(), "10.0.0");
  assert.equal(readFileSync(join(home(), "settings.json"), "utf8"), '{"hotkey":"fn"}');
  assert.deepEqual(
    readdirSync(home()).sort(),
    ["app", "bin", "runtime", "settings.json"],
    "拼好的那个目录换进去以后不留",
  );
});

test("从拼好的树装：只认家目录里 .update- 开头的目录；别处的、不存在的、跑不起来的都不装", () => {
  assert.equal(install().code, 0);
  const elsewhere = makeTree("10.0.0");
  assertRefused(install({ env: { ORANGESPEAKEASY_INSTALL_FROM: elsewhere } }), /must be a \.update- folder inside/);
  assertRefused(
    install({ env: { ORANGESPEAKEASY_INSTALL_FROM: join(home(), ".update-10.0.0-missing") } }),
    /No such folder/,
  );
  const prepared = join(home(), ".update-10.0.0-0badf00d");
  execFileSync("mv", [elsewhere, prepared]);
  assertRefused(
    install({ env: { ORANGESPEAKEASY_INSTALL_FROM: prepared, FAKE_BROKEN: "1" } }),
    /won't run on this Mac/,
  );
  assert.equal(installedVersion(), "9.9.9");
});

test("从拼好的树装：家目录写成 a//b、末尾带 /、经过符号链接，都认得出是它里面的；用 .. 绕出去的不认", () => {
  assert.equal(install().code, 0);
  const prepared = join(home(), ".update-10.0.0-0badf00d");
  execFileSync("mv", [makeTree("10.0.0"), prepared]);
  // 家目录经过一个符号链接、写法又不规整；交来的是真实路径（orangespeakeasy update 规范化过的）
  const linked = join(root, "linked-home");
  execFileSync("ln", ["-s", userHome, linked]);
  const messy = `${linked}//.orangespeakeasy/`;
  const { code, out } = install({
    env: { ORANGESPEAKEASY_HOME: messy, ORANGESPEAKEASY_INSTALL_FROM: prepared },
    args: ["--no-start"],
  });
  assert.equal(code, 0, out);
  assert.equal(installedVersion(), "10.0.0");

  const outside = makeTree("10.0.1");
  mkdirSync(join(home(), ".update-10.0.1-0badf00d"));
  const sneaky = join(home(), ".update-10.0.1-0badf00d", "..", "..", "..", outside.split("/").at(-1));
  assertRefused(install({ env: { ORANGESPEAKEASY_INSTALL_FROM: sneaky } }), /must be a \.update- folder inside/);
  assert.ok(existsSync(join(outside, "app", "package.json")), "绕出去的那个目录没被删");
  assert.equal(installedVersion(), "10.0.0");
});

test("0.11.0 以前的版本（包是 tar.gz）不装：说清楚怎么办；0.10.0 及以前的 orangespeakeasy update 就是这么指定 v0.10.1 的", () => {
  const result = install({ env: { ORANGESPEAKEASY_VERSION: "v0.10.1" } });
  assertRefused(
    result,
    /can't install v0\.10\.1[\s\S]*packaged differently[\s\S]*v0\.10\.1\/OrangeSpeakEasy-arm64\.dmg/,
  );
  assert.equal(existsSync(join(home(), "app")), false);
});

test("0.12.0 以前的版本只认默认位置：不装到别处（卸载它时定位文件会留下、指着删掉的目录）；默认位置照常装", () => {
  makeArchive("arm64", "0.11.0");
  const folder = join(root, "Data");
  mkdirSync(folder);
  assertRefused(
    install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder, ORANGESPEAKEASY_VERSION: "v0.11.0" } }),
    /v0\.11\.0 can only be installed in ~\/\.orangespeakeasy[\s\S]*v0\.12\.0/,
  );
  assert.equal(existsSync(join(folder, ".orangespeakeasy")), false);
  assert.equal(recorded(), null);
  // 已经装在别处（照定位文件）的，也不降到它：先搬回默认位置
  makeArchive("arm64", "9.9.9");
  assert.equal(install({ env: { ORANGESPEAKEASY_INSTALL_DIR: folder } }).code, 0);
  assertRefused(install({ env: { ORANGESPEAKEASY_VERSION: "v0.11.0" } }), /orangespeakeasy move ~/);
  assert.equal(installedVersion(join(folder, ".orangespeakeasy")), "9.9.9");
  assert.equal(recorded(), join(folder, ".orangespeakeasy"));

  rmSync(locationFile());
  assert.equal(install({ env: { ORANGESPEAKEASY_VERSION: "v0.11.0" } }).code, 0);
  assert.equal(installedVersion(), "0.11.0");
});

test("从拼好的树装：只是改名换上，磁盘剩得不多也装（拼的时候已经占过地方了）", () => {
  assert.equal(install().code, 0);
  const prepared = join(home(), ".update-10.0.0-0badf00d");
  execFileSync("mv", [makeTree("10.0.0"), prepared]);
  const { code, out } = install({
    env: { ORANGESPEAKEASY_INSTALL_FROM: prepared, FAKE_FREE_KB: String(300 * 1024) },
    args: ["--no-start"],
  });
  assert.equal(code, 0, out);
  assert.equal(installedVersion(), "10.0.0");
  // 下载安装照旧要查
  assertRefused(install({ env: { FAKE_FREE_KB: String(300 * 1024) } }), /Not enough disk space/);
});

test("不认识的参数：不装", () => {
  assertRefused(install({ args: ["--force"] }), /Unknown option: --force/);
  assert.equal(existsSync(home()), false);
});

test("脚本给人看的话都是英文：除了注释，一个汉字都没有", () => {
  const lines = readFileSync(INSTALLER, "utf8").split("\n");
  const chinese = lines
    .map((line, index) => [index + 1, line])
    .filter(([, line]) => !/^\s*#/.test(line) && /\p{Script=Han}/u.test(line));
  assert.deepEqual(chinese, []);
});
