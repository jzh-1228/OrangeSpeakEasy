import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";
import { createTranslator, LocalizedError } from "../../src/i18n/index.mjs";
import { CHUNKING, sha256 } from "../../src/update/chunker.mjs";
import { CHANNEL, objectPath } from "../../src/update/layout.mjs";
import { MANIFEST_FORMAT } from "../../src/update/manifest.mjs";
import { packObject } from "../../src/update/objects.mjs";
import { createRelease, DOWNLOAD_URL, downloadBase, parseChannel } from "../../src/update/release.mjs";
import { compareVersions, parseVersion } from "../../src/update/versions.mjs";

const zh = createTranslator("zh-CN");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-release-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("版本号比大小：按数比，不按字比；同一个号的预发版比正式版旧", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.ok(compareVersions("0.6.0", "0.6.0-rc.1") > 0);
  assert.ok(compareVersions("0.6.0-rc.10", "0.6.0-rc.9") > 0);
  assert.equal(compareVersions("0.6.0", "0.6.0"), 0);
  assert.ok(compareVersions("0.5.9", "0.6.0") < 0);
});

test("认版本号：带不带 v、前后的空白都认；不像版本号的（报错的网页、空的）是 null", () => {
  assert.equal(parseVersion("v0.10.1"), "0.10.1");
  assert.equal(parseVersion(" 0.10.1-rc.2\n"), "0.10.1-rc.2");
  for (const bad of ["<html>", "", null, undefined, "v1.2", "latest"])
    assert.equal(parseVersion(bad), null, String(bad));
});

test("从哪下载：和安装脚本一样，默认是发布的地址，ORANGESPEAKEASY_INSTALL_BASE 可以换成网址或者本机的目录", () => {
  assert.equal(downloadBase({}), DOWNLOAD_URL);
  assert.equal(downloadBase({ ORANGESPEAKEASY_INSTALL_BASE: "https://example.com/sm" }), "https://example.com/sm");
  assert.equal(downloadBase({ ORANGESPEAKEASY_INSTALL_BASE: "/tmp/release" }), "file:///tmp/release");
  assert.equal(downloadBase({ ORANGESPEAKEASY_INSTALL_BASE: "C:\\dist\\release" }), "file:///C:/dist/release");
});

/** 摆一个本机的下载地址：channel.json 和 store/ 里的对象（压好的） */
function makeRelease(root, objects, channel) {
  mkdirSync(join(root, "store"), { recursive: true });
  for (const [sha, packed] of objects) writeFileSync(join(root, objectPath(sha)), packed);
  if (channel) writeFileSync(join(root, CHANNEL), JSON.stringify(channel));
}

const objectOf = (text) => {
  const data = Buffer.from(text);
  return [sha256(data), packObject(data)];
};

test("channel.json：格式号对、版本号像版本号、每种装法对着一个 sha256 才收；不收的说是哪里不对", () => {
  const sha = "a".repeat(64);
  const channel = { format: 1, version: "1.2.3", electron: "44.0.0", targets: { "win32-x64": sha } };
  assert.deepEqual(parseChannel(JSON.stringify(channel)), {
    version: "1.2.3",
    electron: "44.0.0",
    targets: { "win32-x64": sha },
  });
  const said = (text) => {
    try {
      parseChannel(text);
    } catch (error) {
      assert.ok(error instanceof LocalizedError);
      return zh.text(error.problem);
    }
    assert.fail(`收下了 ${text}`);
  };
  assert.match(said("<html>502</html>"), /channel\.json 无效/);
  assert.match(said(JSON.stringify({ ...channel, format: undefined })), /channel\.json 无效/);
  assert.match(
    said(JSON.stringify({ ...channel, targets: { "win32-x64": "../../etc/passwd" } })),
    /channel\.json 无效/,
  );
  assert.match(said(JSON.stringify({ ...channel, version: "latest" })), /版本号无效："latest"/);
  // 以后的格式这一版看不懂：请用户重装一次，不报成无效、也不当成没有新版本
  assert.match(said(JSON.stringify({ ...channel, format: 2, version: "2.0.0" })), /2\.0\.0 需要重新安装才能升级/);
});

test("真的去问、真的下载：用本机的一个目录当下载地址；对象解开核对过才留下，名字就是 sha256", async () => {
  const root = join(dir, "release");
  const [a, packedA] = objectOf("第一块");
  const [b, packedB] = objectOf("第二块");
  makeRelease(
    root,
    [
      [a, packedA],
      [b, packedB],
    ],
    { format: 1, version: "9.9.9", electron: "44.0.0", targets: { "win32-x64": a } },
  );
  const server = createRelease({ env: { ...process.env, ORANGESPEAKEASY_INSTALL_BASE: root } });
  assert.equal((await server.channel(5)).version, "9.9.9");

  const into = join(dir, "cache");
  mkdirSync(into);
  const got = [];
  await server.fetchObjects([a, b], into, (bytes) => got.push(bytes));
  assert.deepEqual(readdirSync(into).sort(), [a, b].sort());
  assert.deepEqual(got.sort(), [packedA.length, packedB.length].sort());
  // 自己换不了时告诉用户去哪下：和下载用的是同一个地址（Windows 上是 file:///C:/… 的写法）
  assert.equal(server.url("v9.9.9/x.dmg"), `${downloadBase({ ORANGESPEAKEASY_INSTALL_BASE: root })}/v9.9.9/x.dmg`);
});

test("取到的对象内容不对（被换了、坏了）：不留下，说是哪个对象坏了；没取到的说取不到", async () => {
  const root = join(dir, "release");
  const [a] = objectOf("要的那块");
  const [, packedOther] = objectOf("别的内容");
  makeRelease(root, [[a, packedOther]]);
  const server = createRelease({ env: { ...process.env, ORANGESPEAKEASY_INSTALL_BASE: root } });
  const into = join(dir, "cache");
  mkdirSync(into);
  await assert.rejects(server.fetchObjects([a], into), (error) => {
    assert.ok(error instanceof LocalizedError);
    assert.match(zh.text(error.problem), new RegExp(`更新数据（${a.slice(0, 12)}）与发布的不符`));
    return true;
  });
  assert.deepEqual(readdirSync(into), []);

  const absent = "b".repeat(64);
  await assert.rejects(server.fetchObjects([absent], into), (error) => {
    assert.match(zh.text(error.problem), new RegExp(`无法连接 .*${objectPath(absent)}`));
    return true;
  });
});

test("清单：取回来核对过再解析，交回它压过的大小（算进下载量）；不是清单的（坏了的发布）报清单无效", async () => {
  const root = join(dir, "release");
  const manifest = { format: MANIFEST_FORMAT, chunking: CHUNKING.algorithm, entries: [{ path: "app", type: "dir" }] };
  const [good, packedGood] = objectOf(JSON.stringify(manifest));
  const [bad, packedBad] = objectOf(JSON.stringify({ ...manifest, entries: [{ path: "../x", type: "dir" }] }));
  makeRelease(root, [
    [good, packedGood],
    [bad, packedBad],
  ]);
  const server = createRelease({ env: { ...process.env, ORANGESPEAKEASY_INSTALL_BASE: root } });
  assert.deepEqual(await server.manifest(good), { manifest, bytes: packedGood.length });
  await assert.rejects(server.manifest(bad), (error) => {
    assert.match(zh.text(error.problem), new RegExp(`更新清单（${bad.slice(0, 12)}）无效`));
    // 哪里不对给排查的人看，跟着 cause 走
    assert.match(error.cause.message, /路径不对/);
    return true;
  });
});

test("下载地址问不到：报出地址和 curl 说的原因", async () => {
  const server = createRelease({ env: { ...process.env, ORANGESPEAKEASY_INSTALL_BASE: join(dir, "nowhere") } });
  mkdirSync(join(dir, "cache"));
  for (const attempt of [() => server.channel(5), () => server.fetchObjects(["c".repeat(64)], join(dir, "cache"))]) {
    await assert.rejects(attempt, (error) => {
      assert.ok(error instanceof LocalizedError);
      const said = zh.text(error.problem);
      // 本机目录当下载地址时，Windows 上报的是它的 file:// 网址
      const where = join(dir, "nowhere");
      assert.ok(said.includes(where) || said.includes(pathToFileURL(where).href), said);
      assert.match(said, /curl/);
      return true;
    });
  }
});
