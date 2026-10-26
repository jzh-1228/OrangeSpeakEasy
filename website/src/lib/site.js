// 页面上的各种地址都从 site.config.json 和版本号算出来，组件里不写死域名。

/**
 * @param {{ siteUrl: string, downloadBase: string, mediaBase: string, repository: string }} site
 * @param {string} version 当前发布的版本号，不带 v（取仓库根上 package.json 的）
 */
export function siteLinks(site, version) {
  const base = site.downloadBase.replace(/\/+$/, "");
  const media = site.mediaBase.replace(/\/+$/, "");
  return {
    version,
    /** 三个直接下载的安装包：两种芯片的 Mac 各一个 dmg，Windows 一个安装程序 */
    downloads: {
      arm64: `${base}/v${version}/OrangeSpeakEasy-arm64.dmg`,
      x64: `${base}/v${version}/OrangeSpeakEasy-x64.dmg`,
      windows: `${base}/v${version}/OrangeSpeakEasy-Setup-x64.exe`,
    },
    /** 终端里装的一行：macOS 的终端、Windows 的 PowerShell */
    install: {
      mac: `curl -fsSL ${base}/install.sh | bash`,
      windows: `irm ${base}/install.ps1 | iex`,
    },
    repository: site.repository,
    license: `${site.repository}/blob/main/LICENSE`,
    /** COS 上一张图的地址；path 是 src/media.json 里记的对象名 */
    media: (path) => `${media}/${path}`,
  };
}
