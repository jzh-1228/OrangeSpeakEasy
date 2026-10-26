#!/bin/sh
# 打包并装进"应用程序"，然后打开。已经装过的会被换掉，正在运行的先退出。
# 用法：npm run install-app
set -eu
cd "$(dirname "$0")/../.."
name="$(node -p "require('./package.json').productName")"
target="/Applications/$name.app"

npm run dist
built="dist/$name-darwin-$(node -p process.arch)/$name.app"

# 正在运行的要先退出：是装成应用的那个的话不退换不掉；是命令启动的那个的话，它占着同一个家目录，
# 新装的应用会发现"已经有一个在运行"而起不来。orangespeakeasy stop 两种都管，并且等进程真的退干净才返回
node bin/orangespeakeasy.mjs stop
rm -rf "$target"
ditto "$built" "$target"
echo "装好了：$target"
open "$target"
