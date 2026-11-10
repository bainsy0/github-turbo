# 更新日志

版本号与 `github-turbo.js` 头部的 `@version`、README 的「当前版本」保持一致（CI 会校验）。

## [1.1.0] - 2026-11-10

主题：**连接韧性**。针对「我在使用中还是有连不上 GitHub 的时候」（issue #1）逐条定位到脚本侧的五个放大环节并修掉，另外补了两个主站打不开时的逃生入口。

### 修复（「连不上」的根因）

- **探测能力闸门**：没有 `GM_xmlhttpRequest` 时，旧版测速退化成 `fetch`，被 CORS 挡掉后**所有节点一律判死**，
  于是 `buildAccel` 返回 null、页面上只剩直连 —— 这是「装了脚本还是连不上」最直接的原因。
  新增 `probeViaImage()`：用 `<img>` 加载 `raw.githubusercontent.com/microsoft/vscode/main/resources/win32/code.ico`
  的镜像地址计时（`?t=` 防缓存，onerror / 超时判死），加载跨域图片既不需要 CORS 读权限也不需要额外 `@grant`。
  由 `probeNode()` 统一分派：有 `GM_xmlhttpRequest` 走原来的 Range 强探测，没有则走图片探测。
- **失败冷却 10 分钟 → 1 分钟**：`freshTtl()` 把「成功 / 限流 / 失败」分开计时。旧版失败也复用 10 分钟的
  `HEALTH_TTL`，一次全网抖动就会让加速入口消失十分钟。现在失败只冷却 `FAIL_TTL`（1 分钟），过期自动回到候选池。
- **删除「单路线失败扩散整站」**：旧逻辑在一条路线探测失败时，把该节点声明的所有路线一起判死。
  2026-11 实测「raw 挂、archive/release 仍 206」是常态（如 `cdn.gh-proxy.org`），扩散属于误杀，现已删除，
  每条路线独立记账。
- **常驻看门狗**：`hasAnyVerified()` + `watchdogTick()`。只要「一个已验证节点都没有」就自动重测，
  30s 起、失败翻倍、封顶 5 分钟，恢复后回到 30s。旧版只在 `boot()` 探一次，网络恢复后必须手动点「重新测速」。
- **永不断链兜底**：`pickCandidates()` 在三档候选全空时，退回静态优先级里第一个「没有新鲜限流记录」的节点，
  不再返回空让按钮退化成直连。

### 新增

- **点击逐节点故障转移** `openWithFailover()`：点加速徽标或 Alt 点击下载时，并行验证最多
  `FAILOVER_TRIES = 3` 个候选（单节点 `FAILOVER_TIMEOUT = 2500`），用第一个真正通的打开；
  全部失败才退回手头那条链接；验证结果写回健康数据，下一次选择就跟着变好。
  `onDocumentClick()` 相应拆成两条路径：徽标（`data-gha-chip`）**永远接管**，原生链接保持原有 Alt / 自动接管行为。
  徽标用 `stripMirror()` 还原原始 URL、`classify()` 求路线，因此不需要给徽标加额外 data 属性。
- **逃生入口**（面板动作区与脚本菜单）：
  - 「KGitHub / bgithub 打开本页」—— HTML 反向代理（`github.com` → `kkgithub.com` / `bgithub.xyz`，路径不变）。
    `onMirrorHost()` 判断已经在镜像站上就隐藏该项。实测确认 gh-proxy 系**不能**代理 github.com 的 HTML（只返回落地页），
    所以必须用专门的 HTML 镜像。
  - 「复制 GitHub hosts」`copyHosts()` —— 依次尝试 `https://hosts.gitcdn.top/hosts.txt`（带 `Access-Control-Allow-Origin: *`）
    与 `https://raw.hellogithub.com/hosts`（无 CORS 头，只能靠 `GM_xmlhttpRequest`）；取到后校验
    「不是 HTML 落地页」且「含 github.com」再复制到剪贴板。新增 `fetchText()` 统一取文本。
    提示文案明确：只治 DNS 污染 / 图裂，治不了 SNI 封锁；`raw.hellogithub.com` 端点 2026-12-31 有到期风险。
- **自更新改走镜像**：`@updateURL` / `@downloadURL` 改为
  `https://cdn.gh-proxy.org/https://raw.githubusercontent.com/Bainsy0/github-turbo/main/github-turbo.js`
  （2026-11 实测 0.92s、内容新鲜）。README 记录 `gh-proxy.org` 前缀与 `gcore.jsdelivr.net/gh/...` 两个备用源。

### 节点表

- 移除 `fastly.jsdelivr.net`：实测 301 跳回**被墙**的 `raw.githubusercontent.com`，连正确的 `/gh/` 路径也跳，确认死链。
- 新增 `gh.catmak.name`（`id: 'catmak'`，`style: 'full'`，`caps: CAP.core`）：实测 raw / archive / release / gist 四条主线全 206。
  替换而非追加，保持 19 节点，避免 README 表格与 `scripts/check.js` 的计数校验失配。

### 工程 / 文档

- 补齐 `.gitignore`、`.editorconfig`（`[*.bat] end_of_line = crlf`）、`.gitattributes`（`*.bat text eol=crlf`）、
  `.github/workflows/check.yml`（Node 22，`node --check` + `node scripts/check.js`）。
  这些文件 README 早已承诺存在，但仓库里一直没有，`scripts/check.js` 因此长期报 5 项失败。
- README：版本号与徽章同步、功能表新增「连接韧性 / 点击故障转移 / 逃生入口」三行、节点策略补失败 TTL 与看门狗、
  节点表替换 catmak 行并列出 2026-11 实测未通过的候选、已知限制补 SNI 成因 / HTML 镜像限制 / hosts 局限与到期风险 /
  自更新镜像说明、参考补 GitHub520 / XIU2 wiki / akams / KGitHub、发布前自查加两条韧性检查。

## [1.0.1] - 2026-10-31

### 修复

- **油猴 API 取用方式**：改从脚本作用域读取 `GM_*`（`@grant` 声明的裸标识符），取不到再退回 `window`。
  只认 `window.GM_xxx` 在部分管理器 / 沙箱模式下会失败，届时测速退化为 `fetch`、被跨域挡掉，
  表现为「所有节点都挂、所有按钮回退直连」。现在两种取值形态都能覆盖（脚本作用域 / `window`），
  三种管理器的真机验证列在 README 的「发布前自查」里。
- **Linux 平台排序**：`deb` / `rpm` / `AppImage` / `Flatpak` / `Arch` 分组在 `os=linux` 时算作当前系统，
  否则 `.deb` 的基准分低于通用 tarball，「推荐」徽章会标到 tarball 上；同时删掉 `group.indexOf(os + '-')` 这个永不成立的条件。
- **raw 地址**：`toRawUrl` 不再把 `?plain=1` 带到 raw 链接上（与注释承诺一致）。
- **secret gist**：新增尽力而为的识别（`octolytics-dimension-gist_secret` meta / 页面 Secret 徽标），
  避免把带访问凭据的 gist 地址交给第三方镜像。
- **文件列表 ☁ 按钮**：提示文案改为「新标签页打开」，跨域时 `download` 属性本来就会被浏览器忽略。

### 工程 / 文档

- 补齐 `LICENSE`、`.gitignore`、`.editorconfig`、`.gitattributes`、`.github/workflows/check.yml`，
  README 的「项目结构」与仓库实际内容对齐。
- 新增 `scripts/check.js`（零依赖静态自检：版本号、节点表行数、README 链接、`serve.bat` 路径与换行），
  CI 从「只跑 `node --check`」扩展为「`node --check` + `node scripts/check.js`」。
- `serve.bat`：Python 改为实跑检测（`python -c "import sys"`），避开 Microsoft Store 占位别名；
  新增 `py -3` 兜底与 8765 端口占用检查；提示修改源码后需重新运行。
- README 删除无法复现的测试计数，改为可执行的「发布前自查」清单；补充 secret gist、
  页面结构依赖、raw 域名不可达三条已知限制。

## [1.0.0] - 2026-10-31

首个版本：19 个镜像节点自动测速择优、失败降级直连；Releases / 源码包 / Raw / Gist / 文件列表加速；
Release 增强显示（平台排序、推荐徽章、下载量、精确时间、日志折叠）；右下角悬浮面板。
