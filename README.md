# GitHub Turbo · GitHub 高速通道

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-1.0.1-blue.svg">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green.svg">
  <img alt="UserScript" src="https://img.shields.io/badge/UserScript-Tampermonkey%20%7C%20Violentmonkey%20%7C%20ScriptCat-orange.svg">
</p>

一个给 GitHub 页面加「高速通道」的用户脚本（UserScript）：自动测速挑选可用镜像，给 Releases 附件、源码包、Raw 文件、Gist 加上一键加速入口；节点失效会自动降级回直连，不产生死链。

- 当前版本：v1.0.1，2026-10-31
- 适用：Tampermonkey / Violentmonkey / ScriptCat（Chrome / Edge / Firefox）
- 匹配范围：`github.com`、`gist.github.com`、`raw.githubusercontent.com`、`gist.githubusercontent.com`，`document-start` 注入、不在 iframe 内运行
- 运行时依赖：无，单文件、无构建步骤

## 功能

| 功能 | 说明 |
| --- | --- |
| 节点测速 | 19 个镜像，4 并发 + 错峰探测，单节点 5s 超时，只取前 2KB 验证内容（并校验响应体，识别返回落地页的假镜像），按实测延迟择优 |
| 失败降级 | 健康度按「节点 + 路线」记录；429/403 记「限流」冷却 2 分钟，真挂的冷却 10 分钟；全部不可用时回退直连 |
| Releases | 每个附件旁注入「⚡ 加速」；支持 `/releases/download/...` 与 `/releases/latest/download/...` |
| 源码包 | Code → Download ZIP / TAR.GZ、Release 的 Source code 都有显式加速按钮，点击也会自动接管 |
| Raw / Gist | blob 页 Raw / Download raw file 按钮旁注入加速；raw 原文页顶部有镜像下载工具条 |
| 文件列表 | 仓库文件列表每行一个 ☁ 单文件直下（悬停显形，目录行不加） |
| Release 增强 | 按系统/架构排序、标出「推荐」、显示下载量、更新日志可折叠；相对时间转精确时间（默认关闭） |
| 图片加速 | 头像与 issue 配图走镜像，实验性功能，**默认关闭** |
| 面板 | 右下角悬浮球：节点列表与延迟、固定节点、重新测速（带进度）、clone 加速 / SSH 443 / 源码 zip / 复制链接；私有仓库只留 SSH 443 |
| 安全 | 私有仓库自动跳过（只提示、不派活）；测速 `anonymous` 不发送 Cookie；不在页面里写 token |

## 安装

### 方式一：脚本管理器（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) / Violentmonkey / ScriptCat。
2. 在脚本管理器中新建脚本，粘贴 [`github-turbo.js`](./github-turbo.js) 的全部内容并保存。
3. 打开任意 GitHub 页面，右下角出现 ⚡ 悬浮球即安装成功。

### 方式二：本地安装页（Windows）

双击 [`serve.bat`](./serve.bat)：会在本机 `8765` 端口起一个静态服务，并用浏览器打开安装页。改完 `github-turbo.js` 后要重新运行一次 `serve.bat`，否则 `.serve/` 里还是上次的副本。

脚本管理器的规矩是「地址以 `.user.js` 结尾才会弹安装页」，而本仓库的文件叫 `github-turbo.js`，所以 `serve.bat` 启动时会把它复制成 `.serve/github-turbo.user.js` 再打开该地址（`.serve/` 已在 `.gitignore` 中，源码始终只有 `github-turbo.js` 一份）。

### 方式三：从 GitHub raw 安装

同样是 `.user.js` 后缀的问题，两种做法：

- **一键安装**：在仓库里额外放一份发布副本并命名为 `github-turbo.user.js`（内容与 `github-turbo.js` 一致），再用它的 raw 地址安装：

```text
https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/github-turbo.user.js
```

- **只有 `github-turbo.js`**：直接打开 raw 地址只会显示源码，全选复制后按「方式一」粘贴保存即可，效果相同。

> 脚本头部的 `@namespace` / `@homepageURL` / `@supportURL` / `@updateURL` / `@downloadURL` 目前填的是 `Bainsy0/github-turbo`，发布到你自己的仓库时记得一起改。`@updateURL` 指向 raw 地址，装好后脚本管理器可在网络允许时自动检查更新（raw 域名被墙时不会成功，只能手动覆盖安装）。

> 首次运行时，脚本管理器会请求 `*` 域名的跨域权限（用于自定义镜像与 GitHub API）。如不放心，可把脚本头部的 `@connect *` 改回具体域名。

## 使用

点右下角 ⚡ 打开面板；也可以在脚本管理器菜单中操作：

- ⚡ 打开 / 收起面板
- 🔁 重新测速全部节点
- ⏯ 切换加速开关（悬浮球 `Shift + 点击` 亦可）
- 🔗 自定义镜像地址（会排在调度列表最前并参与测速；已用 `@connect *` 放行）
- ♻️ 恢复默认设置

面板开关：启用加速、附件按钮、文件 ☁ 下载、源码包加速、Alt 点击、图片加速、增强显示（Releases）、平台排序、下载量、精确时间、日志折叠，以及按系统 / 架构排序附件的下拉选择。

默认值：总开关、附件按钮、文件 ☁ 下载、源码包加速、Alt 点击、增强显示（平台排序 / 下载量 / 日志折叠）为开；**图片加速与精确时间默认关闭**，需要时在面板里勾选。

## 节点策略

- `caps`：每个节点实测支持哪些路线（raw / archive / release / gist / avatar），不支持就不派活。
- `tier 2`：jsdelivr 只代理 raw，且国内时通时不通，只做兜底，不会因为测速快而顶掉完整镜像。
- 健康度按 `节点id:路线` 存：raw 通但 release 挂的节点只会被排除在那条路线上，不会整站判死。
- 候选分三档：该路线实测通过 → 别的路线验证活着 → 从未测过；静态顺序只在最后一档兜底。
- 页面首屏先放 1 个按钮，测速落地后自动换成最快节点。
- 同一时刻只跑一轮测速，避免启动测速与手动「重新测速」互相覆盖结果。

2026-10-31 实测（「全路线」= raw / archive / release / gist / avatar）：

| 节点 | 前缀 | 能力 |
| --- | --- | --- |
| CDN.GH-Proxy | `cdn.gh-proxy.org` | raw / archive / release / gist / avatar |
| HK.GH-Proxy | `hk.gh-proxy.org` | 全路线 |
| GH-Proxy.org | `gh-proxy.org` | 全路线 |
| EdgeOne | `edgeone.gh-proxy.org` | 全路线 |
| GH-Proxy | `gh-proxy.com` | 全路线 |
| idayer | `gh.idayer.com` | 四条主线 |
| wget.la | `wget.la` | 四条主线 |
| GHProxy.net | `ghproxy.net` | 四条主线 |
| monlor | `gh.monlor.com` | 四条主线 |
| yylx.win | `git.yylx.win` | 四条主线 |
| geekertao | `ghfile.geekertao.top` | 四条主线 |
| hwinzniej | `ghpxy.hwinzniej.top` | 仅 raw |
| CrashMC | `cdn.crashmc.com` | raw + release |
| chjina | `gh.chjina.com` | raw + release |
| boki.moe | `github.boki.moe` | raw + release |
| keleyaa | `ghp.keleyaa.com` | raw + archive |
| JSDelivr-G | `gcore.jsdelivr.net` | raw（tier 2） |
| JSDelivr-CF | `testingcf.jsdelivr.net` | raw（tier 2） |
| JSDelivr | `fastly.jsdelivr.net` | raw（tier 2） |

已从节点表移除（实测 429/403 或返回落地页）：`ghproxy.cxkpro.top`、`gh.ddlc.top`、`gitproxy.mrhjx.cn`、`gh.h233.eu.org`。

## 已知限制

- 公开镜像只适合匿名读取。私有仓库、`git push`、需要 Token 的 API 不经过镜像（脚本会主动跳过私有仓库）。
- 每个节点只实测一条主路线（优先 raw），其余路线按能力表派活；主路线失败会判定整站不可用，但「raw 通、release 挂」只能靠降级体验兜住。
- 免费镜像会限流、会跑路；脚本能降级，但不能保证任何时刻都有节点可用。
- 镜像方理论上能看到并修改下载内容；下载可执行文件时建议核对 Release 给出的 sha256。
- jsdelivr 有单文件大小上限（约 20MB），大文件会失败并回退直连。
- 图片加速（头像 / issue 配图）为实验功能，默认关闭；部分节点已不支持 avatar 路线，开启后可能直接走原图。
- secret gist 只能尽力识别（GitHub 没有稳定标记）：识别不到时仍会照常走镜像，处理敏感 gist 前请手动关掉加速。
- Release 增强显示依赖 GitHub 当前页面结构（`summary` 里的 "assets"、`octolytics-*` meta、`data-testid`）。GitHub 改版后这部分可能静默失效，此时只有加速功能仍可用。
- `@updateURL` 指向 `raw.githubusercontent.com`，该域名在部分网络下不可达，脚本管理器可能无法自动检查更新，必要时按「安装」里任一种方式覆盖安装。

## 项目结构

```text
.
├── github-turbo.js              # 用户脚本（唯一运行时代码）
├── README.md
├── CHANGELOG.md
├── LICENSE                      # MIT
├── serve.bat                    # Windows 本地安装页（8765 端口，生成 .serve/ 别名后打开）
├── scripts/check.js             # 静态自检（node scripts/check.js，CI 跑同一份）
├── .github/workflows/check.yml  # CI：node --check + scripts/check.js
├── .editorconfig
├── .gitattributes               # *.bat 固定 CRLF
└── .gitignore                   # 忽略 .serve/ 等本地产物
```

## 开发与校验

本项目没有构建步骤，改完直接刷新页面即可。提交前跑一遍自检（Node.js 18+，CI 也是这两条）：

```bash
node --check github-turbo.js
node scripts/check.js
```

[`scripts/check.js`](./scripts/check.js) 不依赖任何包，专查「改一处忘一处」的四类问题：三处版本号是否一致（脚本 `@version`、本文「当前版本」、`CHANGELOG.md` 最新条目）、README 节点表行数与脚本 `MIRRORS` 是否对得上、README 里的相对链接是否都存在、`serve.bat` 的 `FILE` 与 CRLF 换行是否正常。

修改节点表、能力或默认配置时，请同步更新 README 的节点表与 [`CHANGELOG.md`](./CHANGELOG.md)；改动用户可见的开关或菜单项，也要同步本文的「功能 / 使用」两节。

> 给脚本文件改名时，记得同时改 `serve.bat` 里的 `FILE` 与 [`check.yml`](./.github/workflows/check.yml) 里的检查路径，否则本地安装页会 404、CI 会失败。

### 发布前自查

仓库里不放 DOM 测试，页面相关的检查发布前按下面清单人工过一遍（v1.0.1 已执行前两项）：

- [x] `node --check github-turbo.js` 与 `node scripts/check.js` 通过（CI 同样执行）
- [x] README 的节点表、默认开关、版本号与脚本常量逐项核对
- [ ] Chrome + Tampermonkey、Firefox + Violentmonkey、Edge + ScriptCat 各跑一次：悬浮球、测速、附件按钮、raw 工具条
- [ ] 私有仓库与 secret gist 页面确认不注入加速按钮
- [ ] 下载一个 Release 附件与一个源码包，核对 MZ / PK 文件头
- [ ] 关闭总开关后确认页面上没有残留的加速入口

> 早期的 jsdom 冒烟、真实 Edge 渲染与真实网络下载属于开发期检查，脚本未随仓库发布；需要时按上面的清单手工覆盖。

## 更新日志

完整记录见 [`CHANGELOG.md`](./CHANGELOG.md)。当前 **v1.0.1**（2026-10-31）：修正油猴 API 取用方式（兼容 Violentmonkey / ScriptCat）、Linux 包格式的排序与推荐、raw 地址上多余的查询串；同时补齐 `LICENSE`、CI 等仓库文件。v1.0.0 是首个版本。

## 参考

- 镜像用法与可用性参考：[GitHub 加速代理入口大全](https://yuanhangapp.com/zh/tools/github-proxy/)、[GitHub 加速服务](https://sunhaoming665.github.io/github-faster)
- 同类脚本思路：[Github Enhancement - High Speed Download](https://greasyfork.org/scripts/412245-github-enhancement-high-speed-download)

> 第三方镜像由各站点独立运营，与本人无关；请自行评估风险。

## 许可证

[MIT](./LICENSE) © 2026 Bainsy0
