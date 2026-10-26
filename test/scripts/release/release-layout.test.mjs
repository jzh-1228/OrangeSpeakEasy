import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  ARCHS,
  archiveName,
  CHANNEL,
  dmgName,
  objectPath,
  planUpload,
  publish,
  sha256,
  WINDOWS_ARCHIVE,
  WINDOWS_SETUP,
} from "../../../scripts/release/release-layout.mjs";
import { TARGETS } from "../../../src/update/layout.mjs";
import { packObject } from "../../../src/update/objects.mjs";
import { publishTrees } from "../../helpers/release.mjs";

let dir;

/** 首次安装用的包：几个字节的假货 */
const PACKAGES = [...ARCHS.flatMap((arch) => [archiveName(arch), dmgName(arch)]), WINDOWS_ARCHIVE, WINDOWS_SETUP];

/**
 * 摆一个假的发布目录：每种装法一棵小树（切块、清单都是真的），首次安装用的包是假货。
 * shared：各版本都一样的那个文件（发新版本时它的块不用再传）
 */
async function makeRelease(version = "1.2.3") {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, `v${version}`), { recursive: true });
  const trees = {};
  for (const target of TARGETS) {
    const tree = mkdtempSync(join(tmpdir(), "sm-tree-"));
    writeFileSync(join(tree, "shared"), `各版本都一样 ${target}`);
    writeFileSync(join(tree, "version"), `${target} ${version}`);
    trees[target] = tree;
  }
  await publishTrees(dir, version, trees);
  for (const tree of Object.values(trees)) rmSync(tree, { recursive: true });
  for (const name of PACKAGES) {
    const file = join(dir, `v${version}`, name);
    writeFileSync(file, `假的 ${name} ${version}`);
    writeFileSync(`${file}.sha256`, `${sha256(file)}  ${name}\n`);
  }
  writeFileSync(join(dir, "install.sh"), "#!/bin/bash\n");
  writeFileSync(join(dir, "install.ps1"), "& { }\n");
}

/** 假的桶：记着每个对象的大小、校验值和传的先后 */
function fakeStore(initial = {}) {
  const objects = new Map(Object.entries(initial));
  const puts = [];
  return {
    objects,
    puts,
    list: async (prefix) =>
      new Map([...objects].filter(([key]) => key.startsWith(prefix)).map(([key, { size }]) => [key, size])),
    head: async (key) => objects.get(key) ?? null,
    put: async (item) => {
      puts.push(item.key);
      objects.set(item.key, { size: item.size, sha256: item.sha256 });
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sm-release-"));
  await makeRelease();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("清单：对象是每份更新清单和它用到的块；其余先是这个版本的包和校验值，再是两个安装脚本，channel.json 排最后", () => {
  const plan = planUpload(dir);
  assert.equal(plan.version, "1.2.3");
  // 五棵树各两个文件，"shared" 的内容各不相同：每棵两块，加上五份清单
  assert.equal(plan.objects.length, TARGETS.length * 3);
  assert.deepEqual(
    plan.objects.map((item) => item.key).sort(),
    readdirSync(join(dir, "store"))
      .map((name) => `orangespeakeasy/store/${name}`)
      .sort(),
  );
  for (const item of plan.objects) {
    assert.equal(item.contentType, "application/octet-stream", "不让 CDN 当成文字再压一遍");
    assert.match(item.cacheControl, /immutable/);
  }
  assert.deepEqual(
    plan.files.map((item) => item.key),
    [
      "orangespeakeasy/v1.2.3/orangespeakeasy-darwin-arm64.tar.xz",
      "orangespeakeasy/v1.2.3/orangespeakeasy-darwin-arm64.tar.xz.sha256",
      "orangespeakeasy/v1.2.3/OrangeSpeakEasy-arm64.dmg",
      "orangespeakeasy/v1.2.3/OrangeSpeakEasy-arm64.dmg.sha256",
      "orangespeakeasy/v1.2.3/orangespeakeasy-darwin-x64.tar.xz",
      "orangespeakeasy/v1.2.3/orangespeakeasy-darwin-x64.tar.xz.sha256",
      "orangespeakeasy/v1.2.3/OrangeSpeakEasy-x64.dmg",
      "orangespeakeasy/v1.2.3/OrangeSpeakEasy-x64.dmg.sha256",
      "orangespeakeasy/v1.2.3/orangespeakeasy-win32-x64.zip",
      "orangespeakeasy/v1.2.3/orangespeakeasy-win32-x64.zip.sha256",
      "orangespeakeasy/v1.2.3/OrangeSpeakEasy-Setup-x64.exe",
      "orangespeakeasy/v1.2.3/OrangeSpeakEasy-Setup-x64.exe.sha256",
      "orangespeakeasy/install.sh",
      "orangespeakeasy/install.ps1",
      "orangespeakeasy/channel.json",
    ],
  );
  const type = (suffix) => plan.files.find(({ key }) => key.endsWith(suffix)).contentType;
  // 浏览器拿到 dmg 要认得出是磁盘映像；install.ps1 要按 UTF-8 解（irm 照 charset 解，里面有中文注释）
  assert.equal(type(".dmg"), "application/x-apple-diskimage");
  assert.equal(type("install.ps1"), "text/plain; charset=utf-8");
  // 浏览器下回来的 exe 要当成程序，不能当成网页里的文字打开
  assert.equal(type(".exe"), "application/vnd.microsoft.portable-executable");
});

test("清单：版本目录里的长期缓存、不许改；安装脚本和 channel.json 只缓存一小会儿", () => {
  const { files } = planUpload(dir);
  for (const item of files.slice(0, 12)) {
    assert.equal(item.immutable, true, item.key);
    assert.match(item.cacheControl, /immutable/);
  }
  for (const item of files.slice(12)) {
    assert.equal(item.immutable, false, item.key);
    assert.equal(item.cacheControl, "public, max-age=60");
  }
});

test("发布目录不齐或对不上：不出清单", async () => {
  rmSync(join(dir, "v1.2.3", archiveName("x64")));
  assert.throws(() => planUpload(dir), /少了 v1\.2\.3\/orangespeakeasy-darwin-x64\.tar\.xz/);

  await makeRelease();
  writeFileSync(join(dir, "v1.2.3", dmgName("x64")), "签完名又改过");
  assert.throws(() => planUpload(dir), /OrangeSpeakEasy-x64\.dmg 和它的 \.sha256 对不上/);

  // 清单用到的块少了一个、坏了一个
  await makeRelease();
  const objects = readdirSync(join(dir, "store"));
  const channel = JSON.parse(readFileSync(join(dir, CHANNEL), "utf8"));
  const chunk = objects.find((name) => !Object.values(channel.targets).includes(name));
  rmSync(join(dir, objectPath(chunk)));
  assert.throws(() => planUpload(dir), new RegExp(`少了对象 store/${chunk}`));
  writeFileSync(join(dir, objectPath(chunk)), packObject(Buffer.from("别的内容")));
  assert.throws(() => planUpload(dir), new RegExp(`store/${chunk} 坏了：.*sha256 对不上`));

  // channel.json 少了一种装法、不是 JSON、没有
  await makeRelease();
  writeFileSync(
    join(dir, CHANNEL),
    JSON.stringify({ ...channel, targets: { "win32-x64": channel.targets["win32-x64"] } }),
  );
  assert.throws(
    () => planUpload(dir),
    /channel\.json 里少了这几种装法的清单：darwin-arm64、darwin-x64、darwin-arm64-app/,
  );
  writeFileSync(join(dir, CHANNEL), "最新的");
  assert.throws(() => planUpload(dir), /发布目录里的 channel\.json 不对/);
  rmSync(join(dir, CHANNEL));
  assert.throws(() => planUpload(dir), /少了 channel\.json/);
});

test("上传：全新的全传，先对象、再按清单的先后传其余的；再来一次什么都不用传", async () => {
  const plan = planUpload(dir);
  const store = fakeStore();
  await publish(plan, store, () => {});
  assert.deepEqual(new Set(store.puts.slice(0, plan.objects.length)), new Set(plan.objects.map((item) => item.key)));
  assert.deepEqual(
    store.puts.slice(plan.objects.length),
    plan.files.map((item) => item.key),
  );

  store.puts.length = 0;
  await publish(plan, store, () => {});
  assert.deepEqual(store.puts, []);
});

test("上传：发新版本时只传新的块，旧版本的不碰，安装脚本没变不传，channel.json 换成新的", async () => {
  const store = fakeStore();
  await publish(planUpload(dir), store, () => {});
  const old = store.objects.get("orangespeakeasy/v1.2.3/orangespeakeasy-darwin-arm64.tar.xz");

  await makeRelease("1.3.0");
  store.puts.length = 0;
  const plan = planUpload(dir);
  await publish(plan, store, () => {});
  // "shared" 那一块各版本一样，不用再传：每棵树只传新的 version 那块和新的清单
  assert.equal(store.puts.filter((key) => key.startsWith("orangespeakeasy/store/")).length, TARGETS.length * 2);
  assert.deepEqual(
    store.puts.filter((key) => !key.startsWith("orangespeakeasy/store/")),
    plan.files.map(({ key }) => key).filter((key) => !/install\.(sh|ps1)$/.test(key)),
  );
  assert.equal(store.puts.at(-1), "orangespeakeasy/channel.json");
  assert.deepEqual(store.objects.get("orangespeakeasy/v1.2.3/orangespeakeasy-darwin-arm64.tar.xz"), old);
});

test("上传：上面已经有同名的对象就不传，哪怕压出来的字节不一样（名字就是内容）", async () => {
  const plan = planUpload(dir);
  const object = plan.objects[0];
  const store = fakeStore({ [object.key]: { size: object.size + 5, sha256: "" } });
  await publish(plan, store, () => {});
  assert.ok(!store.puts.includes(object.key));
});

test("上传：同一个版本号已经发布过、内容不一样：不覆盖，channel.json 也不动", async () => {
  const store = fakeStore();
  await publish(planUpload(dir), store, () => {});

  writeFileSync(join(dir, "v1.2.3", archiveName("arm64")), "同一个版本号，重新打的");
  writeFileSync(
    join(dir, "v1.2.3", `${archiveName("arm64")}.sha256`),
    `${sha256(join(dir, "v1.2.3", archiveName("arm64")))}  x\n`,
  );
  store.puts.length = 0;
  await assert.rejects(
    publish(planUpload(dir), store, () => {}),
    /已经发布过，内容和这次的不一样/,
  );
  assert.deepEqual(store.puts, []);
});

test("上传：传上去之后对不上：对象没在上面、文件大小或校验值不一样，都报错，不接着往下传", async () => {
  const lost = fakeStore();
  lost.put = async (item) => {
    lost.puts.push(item.key);
  };
  await assert.rejects(
    publish(planUpload(dir), lost, () => {}),
    /传完以后上面还缺 \d+ 个对象/,
  );
  assert.ok(!lost.puts.includes("orangespeakeasy/channel.json"));

  const store = fakeStore();
  const put = store.put;
  store.put = async (item) => {
    await put(item);
    if (!item.key.startsWith("orangespeakeasy/store/"))
      store.objects.set(item.key, { size: item.size - 1, sha256: item.sha256 });
  };
  await assert.rejects(
    publish(planUpload(dir), store, () => {}),
    /传上去之后和本机的对不上/,
  );
  assert.equal(store.puts.filter((key) => !key.startsWith("orangespeakeasy/store/")).length, 1);
});
