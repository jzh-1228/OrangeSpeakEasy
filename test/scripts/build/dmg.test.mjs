import assert from "node:assert/strict";
import { test } from "node:test";
import { notarize } from "../../../scripts/build/dmg.mjs";

const ACCEPTED = JSON.stringify({ id: "a1", status: "Accepted", message: "Successfully received submission info" });
const INVALID = JSON.stringify({ id: "b2", status: "Invalid", message: "Processing complete" });

/** 连苹果超时时 execFileSync 抛的错：标准输出是空的，没有结论 */
const connectTimeout = () =>
  Object.assign(new Error("Command failed: xcrun notarytool submit …\nError: HTTPClientError.connectTimeout"), {
    status: 1,
    stdout: "",
  });

/**
 * 假的 xcrun：submit 依次照 replies 回（字符串是标准输出，函数是抛它返回的错），log 记下来。
 * 返回 notarize 的依赖和记录
 */
function fakeApple(replies) {
  const calls = { submit: 0, log: [], waits: [], lines: [] };
  const exec = (command, args) => {
    assert.equal(command, "xcrun");
    if (args[1] === "log") {
      calls.log.push(args[2]);
      return "";
    }
    assert.equal(args[1], "submit");
    const reply = replies[calls.submit++];
    if (typeof reply === "function") throw reply();
    return reply;
  };
  const deps = { exec, wait: (ms) => calls.waits.push(ms), log: (line) => calls.lines.push(line) };
  return { calls, deps };
}

test("公证：一次就通过，不等也不重交", () => {
  const { calls, deps } = fakeApple([ACCEPTED]);
  notarize("/tmp/OrangeSpeakEasy-x64.dmg", "profile", deps);
  assert.equal(calls.submit, 1);
  assert.deepEqual(calls.waits, []);
});

test("公证：连苹果超时就隔 30 秒重交，第三次通过算成功（0.9.4 发版时碰到过）", () => {
  const { calls, deps } = fakeApple([connectTimeout, connectTimeout, ACCEPTED]);
  notarize("/tmp/OrangeSpeakEasy-x64.dmg", "profile", deps);
  assert.equal(calls.submit, 3);
  assert.deepEqual(calls.waits, [30_000, 30_000]);
  assert.equal(calls.lines.length, 3);
  assert.match(calls.lines[0], /第 1 次.*connectTimeout.*30 秒后重交/);
  assert.match(calls.lines[2], /公证通过：OrangeSpeakEasy-x64\.dmg（a1）/);
});

test("公证：三次都连不上，报最后那次的错，不再重交", () => {
  const { calls, deps } = fakeApple([connectTimeout, connectTimeout, connectTimeout, ACCEPTED]);
  assert.throws(() => notarize("/tmp/OrangeSpeakEasy-x64.dmg", "profile", deps), /connectTimeout/);
  assert.equal(calls.submit, 3);
  assert.deepEqual(calls.waits, [30_000, 30_000]);
});

test("公证：苹果给了不通过的结论（非零退出、标准输出带编号）就不重交，取问题清单再报错", () => {
  const rejected = () =>
    Object.assign(new Error("Command failed: xcrun notarytool submit …"), { status: 1, stdout: INVALID });
  const { calls, deps } = fakeApple([rejected, ACCEPTED]);
  assert.throws(() => notarize("/tmp/OrangeSpeakEasy-x64.dmg", "profile", deps), /没过公证：Invalid.*b2/);
  assert.equal(calls.submit, 1);
  assert.deepEqual(calls.log, ["b2"]);
  assert.deepEqual(calls.waits, []);
});

test("公证：正常退出但状态不是 Accepted，同样不重交、报错", () => {
  const { calls, deps } = fakeApple([INVALID, ACCEPTED]);
  assert.throws(() => notarize("/tmp/OrangeSpeakEasy-x64.dmg", "profile", deps), /没过公证：Invalid/);
  assert.equal(calls.submit, 1);
  assert.deepEqual(calls.log, ["b2"]);
});
