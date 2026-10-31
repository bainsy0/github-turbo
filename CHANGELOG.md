# 更新日志

版本号与 `github-turbo.js` 头部的 `@version`、README 的「当前版本」保持一致（CI 会校验）。

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
