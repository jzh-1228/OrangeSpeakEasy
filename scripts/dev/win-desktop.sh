#!/bin/sh
# 在 Windows 开发机的桌面会话里跑一段 PowerShell，等它跑完，把输出拿回来：
#
#   scripts/dev/win-desktop.sh '<PowerShell>'         最多等 60 秒
#   scripts/dev/win-desktop.sh - < 脚本.ps1
#   WAIT=0 scripts/dev/win-desktop.sh '…'              不等：起完就回来（起 App 这类一直开着的）
#   JOB=bench WAIT=0 scripts/dev/win-desktop.sh '…'    另起一个任务：和别的任务同时跑（默认的任务正跑着时，再起会被忽略）
#
# 为什么要绕这一圈：从 ssh 起的程序跑在 ssh 的会话里，进不了桌面，断开就被收掉——热键、剪贴板、
# 麦克风、窗口全碰不到。这里注册一个"只在用户登录时、以交互方式运行"的计划任务，由它在桌面会话里起
# 一个隐藏的 PowerShell 跑这段脚本，和用户自己双击起来的一样。要求那台机器上有人登录着（锁屏也行）。
# 脚本、输出都在 %USERPROFILE%\orangespeakeasy-dev\desktop 里（带 JOB 的在 desktop-<JOB> 里，任务叫 orangespeakeasy-dev-<JOB>）。
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
[ $# -eq 1 ] || { echo "用法：$0 '<PowerShell>'  或  $0 - < 脚本.ps1" >&2; exit 2; }
if [ "$1" = "-" ]; then body="$(cat)"; else body="$1"; fi
wait_seconds="${WAIT:-60}"
job="${JOB:+-$JOB}"
case "$job" in *[!A-Za-z0-9-]*) echo "JOB 只能有字母、数字和 -" >&2; exit 2 ;; esac

root="$(cd "$here/../.." && pwd)"
# shellcheck source=/dev/null
. "$root/.machine.env"
key="$(printf '%s' "$WIN_SSH_KEY" | sed "s|^~|$HOME|")"

# 脚本原文按文件传过去：塞进命令行的话，长一点的脚本就超过 Windows 一条命令行 32767 个字符的上限。
# 带上 BOM：Windows PowerShell 5.1 把没有 BOM 的 .ps1 当成系统编码（中文系统是 GBK）来读
local_body="$(mktemp)"
trap 'rm -f "$local_body"' EXIT
printf '\357\273\277%s\n' "$body" > "$local_body"
"$here/win.sh" "New-Item -ItemType Directory -Force \"\$HOME\\orangespeakeasy-dev\\desktop$job\" | Out-Null" >/dev/null
scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$key" "$local_body" "$WIN_SSH_TARGET:orangespeakeasy-dev/desktop$job/body.ps1"

"$here/win.sh" "
\$dir = \"\$HOME\\orangespeakeasy-dev\\desktop$job\"
Remove-Item -Force -ErrorAction SilentlyContinue \"\$dir\\out.log\", \"\$dir\\done\"
# 输出一律写进 out.log（UTF-8），跑完（出错退出也算）留一个 done 当记号
\$job = '\$ProgressPreference = \"SilentlyContinue\"' + [Environment]::NewLine +
  'try { & { . \"' + \$dir + '\\body.ps1\" } *>&1 | Out-File -Encoding utf8 -FilePath \"' + \$dir + '\\out.log\" }' + [Environment]::NewLine +
  '  catch { (\"win-desktop：脚本出错退出了：\" + \$_ + [Environment]::NewLine + \$_.ScriptStackTrace) | Out-File -Append -Encoding utf8 -FilePath \"' + \$dir + '\\out.log\" }' + [Environment]::NewLine +
  'finally { Set-Content -Path \"' + \$dir + '\\done\" -Value \$LASTEXITCODE }'
Set-Content -Encoding utf8 -Path \"\$dir\\job.ps1\" -Value \$job
# wscript 起的进程窗口是隐藏的（第二个参数 0），桌面上不会闪一下
Set-Content -Encoding ascii -Path \"\$dir\\run.vbs\" -Value ('CreateObject(\"WScript.Shell\").Run \"powershell -NoProfile -ExecutionPolicy Bypass -File \"\"' + \$dir + '\\job.ps1\"\"\", 0, False')
\$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo \"' + \$dir + '\\run.vbs\"')
\$principal = New-ScheduledTaskPrincipal -UserId (whoami) -LogonType Interactive
Register-ScheduledTask -TaskName 'orangespeakeasy-dev$job' -Action \$action -Principal \$principal -Force | Out-Null
Start-ScheduledTask -TaskName 'orangespeakeasy-dev$job'
if ($wait_seconds -eq 0) { 'started'; return }
\$deadline = (Get-Date).AddSeconds($wait_seconds)
while (-not (Test-Path \"\$dir\\done\") -and (Get-Date) -lt \$deadline) { Start-Sleep -Milliseconds 300 }
if (Test-Path \"\$dir\\out.log\") { Get-Content -Encoding UTF8 \"\$dir\\out.log\" }
if (-not (Test-Path \"\$dir\\done\")) { \"win-desktop：$wait_seconds 秒内没跑完\" }
"
