// 下载地址上的东西怎么摆。打包发布（scripts/release）、更新（这个目录）、安装脚本（install.sh、install.ps1）共用这一份：
//
//   channel.json                    最新的发布：格式号、版本号、用哪个 Electron，每种装法（TARGETS）用哪份清单。只缓存一分钟
//   store/<sha256>                  对象：块和清单，名字是原始内容的 sha256，存的是 zstd 压过的（objects.mjs）。
//                                   按内容存，同一块只存一份，传上去就不再变。更新只取本机缺的块（assemble.mjs）
//   install.sh、install.ps1         安装脚本
//   v<版本>/<首次安装用的包>          完整的包和同名的 .sha256：没有可以拿来拼的旧版本时才用得上（官网下载、一行命令安装）
//
// 首次安装用的包：
//   orangespeakeasy-darwin-<芯片>.tar.xz   终端安装（install.sh）：解开是 app/ 和 runtime/，就是家目录里的样子
//   OrangeSpeakEasy-<芯片>.dmg             Mac 的安装包：签了名、过了公证的 OrangeSpeakEasy.app
//   orangespeakeasy-win32-x64.zip          Windows 的终端安装（irm … | iex）：解开是 app\ 和 runtime\
//   OrangeSpeakEasy-Setup-x64.exe          Windows 直接下载的安装程序：身上带着同一棵树（zstd 压的），双击就装

export const CHANNEL = "channel.json";
/**
 * channel.json 的格式号。改了清单的格式、下载地址的摆法这类装着的老版本看不懂的东西，就加一：
 * 老版本看到更新的格式号，会请用户重装一次，而不是报错或者一直以为自己是最新的
 */
export const CHANNEL_FORMAT = 1;
export const objectPath = (sha) => `store/${sha}`;
export const versionDir = (version) => `v${version}`;

export const archiveName = (arch) => `orangespeakeasy-darwin-${arch}.tar.xz`;
export const dmgName = (arch) => `OrangeSpeakEasy-${arch}.dmg`;
/** Windows 只出 x64 的一个（Windows on ARM 靠系统自带的转译跑它） */
export const WINDOWS_ARCHIVE = "orangespeakeasy-win32-x64.zip";
/** Windows 直接下载的安装程序（scripts/build/windows-setup.mjs 打的） */
export const WINDOWS_SETUP = "OrangeSpeakEasy-Setup-x64.exe";

/**
 * 更新用的几种装法，每种一棵树、一份清单：
 *   darwin-<芯片>        Mac 终端安装的家目录：app/ 和 runtime/
 *   darwin-<芯片>-app    Mac 的 OrangeSpeakEasy.app
 *   win32-x64            Windows：versions\<版本> 里的 app\ 和 runtime\
 */
export const homeTarget = (platform, arch) => (platform === "win32" ? "win32-x64" : `darwin-${arch}`);
export const appTarget = (arch) => `darwin-${arch}-app`;
export const TARGETS = ["darwin-arm64", "darwin-x64", "darwin-arm64-app", "darwin-x64-app", "win32-x64"];
