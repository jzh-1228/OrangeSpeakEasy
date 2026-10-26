import { existsSync, readdirSync, rmdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { TimeoutError } from "../control.mjs";
import { LocalizedError, msg, problemOf } from "../i18n/index.mjs";
import { sizeText } from "../models/describe.mjs";
import { canonicalDir, readLocationRecord, removeLocation, sameHome, writeLocation } from "../storage/location.mjs";
import { MOVED_FILE, usedBefore } from "../storage/paths.mjs";
import { createBundles } from "../update/bundle.mjs";
import { runToEnd } from "../update/exec.mjs";
import { acquireLock, isAlive } from "../update/state.mjs";
import { classifyHome, copyHome, measureHome, verifyCopy } from "./copy.mjs";
import { canRehome, installerIn, rehome } from "./installer.mjs";
import { probeTarget } from "./probe.mjs";
import { moverAlive, readMoveRecord, stillMoving, stillRunning, writeMoveRecord } from "./state.mjs";
import { checkTarget } from "./target.mjs";

// 把整个家目录搬到别处（orangespeakeasy move、App 设置里的"存储位置"）。命令行和 App 都只调这里。按这个顺序：
//   1. 检查新位置（target.mjs）、本机每一份 OrangeSpeakEasy 都认得换家（家目录里的程序、Mac 上"应用程序"里的 App）
//   2. 拿锁（和更新共用 update.lock），旧目录 run/move.json 记"正在搬"（这时 App、后台都不在这里启动），
//      定位文件记上 moving（断了电下次认得出新位置那一份是半成品），新位置的 run/move.json 记下同一次搬家（收拾时只认它）
//   3. 在新位置试盘（probe.mjs）；停掉正在运行的；只拷 OrangeSpeakEasy 自己的东西（copy.mjs），核对符号链接
//   4. 提交：新位置的安装脚本换家（试跑、改系统入口、写定位文件；installer.mjs）。没装程序的（Mac 上只装了 dmg 的）直接写定位文件
//   5. 旧目录放下 MOVED.json（从残留的旧入口启动会被告知搬去了哪），原来在运行的从新位置重新打开，删旧目录
//      （只删我们的；Windows 上这个进程自己就跑在旧目录的程序上，等它退出再删）
// 提交之前任何一步出错：旧目录原样在用，改过的入口换回去（对旧目录再换一次家），定位文件换回去，拷了一半的删掉，照实报。
// 搬到一半进程没了（断电、被结束）：下次启动、再搬一次时 settleMove 照定位文件里的 moving 收拾好；
// 从拷了一半的那一份启动的（入口已经改指过去了），先把入口换回旧目录。

/** 新位置的剩余空间至少多留这么多：日志、更新时下的块还要地方 */
const SPARE_BYTES = 200 * 1024 * 1024;

const pathModule = (platform) => (platform === "win32" ? win32 : posix);

/** 另一个家目录的摆法：paths 里落在 from 下面的都换到 home 下面（不经定位文件，不看 MOVED.json） */
function pathsFor(paths, home) {
  const from = paths.home;
  const sub = { ...paths, home };
  for (const [name, value] of Object.entries(paths)) {
    if (name === "home" || typeof value !== "string") continue;
    if (value.startsWith(`${from}/`) || value.startsWith(`${from}\\`)) sub[name] = home + value.slice(from.length);
  }
  return sub;
}

/**
 * 删掉一个家目录里 OrangeSpeakEasy 的东西，不认识的留着。只剩 MOVED.json（或者什么都不剩）就连目录一起删；
 * 还有别的东西时 MOVED.json 留着：从那里启动的会被告知搬去了哪
 * @returns {string[]} 留下没删的（不认识的）
 */
function removeOurs(paths, home) {
  if (!existsSync(home)) return [];
  const contents = classifyHome(pathsFor(paths, home));
  for (const name of [...contents.move, ...contents.leftovers])
    rmSync(join(home, name), { recursive: true, force: true });
  const rest = readdirSync(home).filter((name) => name !== MOVED_FILE);
  if (rest.length === 0) {
    rmSync(join(home, MOVED_FILE), { force: true });
    rmdirSync(home);
  }
  return rest;
}

/** 两个写法是不是同一个家目录（经过符号链接、大小写不同的也认，见 target.mjs 的 canonicalDir） */
const sameDir = (a, b, platform) => sameHome(canonicalDir(a, platform), canonicalDir(b, platform), platform);

/** 记下 OrangeSpeakEasy 在哪：默认位置不要定位文件，别处就写（按正式写法） */
function commitLocation(paths, home, defaultHome, platform) {
  if (sameDir(home, defaultHome, platform)) removeLocation(paths.locationFile);
  else writeLocation(paths.locationFile, { home: canonicalDir(home, platform) });
}

/**
 * 家目录里装着程序：Mac 上终端装的（app、runtime、bin），Windows 上的（versions、current，0.9.2 及以前是 app、runtime）。
 * Mac 上只装了 dmg 的，家目录里只有数据
 */
function hasProgram(home, platform) {
  const names = platform === "win32" ? ["versions", "current", "app", "runtime", "bin"] : ["app", "runtime", "bin"];
  return names.some((name) => existsSync(join(home, name)));
}

/** 这个家目录里有会换家的安装脚本（0.12.0 起的） */
function rehomeable(home, platform) {
  const script = existsSync(home) ? installerIn(home, platform) : null;
  return script !== null && canRehome(script);
}

/**
 * 删掉搬到一半拷过去的那一份。只认这次搬家自己的记号：拷之前在新位置的 run/move.json 记下了同一次的开始时间。
 * 对不上的（定位文件被改过、同一个盘符换成了另一块盘）不碰；还空着的（刚建好就断了）删掉空目录
 * @returns {boolean} 收拾掉了，或者本来就没有
 */
function discardInterrupted(paths, moving) {
  const to = moving.to;
  if (!existsSync(to)) return true;
  let marker = null;
  try {
    marker = readMoveRecord(pathsFor(paths, to));
  } catch {
    marker = null;
  }
  if (typeof moving.startedAt === "string" && marker?.startedAt === moving.startedAt) {
    removeOurs(paths, to);
    return true;
  }
  if (readdirSync(to).length > 0) return false;
  rmdirSync(to);
  return true;
}

/**
 * 卸载时用：上次从这个家目录搬到一半断了的话，删掉拷过去的那一份（只认这次搬家的记号）。
 * 不然录音、历史、key 留在新位置上，定位文件随着卸载一删，就没人知道它在那里了
 * @returns {string | null} 删掉的那一份在哪；没有、还在搬、不是这次拷的都是 null
 */
export function discardInterruptedMove({ paths, platform = process.platform, alive = moverAlive, now }) {
  const location = readLocationRecord(paths.locationFile, platform);
  const moving = location?.moving;
  if (!moving || !sameDir(location.home, paths.home, platform) || !existsSync(moving.to)) return null;
  if (stillRunning(moving, { alive, now })) return null;
  return discardInterrupted(paths, moving) ? moving.to : null;
}

/**
 * 从拷了一半的那一份启动、搬家的进程已经没了：入口（Windows 的开始菜单、Path，Mac 上命令的链接）可能已经改指到这里。
 * 让旧目录的安装脚本把入口换回旧目录，定位文件照旧记着 moving（从旧目录启动时照它删掉这一份），说再打开一次。
 * 这一份正在用，不删。总是抛出
 */
async function putBack({ paths, location, env, stdio, platform, runRehome }) {
  const { home: from, moving } = location;
  if (!rehomeable(from, platform)) {
    throw new LocalizedError(msg("move.unfinishedCopy", { home: paths.home, from }));
  }
  const code = await runRehome({ home: from, previous: paths.home, env, stdio, platform });
  // 安装脚本换家时把定位文件写成了 { home: 旧目录 }：moving 写回去
  writeLocation(paths.locationFile, { home: from, moving });
  if (code !== 0) throw new LocalizedError(msg("move.restoreFailed", { home: from, code }));
  throw new LocalizedError(msg("move.putBack", { home: paths.home, from }));
}

/**
 * 启动之前、搬家之前看一眼有没有搬到一半的：
 *   - 正在搬（搬的那个进程还在）：不在这里启动，照实说
 *   - 上次搬到一半那个进程没了：旧目录照常在用。从旧目录启动的，把改指了一半的系统入口换回来（对旧目录再换一次家）、
 *     删掉新位置上拷了一半的、定位文件去掉 moving；从拷了一半的那一份启动的，把入口换回旧目录，说再打开一次
 * App 启动、命令行起后台、orangespeakeasy move 都先调它。什么事都没有时什么都不做。
 * 启动时（atStartup）入口换不回来：旧目录完好，照常起来，说一声；拷了一半的留着（入口可能还指着它），下次再收拾
 * @throws {LocalizedError} move.inProgress / move.putBack / move.unfinishedCopy / move.restoreFailed
 */
export async function settleMove({
  paths,
  env,
  platform = process.platform,
  stdio = "inherit",
  userHome = homedir(),
  runRehome = rehome,
  pid = process.pid,
  alive = moverAlive,
  now,
  atStartup = false,
  report = () => {},
}) {
  const record = readMoveRecord(paths);
  if (record?.pid !== pid && stillMoving(record, { alive, now })) {
    throw new LocalizedError(msg("move.inProgress", { home: paths.home, to: record.to ?? "?" }));
  }
  let location = null;
  try {
    location = readLocationRecord(paths.locationFile, platform);
  } catch {
    // 定位文件坏了由找家目录的那一步报（paths.mjs）
    return;
  }
  const moving = location?.moving;
  if (!moving) return;
  if (moving.pid !== pid && stillRunning(moving, { alive, now })) {
    throw new LocalizedError(msg("move.inProgress", { home: location.home, to: moving.to }));
  }
  if (sameDir(moving.to, paths.home, platform)) {
    await putBack({ paths, location, env, stdio, platform, runRehome });
  }
  if (!sameDir(location.home, paths.home, platform)) return;
  const from = paths.home;
  if (existsSync(moving.to) && rehomeable(from, platform)) {
    const code = await runRehome({ home: from, previous: moving.to, env, stdio, platform });
    if (code !== 0) {
      const problem = msg("move.restoreFailed", { home: from, code });
      if (!atStartup) throw new LocalizedError(problem);
      report(problem);
      return;
    }
  }
  if (!discardInterrupted(paths, moving)) report(msg("move.notOurCopy", { to: moving.to }));
  commitLocation(paths, from, pathModule(platform).join(userHome, ".orangespeakeasy"), platform);
  if (record?.state === "running") {
    writeMoveRecord(paths, {
      ...record,
      state: "failed",
      problem: msg("move.interrupted"),
      finishedAt: new Date().toISOString(),
    });
  }
  report(msg("move.recovered", { home: from, to: moving.to }));
}

/**
 * @param {object} options
 * @param {ReturnType<import("../storage/paths.mjs").resolvePaths>} options.paths 现在的家目录
 * @param {Record<string, string | undefined>} options.env 交给安装脚本、重新打开的 App 的环境（不能带着只给这一次用的变量）
 * @param {ReturnType<import("../instance.mjs").createInstance>} options.instance 现在家目录里正在运行的那个
 * @param {"inherit" | "forward"} [options.stdio] 安装脚本、启动命令说的话接到哪（update/exec.mjs）
 * @param {string | null} [options.selfBundle] Mac 上这份程序所在的应用包（App 发起时）
 * @param {(app: string, home: string) => Promise<void>} [options.openApp] 把 Mac 的 App 从新位置重新打开
 * @param {{ clearUserHome?: (home: string) => boolean,
 *   removeHomeAfterExit?: (home: string, names: string[], pids: number[]) => void } | null} [options.system]
 *   Windows 上要动系统的几处（src/windows-system.mjs）
 */
export function createMove({
  paths,
  env,
  instance,
  platform = process.platform,
  stdio = "inherit",
  selfBundle = null,
  userHome = homedir(),
  bundles = createBundles({ env, release: null, platform }),
  probe = probeTarget,
  runRehome = rehome,
  openApp = (app, home) =>
    createBundles({ env: { ...env, ORANGESPEAKEASY_HOME: home }, release: null, platform }).open(app),
  system = null,
  pid = process.pid,
  ppid = process.ppid,
  alive = isAlive,
  moverAlive: isMoverAlive = moverAlive,
  now = () => new Date(),
}) {
  const path = pathModule(platform);
  const defaultHome = path.join(userHome, ".orangespeakeasy");
  const from = paths.home;

  /** 先收拾上一次搬到一半的（settleMove） */
  const settle = (report = () => {}) =>
    settleMove({ paths, env, platform, stdio, userHome, runRehome, pid, alive: isMoverAlive, now, report });

  /** 正在运行的那个；卡住不答话的是 "hung" */
  async function runningNow() {
    try {
      return await instance.status();
    } catch (error) {
      if (error instanceof TimeoutError) return "hung";
      throw error;
    }
  }

  /** Mac 上"应用程序"里的 App（或者正在跑的那个应用包）；它认不认定位文件 */
  async function findApp(running) {
    if (platform !== "darwin") return null;
    const pidOfApp = running && running !== "hung" && running.packaged ? running.pid : null;
    return bundles.find({ pid: pidOfApp, self: selfBundle });
  }

  /** 本机每一份都得认得换家：不然搬完以后，旧的那一份找不到新位置（看着像数据丢了），或者换不了家 */
  function checkCopies(app) {
    // 装着程序却没有会换家的安装脚本（Mac 上 0.10.x 的终端安装 app 里不带 install.sh；0.11.0 的不认换家；
    // Windows 上 current 坏了）：不能当成只装了 dmg 的来搬，不然命令、开始菜单还指着旧目录，旧目录又被删了
    if (hasProgram(from, platform) && !rehomeable(from, platform)) {
      throw new LocalizedError(msg("move.homeTooOld", { home: from }));
    }
    if (app && !existsSync(join(app.path, "Contents", "Resources", "app", "src", "storage", "location.mjs"))) {
      throw new LocalizedError(msg("move.appTooOld", { app: app.path, version: app.version }));
    }
  }

  /** 新位置的盘够不够：同一块 APFS 上拷是克隆，不另占地方 */
  function checkSpace(folder, bytes) {
    if (platform === "darwin" && statSync(folder).dev === statSync(from).dev) return;
    const { bavail, bsize } = statfsSync(folder);
    const free = Number(bavail) * Number(bsize);
    if (free < bytes + SPARE_BYTES) {
      throw new LocalizedError(
        msg("move.noSpace", { need: sizeText(bytes + SPARE_BYTES), free: sizeText(free), folder }),
      );
    }
  }

  /**
   * 只搬记着的那一个（定位文件说的，没有就是默认位置）。这一次的家目录是 ORANGESPEAKEASY_HOME 临时指的（开发、测试）时不搬：
   * 不然定位文件会改指到它，真正装着的那一份就被盖住了。
   * 例外是 0.11.0 及以前用 ORANGESPEAKEASY_HOME 装到别处的：从来没记进定位文件。没有定位文件、默认位置没装过、
   * 这里装着会换家的程序，就认它（搬完记下新位置）
   */
  function checkRecorded() {
    const record = readLocationRecord(paths.locationFile, platform);
    const recorded = record?.home ?? defaultHome;
    if (sameDir(recorded, from, platform)) return;
    if (record === null && rehomeable(from, platform) && !usedBefore(defaultHome)) return;
    throw new LocalizedError(msg("move.notRecorded", { home: from, recorded }));
  }

  /** 检查新位置、本机的每一份、盘够不够。交回新家目录、要搬的、要拷多少 */
  async function prepare(folder, { keep }) {
    checkRecorded();
    const { home: to } = checkTarget({ paths, folder, platform });
    const running = await runningNow();
    const app = await findApp(running);
    checkCopies(app);
    const contents = classifyHome(paths);
    const size = measureHome({ from, plan: contents });
    checkSpace(path.dirname(to), size.bytes);
    // 试盘放在最后、停掉正在运行的之前：盘不行（exFAT 这类）就在问"确定吗"之前说，不让 App 白退出一次。
    // 只是问一句（keep 为假）时，这里建的目录试完就删
    const { created } = await probe(to, { platform });
    if (!keep && created) rmSync(to, { recursive: true, force: true });
    return { to, running, app, contents, size, created };
  }

  /**
   * 把停掉的那个重新打开：家目录里那一份用它的启动命令，Mac 的 App 用 open。打不开照实交回原因。
   * 在它自己的家目录里起：Windows 上工作目录是哪个文件夹，那个文件夹就删不掉，不能让它占着旧目录
   */
  async function reopen(stopped, appPath, home, report) {
    if (stopped === "bundle" && appPath) {
      await openApp(appPath, home);
      report(msg("move.reopened"));
    } else if (stopped === "home") {
      const { ELECTRON_RUN_AS_NODE: _asNode, ...startEnv } = env;
      startEnv.ORANGESPEAKEASY_HOME = home;
      const code =
        platform === "win32"
          ? await runToEnd(`"${path.join(home, "bin", "orangespeakeasy.cmd")}" start`, [], {
              env: startEnv,
              stdio,
              shell: true,
              cwd: home,
            })
          : await runToEnd(path.join(home, "bin", "orangespeakeasy"), ["start"], { env: startEnv, stdio, cwd: home });
      if (code !== 0) throw new LocalizedError(msg("move.restartFailed", { code }));
    }
  }

  /** 搬不成：删掉拷过去的。新家目录是这里建的就整个删；本来就有的（空的）只删里面的，目录留着 */
  function discardCopy(to, created) {
    if (created) {
      rmSync(to, { recursive: true, force: true });
      return;
    }
    if (!existsSync(to)) return;
    for (const name of readdirSync(to)) rmSync(join(to, name), { recursive: true, force: true });
  }

  async function move(folder, by, report, onProgress) {
    const record = { state: "running", by, from, to: null, pid, startedAt: now().toISOString() };
    let to = null;
    /** 新家目录是不是这里建的：搬不成时整个删；本来就有（空的）就只删里面拷进去的 */
    let created = false;
    let touched = false;
    let copied = false;
    let stopped = null;
    let appPath = null;
    let contents = null;
    let stats = null;
    try {
      await settle(report);
      const prepared = await prepare(folder, { keep: true });
      to = prepared.to;
      created = prepared.created;
      touched = true;
      record.to = to;
      writeMoveRecord(paths, record);
      writeLocation(paths.locationFile, {
        home: canonicalDir(from, platform),
        moving: { to, pid, startedAt: record.startedAt },
      });
      // 新位置也记一份：断了以后收拾时，认得出那里是这次拷的（run/ 不拷，不会和拷过去的撞上）
      writeMoveRecord(pathsFor(paths, to), record);

      if (prepared.running !== null) {
        if (prepared.running !== "hung") stopped = prepared.running.packaged ? "bundle" : "home";
        appPath = stopped === "bundle" ? (prepared.app?.path ?? null) : null;
        await instance.stop();
      }
      // 停掉之后再看一遍：停之前它可能还在写
      contents = classifyHome(paths);
      const total = measureHome({ from, plan: contents });
      report(msg("move.copying", { to }));
      onProgress({ files: 0, bytes: 0, total });
      stats = await copyHome({ from, to, plan: contents, onProgress: (done) => onProgress({ ...done, total }) });
      try {
        verifyCopy({ to });
      } catch (error) {
        throw new LocalizedError(msg("move.copyBroken", { reason: error.message }), { cause: error });
      }
      copied = true;
      report(msg("move.switching"));
      if (installerIn(to, platform) !== null) {
        const code = await runRehome({ home: to, previous: from, env, stdio, platform });
        if (code !== 0) throw new LocalizedError(msg("move.rehomeFailed", { code }));
      } else {
        commitLocation(paths, to, defaultHome, platform);
      }
    } catch (error) {
      // 没提交：旧目录照常在用。改过的入口换回去，定位文件换回去，拷的删掉，原来在运行的从旧位置重新打开
      const problems = [];
      const attempt = async (step) => {
        try {
          await step();
        } catch (failure) {
          problems.push(problemOf(failure));
        }
      };
      if (copied && installerIn(from, platform) !== null) {
        await attempt(async () => {
          const code = await runRehome({ home: from, previous: to, env, stdio, platform });
          if (code !== 0) throw new LocalizedError(msg("move.restoreFailed", { home: from, code }));
        });
      }
      // 先删拷过去的、再去掉定位文件里的 moving：两步之间断了的话，下次照 moving 接着删
      if (touched) await attempt(() => discardCopy(to, created));
      if (record.to !== null) await attempt(() => commitLocation(paths, from, defaultHome, platform));
      if (record.to !== null) {
        await attempt(() =>
          writeMoveRecord(paths, {
            ...record,
            state: "failed",
            problem: problemOf(error),
            finishedAt: now().toISOString(),
          }),
        );
      }
      await attempt(() => reopen(stopped, appPath, from, report));
      for (const problem of problems) report(msg("move.cleanupProblem", { problem }));
      throw error;
    }

    // 提交了：新位置就是 OrangeSpeakEasy 的家。以下哪一步出问题都不再退回，照实说
    const result = {
      from,
      to,
      files: stats.files,
      bytes: stats.bytes,
      unknown: contents.unknown,
      left: [],
      later: false,
    };
    try {
      writeMoveRecord(pathsFor(paths, to), { ...record, state: "done", finishedAt: now().toISOString() });
    } catch (error) {
      report(msg("move.recordFailed", { reason: error.code ?? error.message }));
    }
    // 旧目录里放下记号：删完之前从残留的旧入口启动的，会被告知搬去了哪（paths.mjs）
    try {
      writeFileSync(join(from, MOVED_FILE), JSON.stringify({ to }));
    } catch (error) {
      report(msg("move.leftover", { dir: from, reason: error.code ?? error.message }));
    }
    if (system?.clearUserHome) {
      try {
        if (system.clearUserHome(from)) report(msg("move.clearedEnv"));
      } catch (error) {
        report(msg("move.leftover", { dir: "ORANGESPEAKEASY_HOME", reason: error.message }));
      }
    }
    try {
      await reopen(stopped, appPath, to, report);
    } catch (error) {
      report(msg("move.reopenFailed", { reason: problemOf(error) }));
    }
    // 删旧目录：只删我们的。Windows 上这个进程（和起它的 orangespeakeasy.cmd）跑在旧目录的程序上，删不掉自己，交给退出之后
    if (platform === "win32" && system?.removeHomeAfterExit) {
      try {
        system.removeHomeAfterExit(from, [...contents.move, ...contents.leftovers], [pid, ppid]);
        result.later = true;
      } catch (error) {
        report(msg("move.leftover", { dir: from, reason: error.message }));
      }
      result.left = contents.unknown;
    } else {
      try {
        result.left = removeOurs(paths, from);
      } catch (error) {
        report(msg("move.leftover", { dir: from, reason: error.code ?? error.message }));
        result.left = [from];
      }
    }
    return result;
  }

  return {
    /**
     * 能不能搬到这个文件夹、要拷多少：给命令行、App 在动手之前问一句"确定吗"用。
     * 除了在新位置试一下盘（试完删掉）不动磁盘
     * @returns {Promise<{ from: string, to: string, files: number, bytes: number, unknown: string[] }>}
     */
    async plan(folder) {
      // 上次搬到一半断了的先收拾：不然再选同一个地方会被当成"不是空的"，让用户自己去删
      await settle();
      const { to, contents, size } = await prepare(folder, { keep: false });
      return { from, to, files: size.files, bytes: size.bytes, unknown: contents.unknown };
    },

    /**
     * 搬。成了交回结果；没成抛出原因（旧目录照常在用）
     * @param {{ folder: string, by: "cli" | "app", report?: (message: object) => void,
     *   onProgress?: (progress: { files: number, bytes: number, total: { files: number, bytes: number } }) => void }} options
     * @returns {Promise<{ from: string, to: string, files: number, bytes: number, unknown: string[], left: string[],
     *   later: boolean }>} left：旧目录里留下没删的；later：旧目录等这个进程退出后再删（Windows）
     */
    async run({ folder, by, report = () => {}, onProgress = () => {} }) {
      const unlock = acquireLock(paths, { pid, alive });
      try {
        return await move(folder, by, report, onProgress);
      } finally {
        // 搬成了的话锁文件跟着旧目录一起删了，放锁时找不到不算错
        unlock();
      }
    },
  };
}
