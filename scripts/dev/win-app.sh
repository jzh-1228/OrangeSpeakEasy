#!/bin/sh
# 在 Windows 开发机的桌面上从源码重启 OrangeSpeakEasy：同步工作区、停掉在跑的、起新的，带调试端口：
#
#   scripts/dev/win-app.sh            家目录用 %USERPROFILE%\orangespeakeasy-dev\home（不碰真正装的那份）
#   scripts/dev/win-app.sh stop       只停
#
# 起来之后在本机看页面：ssh -L 19333:127.0.0.1:9333 <开发机>，再连 http://127.0.0.1:19333（CDP）。
# 日志在开发机的 orangespeakeasy-dev\app-out.log、app-err.log。
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
"$here/win.sh" '
# 开发副本里起来的进程（Electron 的各个进程、小帮手）全停掉；别处的 Electron 应用不碰
Get-Process | Where-Object { $_.Path -like "$HOME\orangespeakeasy-dev\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800' >/dev/null
[ "${1:-}" = "stop" ] && { echo "win-app：停了"; exit 0; }
"$here/win-sync.sh" >/dev/null
WAIT=30 "$here/win-desktop.sh" - <<'PS'
$repo = "$HOME\orangespeakeasy-dev\repo"
$env:ORANGESPEAKEASY_HOME = "$HOME\orangespeakeasy-dev\home"
Start-Process -FilePath "$repo\node_modules\electron\dist\electron.exe" -ArgumentList "--remote-debugging-port=9333", "`"$repo`"" -WorkingDirectory $repo -RedirectStandardOutput "$HOME\orangespeakeasy-dev\app-out.log" -RedirectStandardError "$HOME\orangespeakeasy-dev\app-err.log"
Start-Sleep 5
$started = Get-Content "$HOME\orangespeakeasy-dev\app-out.log" -Encoding UTF8 | Select-String '"event":"(started|helper_ready|startup_failed)"'
if ($started) { $started | ForEach-Object { $_.Line.Substring(0, [Math]::Min(200, $_.Line.Length)) } } else { "win-app：5 秒内没看到 started，看 app-err.log" }
PS
