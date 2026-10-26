import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

// 在 Windows 上要动系统的那几处：install.ps1 在家目录以外留下的（用户 Path 里的一项、开始菜单的快捷方式）、
// App 里开过的开机启动，卸载时照着删；搬家后删旧目录、清掉指着旧目录的环境变量；还有删不掉正在跑的程序这件事。
// 命令行（卸载、搬家）和 App 的搬家进度窗口都用（所以不放在 src/cli 里：Mac 的 App 不带那个目录）。
// 都经 PowerShell 做，要用的值走环境变量，脚本里不拼外来的字。macOS 上用不到这里。

/**
 * 跑一段 PowerShell，交出它的标准输出。出错就停、以非零退出（execFileSync 抛出来）；正常跑完明确以 0 退出：
 * 不然 -Command 的退出码看最后一条命令，"没找到那一项"这种早料到的情况也会变成 1
 */
function powershell(script, env = {}, { cwd } = {}) {
  const wrapped = `$ErrorActionPreference = 'Stop'\n${script}\nexit 0`;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", wrapped], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env },
    cwd,
  });
}

/**
 * 从用户的 Path 里删掉这一项（install.ps1 加的那一项，原样记在 bin\links 里）。按原样读写：读的时候不展开
 * %USERPROFILE% 这种写法，写回去还是可展开的那一种；改完借设一个环境变量让系统广播一次
 * @returns {boolean} 本来有没有
 */
export function removePathEntry(entry) {
  const output = powershell(
    `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
     $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
     $entries = @($raw -split ';' | Where-Object { $_ })
     $kept = @($entries | Where-Object { $_ -ine $env:ORANGESPEAKEASY_PATH_ENTRY })
     if ($kept.Count -ne $entries.Count) {
       $key.SetValue('Path', ($kept -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
       [Environment]::SetEnvironmentVariable('ORANGESPEAKEASY_PATH_CHANGED', '1', 'User')
       [Environment]::SetEnvironmentVariable('ORANGESPEAKEASY_PATH_CHANGED', $null, 'User')
       'removed'
     }
     $key.Dispose()`,
    { ORANGESPEAKEASY_PATH_ENTRY: entry },
  );
  return output.trim() === "removed";
}

/**
 * 这个快捷方式是不是指着这个家目录里的程序（versions 下某个版本的，或者 0.9.2 及以前直接放在 runtime 里的）。
 * 清单里记的东西卸载前要再认一遍：那个位置上可能已经换成了别的。
 * 目标路径请 Windows 自己读（WScript.Shell）：.lnk 文件里存的不是一整段连续的路径（本地编码那份拆成几截、
 * UTF-16 那份是相对路径），按字节找找不到。比较也在 PowerShell 里做，路径不经过控制台编码
 */
export function isOurShortcut(file, home) {
  if (!existsSync(file)) return false;
  const output = powershell(
    `$target = (New-Object -ComObject WScript.Shell).CreateShortcut($env:ORANGESPEAKEASY_SHORTCUT).TargetPath
     if ($target.StartsWith("$env:ORANGESPEAKEASY_HOME_DIR\\", [StringComparison]::OrdinalIgnoreCase)) { 'ours' }`,
    { ORANGESPEAKEASY_SHORTCUT: file, ORANGESPEAKEASY_HOME_DIR: home },
  );
  return output.trim() === "ours";
}

const RUN_KEYS = [
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run",
];

/**
 * 去掉开机启动（App 设置里开的，Electron 记在注册表的 Run 里，名字是 OrangeSpeakEasy）。只删指着这个家目录的那一条
 * @returns {boolean} 本来有没有
 */
export function removeLoginItem(home) {
  const output = powershell(
    `$run = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'OrangeSpeakEasy' -ErrorAction SilentlyContinue
     # 按字面找家目录（不用 -like：路径里的 [ ] 会被当成通配符）
     if ($run -and $run.OrangeSpeakEasy.IndexOf("$env:ORANGESPEAKEASY_HOME_DIR\\", [StringComparison]::OrdinalIgnoreCase) -ge 0) {
       foreach ($key in $env:ORANGESPEAKEASY_RUN_KEYS.Split([char]10)) { Remove-ItemProperty -Path $key -Name 'OrangeSpeakEasy' -ErrorAction SilentlyContinue }
       'removed'
     }`,
    { ORANGESPEAKEASY_HOME_DIR: home, ORANGESPEAKEASY_RUN_KEYS: RUN_KEYS.join("\n") },
  );
  return output.trim() === "removed";
}

/**
 * 隔一层起一个隐藏的 PowerShell 跑 cleanup（要用的值走环境变量）。Node 在 Windows 上把直接起的子进程放进一个
 * "自己退出就全部结束"的作业对象，这条命令一退出它就没了；加 detached 能躲开，可那样起的 PowerShell 没有控制台，
 * 一行都不跑就以 0 退出（真机上都试过）。所以先同步跑一个 PowerShell，由它 Start-Process 干活的那个：孙进程不在那个作业对象里。
 * 两个都在临时目录里跑：工作目录是哪个文件夹，那个文件夹就删不掉（这个进程可能就是在要删的旧目录里起的）
 */
function runDetached(cleanup, env) {
  powershell(
    "Start-Process powershell -WindowStyle Hidden -WorkingDirectory $env:TEMP -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',$env:ORANGESPEAKEASY_CLEANUP",
    { ...env, ORANGESPEAKEASY_CLEANUP: Buffer.from(cleanup, "utf16le").toString("base64") },
    { cwd: tmpdir() },
  );
}

/**
 * 等第一个进程退出（最多十分钟），后面的只再等一小会儿；再稍等一下（杀毒软件扫完刚关的文件、句柄放干净）。
 * 后面的是起它的 cmd：从 PowerShell 敲的命令，那是跑完就退的 cmd /c；在 cmd 窗口里敲的，那就是这个窗口本身，
 * 不会退，等它读完批处理文件的最后一行就行
 */
const WAIT_FOR_PIDS = `$timeout = 600
foreach ($id in $env:ORANGESPEAKEASY_WAIT_PIDS.Split(',')) { if ($id) { Wait-Process -Id ([int]$id) -Timeout $timeout -ErrorAction SilentlyContinue; $timeout = 10 } }
Start-Sleep -Milliseconds 800`;

/** 删掉 $targets 里的每一项，删不掉的隔一秒再试，最多十次 */
const REMOVE_WITH_RETRIES = `for ($try = 0; $try -lt 10; $try++) {
  $left = @($targets | Where-Object { Test-Path -LiteralPath $_ })
  if ($left.Count -eq 0) { break }
  foreach ($target in $left) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}`;

/**
 * 等这个进程退出之后再把这几个目录删掉。Windows 上正在跑的程序删不掉，而卸载、升级时正在跑的就是这条命令自己
 * （装好的那份 Electron）：交给一个隐藏的 PowerShell，等它退出再删，不留窗口
 */
export function removeAfterExit(dirs, pid = process.pid) {
  runDetached(
    `${WAIT_FOR_PIDS}
$targets = @($env:ORANGESPEAKEASY_REMOVE.Split([char]10) | Where-Object { $_ })
${REMOVE_WITH_RETRIES}`,
    { ORANGESPEAKEASY_WAIT_PIDS: String(pid), ORANGESPEAKEASY_REMOVE: dirs.join("\n") },
  );
}

/**
 * 搬家后删旧目录（move/index.mjs）：等这几个进程（搬家的这条命令、起它的 orangespeakeasy.cmd——cmd 跑完一行还要回去读批处理文件）
 * 都退出，删掉目录里我们的那几项；只剩 MOVED.json（或者什么都不剩）就连目录一起删，还有用户自己的东西就留着它们和 MOVED.json
 */
export function removeHomeAfterExit(home, names, pids) {
  runDetached(
    `${WAIT_FOR_PIDS}
$dir = $env:ORANGESPEAKEASY_OLD_HOME
$targets = @($env:ORANGESPEAKEASY_REMOVE.Split([char]10) | Where-Object { $_ } | ForEach-Object { [IO.Path]::Combine($dir, $_) })
${REMOVE_WITH_RETRIES}
$rest = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'MOVED.json' })
if ($rest.Count -eq 0) {
  $targets = @($dir)
  ${REMOVE_WITH_RETRIES}
}`,
    {
      ORANGESPEAKEASY_WAIT_PIDS: pids.join(","),
      ORANGESPEAKEASY_OLD_HOME: home,
      ORANGESPEAKEASY_REMOVE: names.join("\n"),
    },
  );
}

/**
 * 用户环境变量里的 ORANGESPEAKEASY_HOME 指着这个（搬走了的）目录就删掉它：不然以后跑安装程序、从源码启动都还会用旧位置。
 * 0.11.0 及以前想换位置只能设它。指着别处的不动
 * @returns {boolean} 删了没有
 */
export function clearUserHome(home) {
  const output = powershell(
    `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
     $raw = [string]$key.GetValue('ORANGESPEAKEASY_HOME', '')
     if ($raw) {
       $full = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($raw)).TrimEnd('\\')
       if ($full -ieq $env:ORANGESPEAKEASY_OLD_HOME.TrimEnd('\\')) {
         $key.DeleteValue('ORANGESPEAKEASY_HOME')
         [Environment]::SetEnvironmentVariable('ORANGESPEAKEASY_PATH_CHANGED', '1', 'User')
         [Environment]::SetEnvironmentVariable('ORANGESPEAKEASY_PATH_CHANGED', $null, 'User')
         'removed'
       }
     }
     $key.Dispose()`,
    { ORANGESPEAKEASY_OLD_HOME: home },
  );
  return output.trim() === "removed";
}
