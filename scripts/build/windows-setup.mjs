// 打 Windows 直接下载的安装程序 OrangeSpeakEasy-Setup-x64.exe：native/windows-setup 编出来的那段程序，后面接
// 整棵程序（app\ 和 runtime\）打成的 tar、再用 zstd 压过，最后 16 个字节是记号和压过的那段的长度。
// 格式和 native/windows-setup/payload.go 读的一致。
// 双击后它把树解到临时目录，让树里自带的 install.ps1 从那里装（ORANGESPEAKEASY_INSTALL_FROM）：怎么装还是只有 install.ps1 一份。
// 由 scripts/release/release.mjs 在摆好 Windows 的树之后调用。
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { goCommand } from "../../src/cli/native-helper.mjs";

export const SETUP_MAGIC = "SMSETUP2";
/**
 * 给 exe 加图标、版本信息和清单的工具，只在编译时用。钉住版本，下载的内容由 Go 的校验和数据库核对。
 * 清单里写明不要管理员权限（asInvoker）：名字里带 Setup 又没有清单的 exe，Windows 会自动要求提权
 */
const GO_WINRES = "github.com/tc-hib/go-winres@v0.3.3";

/** 尾巴：记号 8 字节，加压过的那段的长度（8 字节，小端） */
export function setupTrailer(payloadBytes) {
  const trailer = Buffer.alloc(16);
  trailer.write(SETUP_MAGIC, 0, "ascii");
  trailer.writeBigUInt64LE(BigInt(payloadBytes), 8);
  return trailer;
}

/** exe 的文件版本只认四段数字：0.9.0-rc.1 记成 0.9.0.0（完整的版本号写在产品版本里） */
export const fileVersion = (version) => `${/^\d+\.\d+\.\d+/.exec(version)[0]}.0`;

/** 把一棵树打成 zstd 压的 tar，写到 out：另起一个进程跑（pack-tree.mjs 里说了为什么） */
function packTree(tree, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "pack-tree.mjs"), tree, out], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`压 ${basename(out)} 失败（退出码 ${code}）`)),
    );
  });
}

/**
 * @param {object} options
 * @param {string} options.packageDir 仓库根
 * @param {string} options.version 版本号（package.json 的，不带 v）
 * @param {string} options.tree 摆好的 Windows 程序（里面是 app 和 runtime，app 里带着 install.ps1）
 * @param {string} options.out 安装程序写到哪
 */
export async function buildWindowsSetup({ packageDir, version, tree, out, run = execFileSync }) {
  const source = join(packageDir, "native", "windows-setup");
  const go = goCommand(packageDir, process.platform);
  const work = mkdtempSync(join(tmpdir(), "orangespeakeasy-setup-"));
  try {
    const program = join(work, "setup.exe");
    try {
      // 生成的资源文件放在源码目录里 go build 才认，编完就删
      run(
        go,
        [
          "run",
          GO_WINRES,
          "simply",
          "--arch",
          "amd64",
          "--out",
          join(source, "rsrc"),
          "--manifest",
          "cli",
          "--icon",
          join(packageDir, "assets", "icon.ico"),
          "--product-name",
          "OrangeSpeakEasy",
          "--product-version",
          version,
          "--file-version",
          fileVersion(version),
          "--file-description",
          "OrangeSpeakEasy Setup",
          "--original-filename",
          basename(out),
          "--copyright",
          "MIT License",
        ],
        { cwd: source, stdio: "inherit" },
      );
      // 控制台程序：安装的进度要显示出来
      run(go, ["build", "-trimpath", "-ldflags", "-s -w", "-o", program, "."], {
        cwd: source,
        stdio: "inherit",
        env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
      });
    } finally {
      rmSync(join(source, "rsrc_windows_amd64.syso"), { force: true });
    }

    const payload = join(work, "payload.tar.zst");
    await packTree(tree, payload);

    copyFileSync(program, out);
    await pipeline(createReadStream(payload), createWriteStream(out, { flags: "a" }));
    appendFileSync(out, setupTrailer(statSync(payload).size));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
