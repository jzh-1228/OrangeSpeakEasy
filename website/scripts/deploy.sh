#!/bin/sh
# 把官网部署到服务器：从当前提交里取出构建要用的那几样（和 .dockerignore 放进构建的一样），经 SSH 传到服务器的部署目录，
# 在那里用 website/compose.yaml 构建镜像、换掉旧容器，再查健康检查。服务器上只用它已有的 Docker，不装别的；
# 也不让服务器连 GitHub（从大陆连时好时坏），代码从这台电脑推过去。
#
#   cd website && npm run deploy
#
# 服务器在 .machine.env 里配（见 .machine.env.example）：SITE_SSH_HOST、SITE_REMOTE_DIR，服务器在大陆时再配 SITE_NPM_REGISTRY。
# 容器只绑服务器的 127.0.0.1:9800，外面经宿主机的 nginx 反代进来（见 website/README.md）。
# 下载链接的版本号是构建时从 package.json 取的：发了新版本要再部署一次。
set -eu
cd "$(dirname "$0")/../.."

fail() {
  echo "deploy：$1" >&2
  exit 1
}

# shellcheck source=/dev/null
[ -f .machine.env ] && . ./.machine.env
host="${SITE_SSH_HOST:-}"
dir="${SITE_REMOTE_DIR:-}"
registry="${SITE_NPM_REGISTRY:-}"
[ -n "${host}" ] && [ -n "${dir}" ] || fail "没配服务器：在 .machine.env 里填 SITE_SSH_HOST 和 SITE_REMOTE_DIR（见 .machine.env.example）"
# 这几项要原样拼进远端的命令行，只认不用转义的字符
for value in "${host}" "${dir}" "${registry}"; do
  case "${value}" in *[!A-Za-z0-9_./:@-]*) fail "配置里的 ${value} 含有空格或特殊字符" ;; esac
done
case "${dir}" in /*) ;; *) fail "SITE_REMOTE_DIR 要写绝对路径：${dir}" ;; esac

paths=".dockerignore package.json assets/icon.svg docs/media.json src/renderer/shared/provider-icons.mjs website"
# 传的是提交过的版本：有没提交的改动时停下，免得以为改了的已经上线
# shellcheck disable=SC2086
[ -z "$(git status --porcelain -- ${paths})" ] || fail "website/ 等有没提交的改动，部署的是当前提交，先提交"
commit="$(git rev-parse --short HEAD)"
version="$(node -p "require('./package.json').version")"

echo "deploy：传 ${commit}（下载链接指向 ${version}）到 ${host}:${dir}"
# shellcheck disable=SC2086
git archive --format=tar HEAD ${paths} |
  ssh "${host}" "rm -rf ${dir}/.incoming && mkdir -p ${dir}/.incoming && tar -x -C ${dir}/.incoming"

echo "deploy：在服务器上构建并换容器"
ssh "${host}" sh -s -- "${dir}" "${commit}" "${registry}" <<'REMOTE'
set -eu
dir="$1"
commit="$2"
registry="$3"
cd "${dir}"
# 换掉上一版的代码：这次传来的每个顶层文件和目录先整个删掉再搬进来，上一版有、这一版删掉的文件不留在构建目录里。
# 按传来的东西删，不另写一份名单：传的路径加了顶层目录，名单没跟上，mv 就会撞上已有的目录
for entry in .incoming/.dockerignore .incoming/*; do
  rm -rf "./${entry#.incoming/}"
done
mv .incoming/.dockerignore .incoming/* .
rmdir .incoming

old="$(docker image inspect orangespeakeasy-site:latest --format '{{.Id}}' 2>/dev/null || true)"
NPM_REGISTRY="${registry}" docker compose -f website/compose.yaml up -d --build

healthy=
for _ in $(seq 1 30); do
  if curl -fsS -m 2 http://127.0.0.1:9800/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [ -z "${healthy}" ]; then
  docker logs --tail 30 orangespeakeasy-site >&2
  echo "deploy：新容器 30 秒内没有响应 127.0.0.1:9800/health" >&2
  exit 1
fi

# 只删自己的上一版镜像，不碰同机别的项目的
new="$(docker image inspect orangespeakeasy-site:latest --format '{{.Id}}')"
if [ -n "${old}" ] && [ "${old}" != "${new}" ]; then
  docker image rm "${old}" >/dev/null || echo "deploy：上一版镜像 ${old} 没删掉，用 docker image rm 手动删" >&2
fi
# 记下线上是哪个提交，排查时对得上
echo "${commit}" >DEPLOYED_COMMIT
REMOTE

echo "deploy：好了，服务器上 127.0.0.1:9800 跑的是 ${commit}"
