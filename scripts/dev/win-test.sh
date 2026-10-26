#!/bin/sh
# 同步工作区到 Windows 开发机，在那边跑单测，日志拉回本机，按文件列出失败的条数：
#
#   scripts/dev/win-test.sh                        全部单测（同 npm run test:unit）
#   scripts/dev/win-test.sh test/control.test.mjs  只跑这几个文件（可以写 glob，加引号）
#
# 日志放在 $TMPDIR/orangespeakeasy-win-test.log。要先在开发机上装好依赖：
#   scripts/dev/win.sh 'Set-Location "$HOME\orangespeakeasy-dev\repo"; npm.cmd ci'
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
"$here/win-sync.sh" >/dev/null
if [ $# -eq 0 ]; then set -- "test/*.test.mjs" "test/!(install)/**/*.test.mjs"; fi
files=""
for file in "$@"; do files="$files '$file'"; done
log="${TMPDIR:-/tmp}/orangespeakeasy-win-test.log"
"$here/win.sh" "Set-Location \"\$HOME\\orangespeakeasy-dev\\repo\"; & node --test --test-timeout=5000 --test-reporter=spec $files > \"\$HOME\\orangespeakeasy-dev\\unit.log\" 2>&1; \"exit=\$LASTEXITCODE\"" | tail -1
"$here/win.sh" 'Get-Content "$HOME\orangespeakeasy-dev\unit.log" -Encoding UTF8' > "$log"
grep -E '^ℹ (tests|pass|fail|cancelled|skipped)' "$log" | tr '\n' ' '
echo
sed -n '/^✖ failing tests:/,$p' "$log" | grep -E '^test at ' | sed -E 's/^test at (.*[\\/])?(test[\\/][^:]*):.*/\2/' | sort | uniq -c | sort -rn || true
echo "日志：$log"
