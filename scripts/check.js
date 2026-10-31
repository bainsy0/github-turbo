#!/usr/bin/env node
/**
 * 静态自检：本地 `node scripts/check.js`，CI 跑同一份（见 .github/workflows/check.yml）。
 * 只查「改了一处忘了另一处」这类问题，不启动浏览器、不解析页面 DOM，所以不需要任何依赖。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const failures = [];

function expect(cond, msg) {
  if (!cond) failures.push(msg);
}

const js = read('github-turbo.js');
const md = read('README.md');
const cl = read('CHANGELOG.md');
const bat = read('serve.bat');

/* 1. 版本号：脚本头 / README / CHANGELOG 必须一致 */
const version = (js.match(/^\/\/ @version\s+(\S+)/m) || [])[1];
const mdVersion = (md.match(/当前版本：v([0-9.]+)/) || [])[1];
const clVersion = (cl.match(/^## \[([0-9.]+)\]/m) || [])[1];
expect(version, 'github-turbo.js 头部缺少 @version');
expect(mdVersion, 'README 缺少「当前版本：vX.Y.Z」');
expect(clVersion, 'CHANGELOG 缺少「## [X.Y.Z]」条目');
expect(version === mdVersion && version === clVersion,
  `版本号不一致：脚本 ${version} / README ${mdVersion} / CHANGELOG ${clVersion}`);

/* 2. 节点表：README 表格行数 = 脚本 MIRRORS 条数 */
const mirrorStart = js.indexOf('var MIRRORS = [');
const mirrorBlock = js.slice(mirrorStart, js.indexOf('];', mirrorStart));
const jsNodes = (mirrorBlock.match(/id: '/g) || []).length;
const mdNodes = (md.match(/^\| [^|]+ \| `[^`]+` \|/gm) || []).length;
expect(mirrorStart >= 0 && jsNodes > 0, '脚本里找不到 MIRRORS 节点表');
expect(jsNodes === mdNodes, `节点数不一致：脚本 ${jsNodes} 个 / README 表格 ${mdNodes} 行`);

/* 3. 油猴 API 必须统一走 GM_API（防止退回只认 window.GM_xxx 的写法） */
expect(js.includes('var GM_API = {'), '脚本里找不到 GM_API 定义');
expect(!/window\.GM_(getValue|setValue|xmlhttpRequest|registerMenuCommand|addStyle|setClipboard)/.test(js),
  '脚本里仍有 window.GM_* 调用，应统一走 GM_API');

/* 4. serve.bat：FILE 指向真实文件；换行必须统一 CRLF（LF 可能让 cmd 解析出错） */
const batFile = (bat.match(/set "FILE=([^"]+)"/) || [])[1];
expect(batFile && exists(batFile), `serve.bat 的 FILE 指向不存在的文件：${batFile}`);
const crlf = (bat.match(/\r\n/g) || []).length;
const lf = (bat.match(/\n/g) || []).length;
expect(crlf > 0 && crlf === lf, `serve.bat 换行不是统一 CRLF（CRLF ${crlf} / LF ${lf}）`);

/* 5. README 里的相对链接必须都能打开 */
const links = [...new Set((md.match(/\]\(\.\/([^)#]+)\)/g) || []).map((s) => s.slice(3, -1)))];
links.forEach((p) => expect(exists(p), `README 链接指向不存在的文件：./${p}`));

/* 6. README 承诺的仓库文件确实存在 */
['LICENSE', 'CHANGELOG.md', '.gitignore', '.editorconfig', '.gitattributes', '.github/workflows/check.yml']
  .forEach((p) => expect(exists(p), `缺少仓库文件：${p}`));

if (failures.length) {
  console.error(`检查失败（${failures.length} 项）：`);
  failures.forEach((m) => console.error(' - ' + m));
  process.exit(1);
}
console.log(`全部检查通过：版本 ${version}，节点 ${jsNodes} 个，README 链接 ${links.length} 条。`);
