import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const site = readJson("./site.config.json");
// 官网上的下载链接跟着 App 的版本走：发了新版本，重新构建官网就指向新的安装包
const { version } = readJson("../package.json");

/**
 * 页面的内容安全策略：只许加载自己的脚本和样式，图片只从自己和图片域名来。图片域名取自配置，换域名不用改这里。
 * 样式要放行 'unsafe-inline'：React 的 style 属性就是行内样式
 */
function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    `img-src 'self' data: ${new URL(site.mediaBase).origin}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * index.html 里的 %SITE_URL% 这类占位换成配置里的值（给搜索引擎和分享卡片看的，不等脚本跑起来）。
 * 构建时再写进内容安全策略；开发时不写，Vite 的热更新要用行内脚本
 */
function siteHtml() {
  return {
    name: "orangespeakeasy-site-html",
    transformIndexHtml(html, context) {
      const filled = html.replaceAll("%SITE_URL%", site.siteUrl.replace(/\/+$/, ""));
      if (context.server) return filled;
      return {
        html: filled,
        tags: [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy() },
            injectTo: "head-prepend",
          },
        ],
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), siteHtml()],
  define: { __ORANGESPEAKEASY_VERSION__: JSON.stringify(version) },
  // 图标那方印在仓库根的 assets/ 里，和 App 用的是同一个文件
  server: { fs: { allow: [".."] } },
});
