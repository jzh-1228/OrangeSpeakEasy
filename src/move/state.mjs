import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { commandOfProcess } from "../instance.mjs";
import { isAlive } from "../update/state.mjs";

// 搬家的记录：家目录 run/move.json。搬的时候写在旧目录里（也是"正在搬，别在这里启动"的记号，index.mjs 的 settleMove 认它），
// 搬完写在最终在用的那个目录里（成了是新的，没成是旧的），排查时看：
//   { state: running | done | failed, by: cli | app, from, to, pid, startedAt, finishedAt, problem }
// 定位文件里的 moving（storage/location.mjs）是另一半：拷到一半断了电，下次照它认出那一份是没搬完的。

/** 一次搬家最多做多久：标着进行中、可已经过了这么久的，进程号多半被别的程序用上了 */
const MOVE_AT_MOST_MS = 6 * 60 * 60 * 1000;

export function readMoveRecord(paths) {
  try {
    const record = JSON.parse(readFileSync(paths.moveFile, "utf8"));
    return typeof record?.state === "string" ? record : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function writeMoveRecord(paths, record) {
  mkdirSync(dirname(paths.moveFile), { recursive: true });
  writeFileSync(paths.moveFile, JSON.stringify(record));
}

/** 搬家的进程跑的可执行文件：命令行（自带的 Electron 当 Node 用）、App、从源码跑的（node …/orangespeakeasy.mjs） */
const MOVER = /\/MacOS\/(Electron|OrangeSpeakEasy)( |$)|\\(electron|node)\.exe$|orangespeakeasy\.mjs/i;

/**
 * 这个进程号上跑的还是搬家的那个 OrangeSpeakEasy。断电、重启以后进程号会分给别的程序：只看在不在，
 * 会一直挡着启动（定位文件里的 moving、run/move.json 都记着进程号）
 */
export function moverAlive(pid, { alive = isAlive, commandOf = commandOfProcess } = {}) {
  return alive(pid) && MOVER.test(commandOf(pid) ?? "");
}

/** 记着的那个搬家进程（进程号、开始时间）还在搬：进程在，也没超过一次搬家最多花的时间 */
export function stillRunning({ pid, startedAt }, { alive = moverAlive, now = () => new Date() } = {}) {
  return Number.isInteger(pid) && alive(pid) && now() - Date.parse(startedAt) < MOVE_AT_MOST_MS;
}

/** 记录里的那个搬家进程还在搬 */
export function stillMoving(record, options = {}) {
  return record?.state === "running" && stillRunning(record, options);
}
