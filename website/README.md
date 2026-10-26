# OrangeSpeakEasy 官网

`orangespeakeasy.zephyrxiang.com` 的源码：一个单页的静态站，React 19 + Tailwind CSS v4 + Vite，中英双语。

## 跑起来

```bash
cd website
npm install
npm run dev        # http://localhost:5173
npm test           # 文案结构、选语言、地址、图标、截图清单
npm run build      # 出 dist/
```

lint 用仓库根上的 biome：在仓库根 `npm run lint`（已经包含 `website/`）。

## 东西在哪

| 位置 | 是什么 |
| --- | --- |
| `site.config.json` | 域名、下载地址、图片地址、仓库地址。换域名只改这里 |
| `src/i18n/en.js`、`zh-CN.js` | 两种语言的文案，结构一一对应（`test/i18n.test.mjs` 会查）。加一种语言：照样子加一个文件，在 `src/i18n/index.jsx` 和 `src/lib/locale.js` 里登记 |
| `src/sections/` | 页面从上到下的每一段 |
| `src/components/` | 几段共用的：段落和标题、键帽、悬浮条（会动的那条）、Mac 窗口框、复制命令 |
| `src/icons/` | `data.js` 是 `npm run icons`（`scripts/icons.mjs`）从 Iconify 取下来的 SVG，别手改；加图标在脚本里登记一行 |
| `src/media.json` | 截图在 COS 上的对象名和大小，由 `scripts/upload-media.mjs` 写 |
| `Dockerfile`、`compose.yaml`、`nginx.conf` | 上线用的容器 |

下载链接的版本号取仓库根 `package.json` 的：发了新版本，重新构建、部署官网，链接就指向新的安装包。

选语言的顺序：网址里的 `?lang=en` / `?lang=zh-CN` → 访客上次手动选的 → 浏览器的语言（中文的各种写法都算简体中文，别的都是英文）。切换时网址跟着改，复制链接给别人是同一种语言。

## 截图

图是 App 的真页面、真样式配上造的数据，在 Electron 里离屏截的（不碰 `~/.orangespeakeasy`），存成 WebP，传到单独的 COS 桶，经 CDN 域名 `media.orangespeakeasy.zephyrxiang.com` 给页面用。仓库里不放图。App 的界面改了就重截：

```bash
cd website
../node_modules/.bin/electron scripts/screenshots.mjs -- <临时目录>
../scripts/release/with-cos-key.sh node scripts/upload-media.mjs <临时目录>
```

桶名在本机配置 `.machine.env` 的 `SITE_MEDIA_BUCKET`（带着账号编号，不进仓库），密钥由 `with-cos-key.sh` 给。对象名带内容指纹，图变了名字就变，CDN 缓存一年不用刷新；传过的同名对象跳过。

## 上线

和同一台服务器上别的站一样用 Docker 隔开：容器里的 nginx 托管 `dist/`，端口只绑 `127.0.0.1:9800`，宿主机的 nginx 终止 HTTPS 再反代过来。宿主机上不装 Node，构建在容器里做。

部署（改完先提交，部署的是当前提交）：

```bash
cd website
npm run deploy
```

`scripts/deploy.sh` 从当前提交里取出构建要用的那几样（`package.json`、`assets/icon.svg`、`website/`，和 `.dockerignore` 一致），经 SSH 传到服务器的部署目录，在那里 `docker compose -f website/compose.yaml up -d --build`，等 `/health` 答应，删掉自己的上一版镜像，把线上的提交记在部署目录的 `DEPLOYED_COMMIT`。服务器不连 GitHub。服务器、部署目录、npm 源在 `.machine.env` 的 `SITE_SSH_HOST`、`SITE_REMOTE_DIR`、`SITE_NPM_REGISTRY`（见 `.machine.env.example`）；服务器在大陆时 npm 源填国内的，官方源从那里取一个包十几秒。

发了新版本要再部署一次：下载链接的版本号是构建时取的。

宿主机 nginx 的站点文件是 `host-nginx.conf`，放在服务器的 `/etc/nginx/sites-available/orangespeakeasy-site`。改它时先备份，`sudo nginx -t` 通过才 `sudo systemctl reload nginx`。回滚：容器出了问题就把上一个提交 `npm run deploy` 一次；站点文件出了问题就换回备份再 reload。

只在本机试容器（OrbStack 或 Docker Desktop）：

```bash
docker compose -f website/compose.yaml up -d --build   # 在仓库根
curl http://127.0.0.1:9800/health
docker compose -f website/compose.yaml down --rmi local
```

页面的内容安全策略构建时按 `site.config.json` 写进 `index.html`：只许加载自己的脚本、样式，图片只从自己和图片域名来。
