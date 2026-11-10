# GitHub Turbo · GitHub 高速通道

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-1.1.1-blue.svg">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green.svg">
  <img alt="UserScript" src="https://img.shields.io/badge/UserScript-Tampermonkey%20%7C%20Violentmonkey%20%7C%20ScriptCat-orange.svg">
</p>

一个给 GitHub 页面加「高速通道」的用户脚本（UserScript）：自动测速挑选可用镜像，给 Releases 附件、源码包、Raw 文件、Gist 加上一键加速入口。重点解决「有时就是连不上 GitHub」：节点失败一分钟即自动复活、点击时逐节点故障转移、极端情况下也绝不退化成直连，另外内置镜像站与 hosts 两条逃生入口。

- 当前版本：v1.1.1，2026-11-10
- 适用：Tampermonkey / Violentmonkey / ScriptCat（Chrome / Edge / Firefox）
- 匹配范围：`github.com`、`gist.github.com`、`raw.githubusercontent.com`、`gist.githubusercontent.com`，`document-start` 注入、不在 iframe 内运行
- 运行时依赖：无，单文件、无构建步骤

## 功能

| 功能 | 说明 |
| --- | --- |
| 节点测速 | 19 个镜像，4 并发 + 错峰探测，单节点 5s 超时，只取前 4KB 验证内容（并校验响应体，识别返回落地页的假镜像），按实测延迟择优。没有 `GM_xmlhttpRequest` 时自动改用 `<img>` 探测（免 CORS）；探测通道本身发不出请求时，先走 `fetch` 复核再判死，不会因为跨域被挡就把全部节点判死 |
| 连接韧性 | 健康度按「节点 + 路线」独立记账；429/403 记「限流」冷却 2 分钟，真挂的只冷却 1 分钟；常驻看门狗在「零可用节点」时自动重测（30s 起，退避封顶 5 分钟），网络一恢复即自动复活；候选全空时退回静态优先级兜底，绝不断链 |
| 点击故障转移 | 点加速徽标或 Alt 点击下载时，并行验证最多 3 个候选节点，用第一个真正通的打开；全部失败才退回手头那条链接，并把结果写回健康数据 |
| 逃生入口 | 连不上主站时可用「KGitHub / bgithub 打开本页」（HTML 反向代理），或一键复制 GitHub520 hosts（免访问 GitHub）；面板与脚本菜单里都有 |
| Releases | 每个附件旁注入「⚡ 加速」；支持 `/releases/download/...` 与 `/releases/latest/download/...` |
| 源码包 | Code → Download ZIP / TAR.GZ、Release → Source code 都有显式加速按钮，点击也会自动接管 |
| Raw / Gist | blob 页 Raw / Download raw file 按钮旁注入加速；raw 原文页顶部有镜像下载工具栏 |
| 文件列表 | 仓库文件列表每行一个 ⚡ 单文件直下（悬停显形，目录行不加） |
| Release 增强 | 按系统 / 架构排序、标出「推荐」、显示下载量、更新日志可折叠；相对时间转精确时间（默认关闭） |
| 图片加速 | 头像与 issue 配图走镜像，实验性功能，**默认关闭** |
| 面板 | 右下角悬浮球：节点列表与延迟、固定节点、重新测速（带进度）、clone 加速 / SSH 443 / 源码 zip / 复制链接、镜像站打开本页 / 复制 hosts；私有仓库只给 SSH 443 与逃生入口 |
| 安全 | 私有仓库自动跳过（只提示、不派活）；测速 `anonymous` 不发 Cookie；不在页面里存 token |

## 安装

### 方式一：脚本管理器（推荐）

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) / Violentmonkey / ScriptCat。
2. 在脚本管理器中新建脚本，粘贴 [`github-turbo.js`](./github-turbo.js) 的全部内容并保存。
3. 打开任意 GitHub 页面，右下角出现 ⚡ 悬浮球即安装成功。

### 方式二：本地安装页（Windows）

双击 [`serve.bat`](./serve.bat)：会在本地 `8765` 端口起一个静态服务，并用浏览器打开安装页。改完 `github-turbo.js` 后要重新运行一次 `serve.bat`，否则 `.serve/` 里还是上次的副本。

脚本管理器的规矩是「地址以 `.user.js` 结尾才会弹安装页」，而本仓库的文件叫 `github-turbo.js`，所以 `serve.bat` 启动时会把它复制成 `.serve/github-turbo.user.js` 再打开该地址（`.serve/` 已在 `.gitignore` 中，源码始终只有 `github-turbo.js` 一份）。

服务由 [`scripts/serve.py`](./scripts/serve.py) 提供，不用 `python -m http.server`：标准库给出的 `Content-Type: text/javascript` 不带 charset，中文 Windows 上的浏览器会退回系统默认编码（CP936）解码 UTF-8 脚本，安装页直接变成「楂橀€熼€氶亾」这种乱码，脚本管理器也认不出头部。`serve.py` 给所有文本类型补上了 `charset=utf-8`，并加了 `Cache-Control: no-store`（改完脚本重跑 `serve.bat` 一定拿到新版本）。

### 方式三：从 GitHub raw 安装

同样有 `.user.js` 后缀的问题，两种做法：

- **一键安装**：在仓库里额外放一份发布副本并命名为 `github-turbo.user.js`（内容与 `github-turbo.js` 一致），再用它的 raw 地址安装：

```text
https://raw.githubusercontent.com/<你的用户名>/<仓库名>/main/github-turbo.user.js
```

- **只有 `github-turbo.js`**：直接打开 raw 地址只会显示源码，全选复制后按「方式一」粘贴保存即可，效果相同。

> 脚本头部里的 `@namespace` / `@homepageURL` / `@supportURL` / `@updateURL` / `@downloadURL` 目前填的都是 `Bainsy0/github-turbo`，发布到你自己的仓库时记得一起改。`@updateURL` / `@downloadURL` 指向 **`cdn.gh-proxy.org` 前缀 + raw 路径**，这样即使 `raw.githubusercontent.com` 直连被墙也能取到新版本（v1.1.0 起）；同一条链接换成 `https://gh-proxy.org/` 或 `https://gcore.jsdelivr.net/gh/Bainsy0/github-turbo@main/github-turbo.js` 也是实测可用的备用源。

> 首次运行时，脚本管理器会请求 `*` 域名的跨域权限（用于自定义镜像与 GitHub API）。如不放心，可把脚本头部里的 `@connect *` 改回具体域名。

## 使用

点右下角 ⚡ 打开面板；也可以在脚本管理器菜单中操作：

- ⚡ 打开 / 收起面板
- 🔁 重新测速全部节点
- ⏯ 切换加速开关（悬浮球 `Shift + 点击` 亦可）
- 🔗 自定义镜像地址（会排在调度列表最前并参与测速；已用 `@connect *` 放行）
- 🚪 KGitHub / bgithub 打开本页（主站打不开时的 HTML 反向代理逃生口）
- 📋 复制 GitHub hosts（GitHub520，免访问 GitHub 取最新 hosts）
- ♻️ 恢复默认设置

面板开关：启用加速、附件按钮、文件 ☁ 下载、源码包加速、Alt 点击、图片加速、增强显示（Releases）、平台排序、下载量、精确时间、日志折叠，以及按系统 / 架构排序附件的下拉选择。

默认值：总开关、附件按钮、文件 ☁ 下载、源码包加速、Alt 点击、增强显示（平台排序 / 下载量 / 日志折叠）为开；**图片加速与精确时间默认关闭**，需要时在面板里勾选。

## 节点策略

- `caps`：每个节点实测支持哪些路线（raw / archive / release / gist / avatar），不支持就不派活。
- `tier 2`：jsdelivr 只代理 raw，且国内时通时不通，只做兜底，不会因为测速快而顶掉完整镜像。
- 健康度按 `节点id:路线` 存：raw 通但 release 挂的节点只会被排除在那条路线上，不会整站判死。
- 失败结果只冷却 1 分钟（限流 2 分钟、成功 10 分钟），过期自动回到候选池；不会因为一次抖动就静默失效十分钟。
- 候选分档：该路线实测通过 → 别的路线验证活着 → 从未测过；三档全空时退回静态优先级（只排除刚被限流的节点），保证按钮永远是加速链接而不是直连。
- 「脚本自己的探测通道发不出去」不算节点死亡（v1.1.1 起）：`status:0` 会先经 `fetch` 复核，复核仍失败只记 `transport` 并降级到「从未测过」档，面板显示黄点「探测失败」，不会把 19 个节点一起剔除。
- 页面首屏先放 1 个按钮，测速落地后自动换成最快节点。
- 同一时刻只跑一轮测速，避免启动测速与手动「重新测速」互相覆盖结果。
- 常驻看门狗：只要「一个已验证节点都没有」就自动重测（30s 起、失败翻倍、封顶 5 分钟，恢复后回到 30s）。
- 点击时逐节点故障转移：并行验证最多 3 个候选，用第一个通的；结果写回健康数据，下一次选择就跟着变好。

2026-11-10 实测（「全路线」= raw / archive / release / gist / avatar；「四条主线」= 前四条）：

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
| catmak | `gh.catmak.name` | 四条主线 |

已从节点表移除（实测 429/403 或返回落地页）：`ghproxy.cxkpro.top`、`gh.ddlc.top`、`gitproxy.mrhjx.cn`、`gh.h233.eu.org`、`fastly.jsdelivr.net`（301 跳回被墙的 raw，连正确 `/gh/` 路径也跳）。

2026-11 新增候选实测未通过、故未收录：`gh.llkk.cc`、`github.moeyy.xyz`、`ghfast.top`、`gh-proxy.ygxz.in`（连接超时）、`ghproxy.cc`（证书过期）、`gh.ddlc.top`（502 后连接重置）、`ghproxy.cxkpro.top`（429）、`slink.ltd`、`gh-proxy.net`（返回落地页）、`ghproxy.homeboyc.cn`（403）。

## 已知限制

- 公开镜像只适合匿名读取。私有仓库、`git push`、需要 Token 的 API 不经过镜像（脚本会主动跳过私有仓库）。
- 每个节点只实测一条主路线（优先 raw），其余路线按能力表派活；不同路线的实测结果独立记账（v1.1.0 起不再把一条路线的失败扩散到整个节点）。
- **脚本不接管 `github.com` 的 HTML 页面**：`classify()` 只识别 release / archive / legacy / raw / blob，主站网页本身不走镜像（镜像对 HTML 只会回落地页或 404）。主站打不开时唯一的退路是下面的两个逃生口。
- 「有时连不上」的根因多半不在脚本：国内部分网络对 GitHub 域名做 SNI 干扰（443 会挂起数分钟），改 DNS、改 hosts 都无效。脚本能做的是换镜像节点、并在镜像也全军覆没时给出 HTML 反向代理与 hosts 两条逃生路径，不能保证任何时刻都能连上。
- 免费镜像会限流、会跑路；脚本能降级，但不能保证任何时刻都有节点可用。
- 镜像方理论上能看到并修改下载内容；下载可执行文件时建议核对 Release 给出的 sha256。
- jsdelivr 有单文件大小上限（约 20MB），大文件会失败并回退直连。
- 图片加速（头像 / issue 配图）为实验功能，默认关闭；部分节点已不支持 avatar 路线，开启后可能直接走原图。
- secret gist 只能尽力识别（GitHub 没有稳定标记）：识别不到时仍会照常走镜像，处理敏感 gist 前请手动关掉加速。
- Release 增强显示依赖 GitHub 当前页面结构（`summary` 里的 "assets"、`octolytics-*` meta、`data-testid`）。GitHub 改版后这部分可能静默失效，此时只有加速功能仍可用。
- HTML 反向代理（KGitHub / bgithub）只在浏览器里看页面用，**不能登录后做写操作、不能上传**，也不适合下载大文件；它们同样会失效（2026-11-10 实测 `kkgithub.com` 证书过期、`bgithub.xyz` 超时），脚本只是把入口放在手边。
- 「复制 hosts」取自 GitHub520：只改善 DNS 污染与图片裂开，治不了 SNI 封锁；其中的 `raw.hellogithub.com` 端点官方标注 2026-12-31 到期，长期依赖有风险。脚本不会替你改系统 hosts，需要自己粘贴（Windows 在 `C:\Windows\System32\drivers\etc\hosts`）。
- `@updateURL` 已改为经 `cdn.gh-proxy.org` 前缀的 raw（实测该镜像下最快）。若该镜像也失效，可在脚本管理器里手动覆盖安装；README「安装」里另附了 `gcore.jsdelivr.net/gh/...` 与 `gh-proxy.org/https://raw...` 两个备用源。

## 项目结构

```text
.
├── github-turbo.js              # 用户脚本（唯一运行时代码）
├── README.md
├── CHANGELOG.md
├── LICENSE                      # MIT
├── serve.bat                    # Windows 本地安装页（8765 端口，生成 .serve/ 别名后打开）
├── scripts/serve.py             # 本地安装服务（强制 charset=utf-8，避免安装页乱码）
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

### 发布前自检

仓库里不跑 DOM 测试，页面相关的检查发布前按下面清单人工过一遍（v1.1.1 已执行前两项）：

- [x] `node --check github-turbo.js` 与 `node scripts/check.js` 通过（CI 同样执行）
- [x] README 的节点表、默认开关、版本号与脚本常量逐项核对
- [ ] Chrome + Tampermonkey、Firefox + Violentmonkey、Edge + ScriptCat 各跑一次：悬浮球、测速、附件按钮、raw 工具栏
- [ ] 私有仓库与 secret gist 页面确认不注入加速按钮
- [ ] 下载一个 Release 附件与一个源码包，核对 MZ / PK 文件头
- [ ] 关闭总开关后确认页面上没有残留的加速入口
- [ ] 断网 / 屏蔽全部镜像后再恢复，确认看门狗能在 1–2 分钟内把加速入口自动带回来
- [ ] 点一个徽标时手动把一个节点改坏，确认故障转移会换到下一个节点而不是下载失败

> 早期的 jsdom 冒烟、真实 Edge 渲染与真实网络下载属于开发期检查，脚本未随仓库发布；需要时按上面的清单手工覆盖。

## 更新日志

完整记录见 [`CHANGELOG.md`](./CHANGELOG.md)。当前 **v1.1.1**（2026-11-10）：修正「把好节点判死」的误杀链——`status:0` 不再等于节点死亡（先走 `probeViaFetch` 复核）、探测通道失败（`transport`）降级而不剔除、兜底条件修正、探测图换成 9KB PNG 且多源回退、fetch 探测不带 `Range`、面板用黄点「探测失败」区分原因。v1.1.0 是连接韧性版：探测能力闸门（无 `GM_xmlhttpRequest` 时改用图片探测）、失败只冷却 1 分钟 + 常驻看门狗自动复活、点击逐节点故障转移、候选全空时的静态兜底、镜像站 / hosts 逃生入口、自更新改走镜像，并移除已死掉的 `fastly.jsdelivr.net` 节点。v1.0.0 是首个版本，v1.0.1 修正了油猴 API 取用与排序细节。

## 参考

- 镜像用法与可用性参考：[GitHub 加速代理入口大全](https://yuanhangapp.com/zh/tools/github-proxy/)、[GitHub 加速服务](https://sunhaoming665.github.io/github-faster)
- 同类脚本思路：[Github Enhancement - High Speed Download](https://greasyfork.org/scripts/412245-github-enhancement-high-speed-download) 及其 [说明 wiki](https://github.com/XIU2/UserScript/wiki/Github-%E5%A2%9E%E5%BC%BA---%E9%AB%98%E9%80%9F%E4%B8%8B%E8%BD%BD)（本项目从中学到：并列多个回退链接、随机分散负载、避开美国 Cloudflare 节点）
- 免 CORS 的图片延迟探测思路：[github.akams.cn](https://github.akams.cn/)（对每个镜像加载 `<img>` 计时，本项目 `probeViaImage` 同源思路）
- hosts 方案：[521xueweihan/GitHub520](https://github.com/521xueweihan/GitHub520)（README 明确「无需访问 GitHub 即可获取」）
- HTML 反向代理：[KGitHub](https://help.kkgithub.com/questions/)（Zmirror 架构，`github.com` → `kkgithub.com` 路径不变）、`bgithub.xyz`

> 第三方镜像由各站点独立运营，与本人无关；请自行评估风险。

## 许可证

[MIT](./LICENSE) © 2026 Bainsy0
