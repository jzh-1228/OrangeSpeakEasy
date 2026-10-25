import assert from "node:assert/strict";
import { test } from "node:test";
import { isUnknownCommand, readStats } from "../../src/cli/common.mjs";

// isUnknownCommand 认两种"后台不认识这条命令"：新版带 code，旧版只有那句中文原话。
// 命令行的旧后台降级分支（route/config/model/local 六处）都靠它判断，认漏了会把原始错误抛给用户。

test("带 code 的新错误：认", () => {
  assert.equal(isUnknownCommand({ code: "unknown_command", message: "Unrecognized command" }), true);
});

test("只带那句中文的旧错误：认（旧后台不回 code）", () => {
  assert.equal(isUnknownCommand(new Error('不认识的命令："dance"')), true);
});

test("无关错误：不认", () => {
  assert.equal(isUnknownCommand(new Error("这把 key 无效")), false);
});

// 统计是 status 面板上顺带看的两行：历史库坏了、版本比程序新时只少这两行，命令本身照常给出运行状态。

test("readStats：历史库打不开时返回空统计，不让 status 整体失败", () => {
  const io = {
    paths: { historyDb: "/nonexistent/history.db" },
    now: () => new Date("2026-10-25T08:00:00.000Z"),
    openHistory: () => {
      throw new Error("file is not a database");
    },
  };
  assert.deepEqual(readStats(io), { today: null, total: null });
});

test("readStats：库还不存在（openHistory 返回 null）时也是空统计", () => {
  const io = {
    paths: { historyDb: "/nonexistent/history.db" },
    now: () => new Date("2026-10-25T08:00:00.000Z"),
    openHistory: () => null,
  };
  assert.deepEqual(readStats(io), { today: null, total: null });
});
