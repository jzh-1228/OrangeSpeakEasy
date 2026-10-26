#!/bin/sh
# 把工作区现在的样子（受版本管理的，加上还没提交、没被忽略的新文件）同步到 Windows 开发机的
# %USERPROFILE%\orangespeakeasy-dev\repo，那边装好的 node_modules、评测用的 bench\_work 留着不动：
#
#   scripts/dev/win-sync.sh
#
# 连法同 win.sh（.machine.env 的 WIN_SSH_TARGET、WIN_SSH_KEY）。Windows 10 1803 起自带 tar.exe，不用装别的。
# 开发机上的东西全在 orangespeakeasy-dev 里（代码、npm 和 Electron 的缓存），不用了整个删掉就干净。
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=/dev/null
. "$root/.machine.env"
key="$(printf '%s' "$WIN_SSH_KEY" | sed "s|^~|$HOME|")"

# 先清掉那边的旧文件（node_modules、编好的小帮手、评测的数据和模型 bench\_work 留着）
"$here/win.sh" '$d = "$HOME\orangespeakeasy-dev\repo"; New-Item -ItemType Directory -Force $d | Out-Null; Get-ChildItem -Force $d | Where-Object Name -notin "node_modules", "build", "bench" | Remove-Item -Recurse -Force; if (Test-Path "$d\bench") { Get-ChildItem -Force "$d\bench" | Where-Object Name -ne "_work" | Remove-Item -Recurse -Force }' >/dev/null
cd "$root"
# 只传文件（被删掉的跟踪文件 ls-files 还会列出来，tar 找不到会报错）。
# 编好的 Windows 小帮手不进 git，在 Mac 上交叉编译（node scripts/build/build-native.mjs --windows），
# 有就连同它的指纹一起带过去：那边从源码启动时看指纹对得上，就不会去找 Go 重编。
# 那边的指纹和这边一样就不带：App 开着时 exe 被占着，覆盖不了
stamp=build/key-helper.exe.source-sha256
remote_stamp="$("$here/win.sh" "Get-Content -ErrorAction SilentlyContinue \"\$HOME\\orangespeakeasy-dev\\repo\\$(printf '%s' "$stamp" | tr / '\\\\')\"" | tr -d '\r' || true)"
send_helper=false
if [ -f "$stamp" ] && [ "$(cat "$stamp")" != "$remote_stamp" ]; then send_helper=true; fi
{
  git ls-files -co --exclude-standard -z
  if $send_helper; then printf '%s\0' build/key-helper.exe "$stamp"; fi
} | xargs -0 sh -c 'for f; do [ -f "$f" ] && printf "%s\0" "$f"; done' sh |
  COPYFILE_DISABLE=1 tar --null -T - -czf - |
  ssh -o ConnectTimeout=10 -o BatchMode=yes -o IdentitiesOnly=yes -i "$key" "$WIN_SSH_TARGET" \
    'tar -xzf - -C %USERPROFILE%\orangespeakeasy-dev\repo'
echo "win-sync：同步好了"
