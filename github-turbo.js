// ==UserScript==
// @name         GitHub 高速通道 · GitHub Turbo
// @name:zh-CN   GitHub 高速通道
// @namespace    https://github.com/Bainsy0/github-turbo
// @version      1.1.0
// @description  给 GitHub 页面加一条高速通道：19 个镜像节点自动测速择优、失败自动复活、点击逐节点故障转移、永不断链兜底，Releases / 源码包 / Raw / Gist / 头像一键加速；无 GM_xmlhttpRequest 时用图片探测免 CORS 测速；内置镜像站打开本页 / 复制 hosts 逃生入口；Release 附件按系统与架构排序标出推荐、显示下载量、精确时间、折叠更新日志；raw 页面另有一键镜像下载工具条。
// @author       Bainsy0
// @license      MIT
// @homepageURL  https://github.com/Bainsy0/github-turbo
// @supportURL   https://github.com/Bainsy0/github-turbo/issues
// @updateURL    https://cdn.gh-proxy.org/https://raw.githubusercontent.com/Bainsy0/github-turbo/main/github-turbo.js
// @downloadURL  https://cdn.gh-proxy.org/https://raw.githubusercontent.com/Bainsy0/github-turbo/main/github-turbo.js
// @match        https://github.com/*
// @match        https://gist.github.com/*
// @match        https://raw.githubusercontent.com/*
// @match        https://gist.githubusercontent.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @connect      *
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // 防止重复注入（部分脚本管理器在多标签 / SPA 场景可能重复执行）
  if (window.__GHA_LOADED__) return;
  window.__GHA_LOADED__ = true;

  /* ── 油猴 API 取用 ──────────────────────────────────────────
   * GM_* 的规范位置是「脚本作用域」（@grant 声明后注入的裸标识符），
   * 并不保证是 window 的属性；Tampermonkey / Violentmonkey / ScriptCat
   * 的沙箱实现各不相同。只认 window.GM_xxx 时，某些组合会一个都取不到，
   * 脚本随之静默退化：测速退回 fetch 被跨域挡掉 → 所有节点判死、
   * 下载量拿不到、配置也写不进 GM 存储。
   * 这里先看脚本作用域的裸标识符，取不到再退回 window，两种环境都能用。
   * ────────────────────────────────────────────────────────── */
  function gmPick(name, direct) {
    if (typeof direct === 'function') return direct;
    try {
      if (typeof window !== 'undefined' && typeof window[name] === 'function') return window[name];
    } catch (e) { /* ignore */ }
    return null;
  }

  var GM_API = {
    getValue: gmPick('GM_getValue', typeof GM_getValue === 'function' ? GM_getValue : null),
    setValue: gmPick('GM_setValue', typeof GM_setValue === 'function' ? GM_setValue : null),
    xhr: gmPick('GM_xmlhttpRequest', typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null),
    menu: gmPick('GM_registerMenuCommand',
      typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : null),
    addStyle: gmPick('GM_addStyle', typeof GM_addStyle === 'function' ? GM_addStyle : null),
    clipboard: gmPick('GM_setClipboard', typeof GM_setClipboard === 'function' ? GM_setClipboard : null)
  };

  /* ═══════════════════════════════════════════════════════════
   * 0. 常量与节点表
   * ═══════════════════════════════════════════════════════════ */

  var KEY_CFG = 'gha_cfg_v1';
  var KEY_HEALTH = 'gha_health_v1';
  var KEY_COUNTS = 'gha_counts_v1';
  var HEALTH_TTL = 10 * 60 * 1000;      // 成功的健康数据 10 分钟内复用
  var LIMITED_TTL = 2 * 60 * 1000;      // 被限流（429/403）的节点只冷却 2 分钟，尽快给回机会
  var FAIL_TTL = 60 * 1000;             // 失败记录只冷却 1 分钟，网络一恢复就让它复活（v1.1.0）
  var PROBE_CONCURRENCY = 4;            // 测速并发：一口气把整张表打满容易被镜像判成攻击（429）
  var PROBE_TIMEOUT = 5000;             // 单个节点测速上限：公益镜像 5s 还不响应，基本可以判死
  var PROBE_BYTES = 'bytes=0-2047';     // 只取前 2KB 验证内容，别把 2MB 的 Release 整个拉下来

  // v1.1.0：无 GM_xmlhttpRequest 时用 <img> 探测。加载跨域图片不需要 CORS 读权限，
  // 也不需要任何 @grant，因此即便脚本管理器把 GM_xhr 挡掉，也不会「全节点判死 → 只能直连」。
  // 参考 github.akams.cn / greasyfork-zh 的 Image 延迟探测；?t= 防缓存，onerror/超时判死。
  var PROBE_IMG = 'https://raw.githubusercontent.com/microsoft/vscode/main/resources/win32/code.ico';
  var FAILOVER_TRIES = 3;               // 点击时最多并行验证 3 个候选节点
  var FAILOVER_TIMEOUT = 2500;          // 点击故障转移的单节点验证上限（比全表测速更短，别让用户干等）
  var WATCHDOG_MIN = 30 * 1000;         // 「零可用节点」时自动重测的起始间隔
  var WATCHDOG_MAX = 5 * 60 * 1000;     // 退避上限

  // 逃生入口：连不上 github.com 主站时用。HTML 反向代理（不是文件下载镜像，
  // gh-proxy 系对 github.com HTML 只会返回落地页），需国内 IP、不能登录/上传。
  var ESCAPE_HOSTS = [
    { label: 'KGitHub 打开本页', host: 'kkgithub.com' },
    { label: 'bgithub 打开本页', host: 'bgithub.xyz' }
  ];
  // 免访问 GitHub 即可取到的 hosts（GitHub520）。gitcdn.top 带 CORS 头，
  // raw.hellogithub.com 无 CORS 头（只能靠 GM_xhr 取）。两者 IP 来源独立，不可混用。
  var HOSTS_SOURCES = [
    'https://hosts.gitcdn.top/hosts.txt',
    'https://raw.hellogithub.com/hosts'
  ];

  var PROBE_TARGETS = {
    raw: 'https://raw.githubusercontent.com/git/git/master/README.md',
    archive: 'https://github.com/octocat/Hello-World/archive/refs/heads/master.zip',
    release: 'https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-amd64',
    gist: 'https://gist.githubusercontent.com/choco-bot/'
      + 'dc9c0e2cadfc169e36816bfa5e67dab1/raw/9841eb38ef4d8e984916701e6b827cf909a60ca4/Install.txt'
  };

  /**
   * 节点能力集合。只落在下面几种组合上，抽成常量后改动一处即全局生效，
   * 也避免同一条路线在多个节点上抄多遍（抄错一处就是一整类死链）。
   * 注意 avatar 是「加分项」：缺了只影响图片加速，核心下载不受影响。
   * 2026-10 实测：不少镜像这条路线已返回 402/403/404，
   * 所以按实测结果收紧，宁可少标能力，也不给用户派一条死链。
   */
  var CAP = {
    full: { raw: 1, archive: 1, release: 1, gist: 1, avatar: 1 },              // 全路线
    core: { raw: 1, archive: 1, release: 1, gist: 1 },                         // 四条主线
    rawRelease: { raw: 1, release: 1 },                                        // 不做源码包 / gist
    rawArchive: { raw: 1, archive: 1 },                                        // 不做附件直链
    raw: { raw: 1 }                                                            // 只做 raw（jsdelivr）
  };
  Object.keys(CAP).forEach(function (k) { Object.freeze(CAP[k]); });

  /**
   * 节点表（2026-10-31 真实网络实测）。
   * style 决定地址怎么拼：
   *   full       base + '/' + 完整 URL        （绝大多数镜像）
   *   jsdelivr   base + '/gh/owner/repo@ref/path'（只支持 raw，且有大小上限）
   * caps 是该节点实测可用的路线；不支持就不往它身上派活。
   * tier 2 = 兜底通道：jsdelivr 只代理 raw，且国内时通时不通，
   *          哪怕测速最快也排到完整镜像之后，避免「测速通过、真下载被重置」。
   * 数组顺序 = 静态优先级，用于「还没测出结果」时的兜底排序。
   *
   * 已下线/失效（本轮实测全部 429/403 或返回落地页，不再占测速名额）：
   *   ghproxy.cxkpro.top / gh.ddlc.top / gitproxy.mrhjx.cn / gh.h233.eu.org
   */
  var MIRRORS = [
    { id: 'cdn-gh-proxy', label: 'CDN.GH-Proxy', base: 'https://cdn.gh-proxy.org', style: 'full', caps: CAP.full },
    { id: 'hk-gh-proxy', label: 'HK.GH-Proxy', base: 'https://hk.gh-proxy.org', style: 'full', caps: CAP.full },
    { id: 'gh-proxy-org', label: 'GH-Proxy.org', base: 'https://gh-proxy.org', style: 'full', caps: CAP.full },
    { id: 'edgeone-gh-proxy', label: 'EdgeOne', base: 'https://edgeone.gh-proxy.org', style: 'full', caps: CAP.full },
    { id: 'gh-proxy', label: 'GH-Proxy', base: 'https://gh-proxy.com', style: 'full', caps: CAP.full },
    { id: 'idayer', label: 'idayer', base: 'https://gh.idayer.com', style: 'full', caps: CAP.core },
    { id: 'wget-la', label: 'wget.la', base: 'https://wget.la', style: 'full', caps: CAP.core },
    { id: 'ghproxy-net', label: 'GHProxy.net', base: 'https://ghproxy.net', style: 'full', caps: CAP.core },
    { id: 'monlor', label: 'monlor', base: 'https://gh.monlor.com', style: 'full', caps: CAP.core },
    { id: 'yylx', label: 'yylx.win', base: 'https://git.yylx.win', style: 'full', caps: CAP.core },
    { id: 'geekertao', label: 'geekertao', base: 'https://ghfile.geekertao.top', style: 'full', caps: CAP.core },
    { id: 'hwinzniej', label: 'hwinzniej', base: 'https://ghpxy.hwinzniej.top', style: 'full', caps: CAP.raw },
    { id: 'crashmc', label: 'CrashMC', base: 'https://cdn.crashmc.com', style: 'full', caps: CAP.rawRelease },
    { id: 'chjina', label: 'chjina', base: 'https://gh.chjina.com', style: 'full', caps: CAP.rawRelease },
    { id: 'boki', label: 'boki.moe', base: 'https://github.boki.moe', style: 'full', caps: CAP.rawRelease },
    { id: 'keleyaa', label: 'keleyaa', base: 'https://ghp.keleyaa.com', style: 'full', caps: CAP.rawArchive },
    {
      id: 'jsdelivr-gcore', label: 'JSDelivr-G', base: 'https://gcore.jsdelivr.net',
      style: 'jsdelivr', caps: CAP.raw, tier: 2
    },
    {
      id: 'jsdelivr-testingcf', label: 'JSDelivr-CF', base: 'https://testingcf.jsdelivr.net',
      style: 'jsdelivr', caps: CAP.raw, tier: 2
    },
    {
      // v1.1.0：原 fastly.jsdelivr.net 实测 301 跳回被墙的 raw 域名（连
      // 正确 /gh/ 路径也跳），确认死链；换成实测 raw/archive/release/gist
      // 四路线全 206 的 gh.catmak.name。改成 full 风格但只标 CAP.core，
      // 因为未验证 avatar 路线。保持数组长度 19，避免 README 表格与
      // scripts/check.js 的节点计数失配。
      id: 'catmak', label: 'catmak', base: 'https://gh.catmak.name',
      style: 'full', caps: CAP.core
    }
  ];

  var DEFAULT_CFG = {
    enabled: true,      // 总开关
    chips: true,        // Releases / Raw 按钮旁注入「⚡ 加速」
    fileList: true,     // 仓库文件列表每行注入 ☁ 单文件下载
    autoArchive: true,  // 点击源码包(Download ZIP / Source code)自动走镜像
    altClick: true,     // Alt + 点击任意可加速链接走镜像
    images: false,      // 实验性：头像/图片加速
    panel: true,        // 右下角悬浮面板
    mirror: '',         // 手动指定节点 id，空=自动择优
    custom: '',         // 自定义镜像前缀，例如 https://my-proxy.com
    enhance: true,      // Release 增强显示总开关
    enhGroup: true,     // 附件按平台分组、按当前系统/架构排序并置顶推荐
    enhCount: true,     // 显示各附件下载量（GitHub API，10 分钟缓存）
    enhTime: false,     // 相对时间 → 精确时间
    enhNotes: true,     // 更新日志可折叠
    os: '',             // 手动指定系统，空=跟随当前设备
    arch: ''            // 手动指定架构，空=跟随当前设备
  };

  /* ═══════════════════════════════════════════════════════════
   * 1. 存储与配置
   * ═══════════════════════════════════════════════════════════ */

  var memStore = {};

  /** 存档可能是 JSON 字符串（本脚本写入）或已是对象（脚本管理器自动反序列化），损坏时回退默认值 */
  function parseStored(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw !== 'string') return raw;
    try {
      var v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function getStore(key, fallback) {
    try {
      if (GM_API.getValue) return parseStored(GM_API.getValue(key, null), fallback);
    } catch (e) { /* ignore */ }
    if (Object.prototype.hasOwnProperty.call(memStore, key)) return memStore[key];
    // 没有 GM 存储时 setStore 写的是 localStorage，这里必须对称地读回来，
    // 否则刷新一次所有配置就丢了（脚本管理器缺失 / 被沙箱禁用时会走到这条路）。
    try {
      var ls = window.localStorage.getItem(key);
      if (ls !== null) return parseStored(ls, fallback);
    } catch (e) { /* 隐私模式或被禁用 */ }
    return fallback;
  }

  function setStore(key, value) {
    memStore[key] = value;
    try {
      if (GM_API.setValue) GM_API.setValue(key, JSON.stringify(value));
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* ignore */ }
  }

  var cfg = (function () {
    var saved = getStore(KEY_CFG, {}) || {};
    var out = {};
    for (var k in DEFAULT_CFG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) {
        out[k] = Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : DEFAULT_CFG[k];
      }
    }
    return out;
  })();

  function saveCfg() {
    setStore(KEY_CFG, cfg);
  }

  /** 用户自定义节点（tier 0：测速通过就永远优先，能力全开，靠实测淘汰） */
  function customMirror() {
    var base = String(cfg.custom || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+/i.test(base)) return null;
    return {
      id: 'custom',
      label: '自定义',
      base: base,
      style: 'full',
      caps: CAP.full,
      // 面板与 README 都承诺「自定义排在最前面」，但排序是按 tier 再按延迟，
      // 只把它放在数组首位不够（延迟稍差就会被内置节点顶掉），所以给一个更低的 tier。
      tier: 0
    };
  }

  /**
   * 实际参与调度的节点列表：自定义置顶 + 内置。
   * 这是点击 / 装饰的热路径（一次点击会穿过 classify → stripMirror），
   * 所以结果按 custom 前缀缓存，顺便把每个 base 的规范化结果算一次记住。
   */
  var mirrorCache = null;
  var mirrorCacheKey = null;
  var mirrorHosts = null;   // 镜像主机名集合：classify 的 O(1) 闸门

  function mirrorList() {
    var key = String(cfg.custom || '');
    if (mirrorCache && mirrorCacheKey === key) return mirrorCache;
    var c = customMirror();
    var list = c ? [c].concat(MIRRORS) : MIRRORS.slice();
    for (var i = 0; i < list.length; i++) {
      if (list[i].baseNorm === undefined) list[i].baseNorm = String(list[i].base || '').replace(/\/+$/, '');
    }
    // 顺手把主机名去重成集合：classify 每次调用都要判断「这链接是不是镜像地址」，
    // 靠它就能把页面上成千上万个普通链接挡在第一次 new URL 之后，不必逐个跑前缀扫描。
    mirrorHosts = {};
    for (var k = 0; k < list.length; k++) {
      var hu = parseUrl(list[k].baseNorm || list[k].base);
      if (hu) mirrorHosts[hu.hostname] = 1;
    }
    mirrorCache = list;
    mirrorCacheKey = key;
    return list;
  }

  /* ═══════════════════════════════════════════════════════════
   * 2. URL 识别与改写（纯函数）
   * ═══════════════════════════════════════════════════════════ */

  var GITHUB_HOSTS = {
    'github.com': 1,
    'www.github.com': 1,
    'gist.github.com': 1,
    'raw.githubusercontent.com': 1,
    'gist.githubusercontent.com': 1,
    'codeload.github.com': 1,
    'objects.githubusercontent.com': 1,
    'media.githubusercontent.com': 1,     // LFS 大文件
    'avatars.githubusercontent.com': 1,
    'camo.githubusercontent.com': 1,      // README 里的图片走 camo
    'user-images.githubusercontent.com': 1,
    'private-user-images.githubusercontent.com': 1
  };

  function parseUrl(u) {
    try {
      return new URL(u, 'https://github.com/');
    } catch (e) {
      return null;
    }
  }

  /** 剥一层镜像前缀；不是镜像地址时原样返回 */
  function stripMirrorOnce(url) {
    var list = mirrorList();
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var base = m.baseNorm || (m.baseNorm = String(m.base || '').replace(/\/+$/, ''));
      if (m.style === 'jsdelivr') {
        // 必须命中该节点自己的 base：否则任意 https://x/gh/a/b@c 都会被误判成 jsdelivr
        if (url.indexOf(base + '/gh/') !== 0) continue;
        var jd = url.slice(base.length + 4).match(/^([^/]+)\/([^/@]+)@(.+)$/);
        if (jd) return 'https://raw.githubusercontent.com/' + jd[1] + '/' + jd[2] + '/' + jd[3];
        continue;
      }
      if (url.indexOf(base + '/') !== 0) {
        // 查询串式前缀（https://x/?url=、https://x/?q=）没有斜杠分隔，
        // 拼接规则见 joinMirrorUrl 的 glue 处理，这里必须对称地认回来。
        if (!/[?&=]$/.test(base) || url.indexOf(base) !== 0) continue;
        var qrest = url.slice(base.length);
        if (/^https?:\/\//.test(qrest)) return qrest;
        continue;
      }
      var rest = url.slice(base.length + 1);
      if (/^https?:\/\//.test(rest)) return rest;           // full 风格
    }
    return url;
  }

  /**
   * 若 url 已经是镜像地址，剥掉前缀还原成原始 GitHub 地址。
   * 最多剥 3 层：用户可能拿一个已被加速的地址再来加速（例如从别人那里复制的链接），
   * 只剥一层会让「镜像套镜像」一直留在页面上。
   */
  function stripMirror(url) {
    if (typeof url !== 'string') return url;
    // 快路径：正常的 GitHub 地址不可能是镜像前缀，省掉一次全表扫描
    var self = parseUrl(url);
    if (self && GITHUB_HOSTS[self.hostname]) return url;
    var out = url;
    for (var i = 0; i < 3; i++) {
      var next = stripMirrorOnce(out);
      if (next === out) break;
      out = next;
    }
    return out;
  }

  /** 判断资源类型；返回 null 表示不值得/不支持走镜像 */
  function classify(url) {
    if (!url || typeof url !== 'string') return null;
    var u = parseUrl(url);
    if (!u) return null;
    if (!GITHUB_HOSTS[u.hostname]) {
      // 非 GitHub 主机：只有可能是「已经是镜像地址」，才值得走 stripMirror 复原；
      // 其余（页面上占绝大多数的外链）在这里一次比较就出局。
      if (!mirrorHosts) mirrorList();
      if (!mirrorHosts || !mirrorHosts[u.hostname]) return null;
      u = parseUrl(stripMirror(url));
      if (!u || !GITHUB_HOSTS[u.hostname]) return null;
    }

    var p = u.pathname;

    if (u.hostname === 'raw.githubusercontent.com') return 'raw';
    if (u.hostname === 'media.githubusercontent.com') return 'raw';
    if (u.hostname === 'gist.githubusercontent.com') return 'gist';
    if (u.hostname === 'codeload.github.com') return 'archive';
    if (u.hostname === 'objects.githubusercontent.com') return 'release';
    if (u.hostname === 'avatars.githubusercontent.com') return 'avatar';
    if (u.hostname === 'camo.githubusercontent.com') return 'avatar';
    if (u.hostname === 'user-images.githubusercontent.com') return 'avatar';
    if (u.hostname === 'private-user-images.githubusercontent.com') return 'avatar';

    // gist.github.com/user/id/raw（可带文件名/版本号）
    if (u.hostname === 'gist.github.com' && /\/raw(?:\/|$)/.test(p)) return 'gist';

    if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
      // /releases/download/<tag>/<file> 与 /releases/latest/download/<file>
      if (/^\/[^/]+\/[^/]+\/releases\/(?:latest\/)?download\//.test(p)) return 'release';
      if (/^\/[^/]+\/[^/]+\/archive\//.test(p)) return 'archive';
      if (/^\/[^/]+\/[^/]+\/legacy\.(tar\.gz|zip)\//.test(p)) return 'archive';
      if (/^\/[^/]+\/[^/]+\/raw\//.test(p)) return 'raw';
      if (/^\/[^/]+\/[^/]+\/blob\//.test(p)) return 'blob';
    }
    return null;
  }

  /** github /blob/ 页面 → raw 地址；其余原样返回 */
  function toRawUrl(url) {
    var origin = stripMirror(url);
    var u = parseUrl(origin);
    if (!u) return url;
    var m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/);
    if (!m) {
      // gist 的 /user/id/raw 没有后续路径：保持原样，让镜像跟随 GitHub 自己的 302
      return origin;
    }
    // gist 页面上的 /raw/ 链接先落到 gist.githubusercontent.com，少一次 302，兼容性更好
    if (u.hostname === 'gist.github.com') {
      return 'https://gist.githubusercontent.com/' + m[1] + '/' + m[2] + '/raw/' + m[3];
    }
    if (u.hostname === 'raw.githubusercontent.com' || u.hostname === 'gist.githubusercontent.com') return origin;
    // blob 页面上的 ?plain=1 对 raw 没有意义，丢掉它，其余查询参数原样保留
    var search = '';
    try {
      var q = new URLSearchParams(u.search || '');
      q.delete('plain');
      var qs = q.toString();
      search = qs ? '?' + qs : '';
    } catch (e) {
      search = u.search || '';
    }
    return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] + search;
  }

  /** 按节点风格拼接加速地址；该节点不支持这种 URL 时返回 null */
  function joinMirrorUrl(m, url) {
    if (!m || !m.base) return null;
    var base = m.baseNorm || (m.baseNorm = String(m.base).replace(/\/+$/, ''));
    var raw = String(url);
    // 已经是这个节点的地址：直接返回，保证 buildAccel 幂等
    if (raw.indexOf(base + '/') === 0) return raw;
    if (m.style === 'jsdelivr') {
      // /gh/owner/repo@ref/path：ref 起头的部分整体保留，不能再补一个 @
      var mm = raw.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)$/);
      if (!mm) return null;
      return base + '/gh/' + mm[1] + '/' + mm[2] + '@' + mm[3];
    }
    // 以 ?/&/= 结尾的是「查询串式」前缀（如 https://x/?url=），此时不能再补斜杠
    var glue = /[?=&]$/.test(base) ? '' : '/';
    return base + glue + raw;
  }

  /** 裸前缀拼接，供 git clone 命令使用（自定义前缀带查询串时不要走这里） */
  function joinMirror(base, url) {
    return String(base).replace(/\/+$/, '') + '/' + url;
  }

  /* ═══════════════════════════════════════════════════════════
   * 3. 节点健康度与择优
   * ═══════════════════════════════════════════════════════════ */

  var health = getStore(KEY_HEALTH, {}) || {};

  // 早期开发版把健康数据按节点 id 存，v1.0 起改按「id:路线」存。
  // 旧键一次性清掉：不清的话它们永远不会被读写，只是躺在存储里发霉。
  (function pruneLegacyHealth() {
    if (!health || typeof health !== 'object') { health = {}; return; }
    var dirty = false;
    Object.keys(health).forEach(function (k) {
      if (k.indexOf(':') < 0) { delete health[k]; dirty = true; }
    });
    if (dirty) setStore(KEY_HEALTH, health);
  }());

  function nowMs() {
    return (window.performance && performance.now) ? performance.now() : Date.now();
  }

  /** 从 GM 返回头（字符串或对象）里取某个响应头 */
  function headerOf(headers, name) {
    if (!headers) return '';
    if (typeof headers === 'string') {
      var re = new RegExp('^' + name + ':\\s*(.+)$', 'mi');
      var mm = headers.match(re);
      return mm ? mm[1].trim() : '';
    }
    if (typeof headers === 'object') {
      for (var k in headers) {
        if (Object.prototype.hasOwnProperty.call(headers, k) && k.toLowerCase() === name.toLowerCase()) {
          return String(headers[k] || '');
        }
      }
    }
    return '';
  }

  /**
   * 统一的轻量请求，优先 GM_xmlhttpRequest（可跨域）。
   * 与旧版相比有三处关键改动：
   *   1. 带 Range 头只要前 2KB —— 旧版探测 Release 要整包下载 2MB+，整张节点表就是 40MB 量级；
   *   2. 校验 Content-Type 与开头字节 —— 不少「假镜像」对所有路径都回 200 的落地页 HTML，
   *      只看状态码会把它们当成可用节点，点下去就是一页广告；
   *   3. 429 / 403 单独标记为「被限流」，健康数据只冷却 2 分钟，不会 10 分钟都躲着它。
   */
  function probe(url, timeout) {
    timeout = timeout || 6000;
    return new Promise(function (resolve) {
      var t0 = nowMs();
      var settled = false;
      function finish(res) {
        if (settled) return;
        settled = true;
        resolve(res);
      }
      function evaluate(status, headers, text) {
        var ct = headerOf(headers, 'content-type');
        var head = String(text || '').slice(0, 300);
        var limited = status === 429 || status === 403;
        var html = /text\/html/i.test(ct) || /^\s*(<!doctype html|<html)/i.test(head);
        var ok = status >= 200 && status < 400 && !html && String(text || '').length > 0;
        finish({ ok: ok, status: status, ms: Math.round(nowMs() - t0), limited: limited });
      }
      if (GM_API.xhr) {
        try {
          GM_API.xhr({
            method: 'GET',
            url: url,
            timeout: timeout,
            anonymous: true,                 // 不把本机 Cookie 发给第三方镜像
            headers: { Range: PROBE_BYTES },
            onload: function (r) {
              evaluate(r.status, r.responseHeaders, r.responseText);
            },
            onerror: function () { finish({ ok: false, status: 0, ms: Math.round(nowMs() - t0) }); },
            ontimeout: function () { finish({ ok: false, status: 0, ms: timeout }); },
            onabort: function () { finish({ ok: false, status: 0, ms: Math.round(nowMs() - t0) }); }
          });
        } catch (e) {
          finish({ ok: false, status: -1, ms: 0 });
        }
        return;
      }
      // 降级：fetch（要求镜像允许 CORS，通常用于测试环境）
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
      fetch(url, {
        signal: ctrl ? ctrl.signal : undefined,
        mode: 'cors',
        cache: 'no-store',
        headers: { Range: PROBE_BYTES }
      })
        .then(function (r) {
          return r.text().then(function (text) {
            clearTimeout(timer);
            var headers = {};
            try { r.headers.forEach(function (v, k) { headers[k] = v; }); } catch (e) { /* ignore */ }
            evaluate(r.status, headers, text.slice(0, 4096));
          });
        })
        .catch(function () {
          clearTimeout(timer);
          finish({ ok: false, status: 0, ms: Math.round(nowMs() - t0) });
        });
    });
  }

  /**
   * v1.1.0：用 <img> 探测节点可达性，完全绕开 CORS / @grant。
   * 加载一张跨域图片不要求服务器给出 Access-Control-Allow-Origin，也不需要
   * GM_xmlhttpRequest；只要 onload 触发就说明「这个镜像能把 GitHub 资源送到浏览器」。
   * ?t= 防缓存；onerror 或超时判死。参考 github.akams.cn 的延迟探测实现。
   * 局限：只能判断可达，拿不到 Content-Type / 状态码，所以是 GM_xhr 不可用时的
   * 次优探测手段（仍优于「被 CORS 挡掉 → 全部判死」）。
   */
  function probeViaImage(url, timeout) {
    timeout = timeout || PROBE_TIMEOUT;
    return new Promise(function (resolve) {
      var t0 = nowMs();
      var settled = false;
      var img = null;
      function finish(ok) {
        if (settled) return;
        settled = true;
        if (img) { img.onload = img.onerror = null; }
        resolve({ ok: !!ok, status: ok ? 200 : 0, ms: Math.round(nowMs() - t0), limited: false });
      }
      try {
        img = new Image();
        img.onload = function () { finish(true); };
        img.onerror = function () { finish(false); };
        var sep = url.indexOf('?') >= 0 ? '&' : '?';
        img.src = url + sep + 't=' + Date.now();
        setTimeout(function () { finish(false); }, timeout);
      } catch (e) {
        finish(false);
      }
    });
  }

  /**
   * v1.1.0 探测能力闸门：有 GM_xmlhttpRequest 用带 Range + 内容校验的强探测；
   * 没有则退回 Image 探测（免 CORS）。无论哪种，都保证「能测」，
   * 不会因为没有 GM_xhr 而把整张节点表判死、导致所有加速链接消失。
   */
  function probeNode(m, route, timeout) {
    if (GM_API.xhr) return probe(joinMirrorUrl(m, route.url), timeout || PROBE_TIMEOUT);
    var imgUrl = joinMirrorUrl(m, PROBE_IMG);
    if (!imgUrl) return Promise.resolve({ ok: false, status: 0, ms: 0, limited: false });
    return probeViaImage(imgUrl, timeout || PROBE_TIMEOUT);
  }

  /**
   * v1.1.0：取一段纯文本（hosts 内容）。GM_xhr 优先（可跨域，无需 CORS），
   * 否则 fetch（要求对端有 ACAO 头）。用于「复制 GitHub hosts」逃生入口。
   */
  function fetchText(url, timeout) {
    timeout = timeout || 6000;
    if (GM_API.xhr) {
      return new Promise(function (resolve) {
        var done = false;
        function finish(text) { if (!done) { done = true; resolve(text || ''); } }
        try {
          GM_API.xhr({
            method: 'GET', url: url, timeout: timeout, anonymous: true,
            onload: function (r) {
              var text = String(r.responseText || '');
              finish(r.status >= 200 && r.status < 400 ? text : '');
            },
            onerror: function () { finish(''); },
            ontimeout: function () { finish(''); },
            onabort: function () { finish(''); }
          });
        } catch (e) { finish(''); }
      });
    }
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) {
        clearTimeout(timer);
        if (!(r.status >= 200 && r.status < 400)) return '';
        return r.text();
      })
      .catch(function () { clearTimeout(timer); return ''; });
  }

  /**
   * 记录的有效期。v1.1.0 把「失败」和「成功」分开：
   *   成功  → HEALTH_TTL（10 分钟复用，没必要反复打公益镜像）
   *   限流  → LIMITED_TTL（2 分钟，给回机会）
   *   失败  → FAIL_TTL（1 分钟）。旧版失败也记 10 分钟，一旦某轮全网抖动，
   *   整整 10 分钟里所有加速链接都消失，只能直连 —— 这正是「有时连不上」的
   *   放大环节。缩短到 1 分钟后，网络恢复即自动回到未知梯队重新参与择优。
   */
  function freshTtl(h) {
    if (!h) return HEALTH_TTL;
    if (h.limited) return LIMITED_TTL;
    if (h.ok === false) return FAIL_TTL;
    return HEALTH_TTL;
  }

  function isFresh(h) {
    return !!(h && typeof h.ts === 'number' && (Date.now() - h.ts) < freshTtl(h));
  }

  /** 节点对某条路线的支持情况 */
  function supports(m, cap) {
    if (!m || !m.caps) return false;
    return !!m.caps[cap || 'raw'];
  }

  /**
   * 健康度按「节点 + 路线」存。
   * 同一个域名 raw 通、release 挂是常态，只按 id 记会出现两种错：
   * 一条死路线拖累整个节点（明明 raw 好用），或者反过来把用户派到一条死链上。
   */
  function hKey(m, cap) {
    return m.id + ':' + (cap || 'raw');
  }

  function hOf(m, cap) {
    return (m && health[hKey(m, cap)]) || null;
  }

  /** 该节点在任意路线上新鲜的成功记录（取最快的一条），没有则 null */
  function freshOkOf(m) {
    if (!m || !m.caps) return null;
    var best = null;
    for (var cap in m.caps) {
      var h = health[hKey(m, cap)];
      if (!h || h.ok !== true || !isFresh(h)) continue;
      if (!best || h.ms < best.ms) best = h;
    }
    return best;
  }

  /** 面板展示用：优先已验证成功且最快的那条，其次退回最近一条（含失败）记录 */
  function healthOf(m) {
    var ok = freshOkOf(m);
    if (ok) return ok;
    if (!m || !m.caps) return null;
    var fallback = null;
    for (var cap in m.caps) {
      var h = health[hKey(m, cap)];
      if (!h || !isFresh(h)) continue;
      if (!fallback || (h.ts || 0) > (fallback.ts || 0)) fallback = h;
    }
    return fallback;
  }

  /** 测速目标：优先用该节点真正支持的最快路线，避免把只做下载的节点误判成挂掉 */
  function probeRouteFor(m) {
    if (supports(m, 'raw')) return { cap: 'raw', url: PROBE_TARGETS.raw };
    if (supports(m, 'archive')) return { cap: 'archive', url: PROBE_TARGETS.archive };
    if (supports(m, 'release')) return { cap: 'release', url: PROBE_TARGETS.release };
    if (supports(m, 'gist')) return { cap: 'gist', url: PROBE_TARGETS.gist };
    return null;
  }

  /**
   * 候选节点排序，三档：
   *   1. 该路线实测通过 —— 按 tier、再按延迟升序；
   *   2. 该路线没数据、但节点在别的路线验证活着 —— 不是死站，只是这条没实测；
   *   3. 从没测过 / 结果已过期 —— 按静态顺序兜底。
   * 明确挂掉的直接排除。
   *
   * v1.1.0 新增「永不断链兜底」：若三档都为空（例如整轮探测恰好赶上全网
   * 抖动、或所有失败记录仍是新鲜的），不再返回空让 buildAccel 回退直连，
   * 而是退回静态优先级里第一个「没有新鲜限流记录」的节点。宁可给一条
   * 未经验证的镜像链接，也不要让按钮变成直连 —— 这正是用户反馈的
   * 「有时连不上 GitHub」在脚本侧最致命的表现。
   */
  function pickCandidates(cap, limit) {
    var need = cap || 'raw';
    if (need === 'blob') need = 'raw';
    var list = mirrorList();

    // 用户手动固定：尊重选择，不再因测速失败否决
    if (cfg.mirror) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === cfg.mirror && supports(list[i], need)) return [list[i]];
      }
    }

    var good = [], mid = [], unknown = [];
    for (var j = 0; j < list.length; j++) {
      var m = list[j];
      if (!supports(m, need)) continue;
      var st = hOf(m, need);
      if (st && st.ok === true && isFresh(st)) { good.push({ m: m, ms: st.ms }); continue; }
      // 失败结果同样受 TTL 约束：只在「刚测出来是死的」这段时间里排除，
      // 过期后重新回到未知梯队再给一次机会。否则节点一旦失败就永久出局，
      // 只能等用户手动「重新测速」，等于静默失效。
      if (st && st.ok === false && isFresh(st)) continue;
      var alt = freshOkOf(m);
      if (alt) mid.push({ m: m, ms: alt.ms });
      else unknown.push(m);                       // 从没测过 / 结果已过期 → 第三梯队
    }
    // 注意别写成 (tier || 1)：自定义节点的 tier 是 0，会被 || 当成 1 而失去优先级
    function tierOf(m) { return m.tier == null ? 1 : m.tier; }
    function byTierThenMs(a, b) { return (tierOf(a.m) - tierOf(b.m)) || (a.ms - b.ms); }
    // 先按 tier 再按延迟：tier 2（jsdelivr）只在没有完整镜像可用时才顶上
    good.sort(byTierThenMs);
    mid.sort(byTierThenMs);
    var out = good.concat(mid).map(function (x) { return x.m; }).concat(unknown);
    if (!out.length) {
      // 兜底：只排除「新鲜限流」的节点（被限流的确实不该再派活），其余按静态顺序给。
      for (var f = 0; f < list.length; f++) {
        var fm = list[f];
        if (!supports(fm, need)) continue;
        var fs = hOf(fm, need);
        if (fs && fs.limited && isFresh(fs)) continue;
        out.push(fm);
      }
    }
    return out.slice(0, limit || 1);
  }

  /** 选出当前最佳节点 */
  function pickMirrorFor(cap) {
    return pickCandidates(cap, 1)[0] || null;
  }

  function isVerified(m, cap) {
    var st = hOf(m, cap);
    return !!(st && st.ok === true && isFresh(st));
  }

  /** 生成加速地址；不可加速或没有可用节点时返回 null（调用方回退直连） */
  function buildAccel(url, cap) {
    return buildAccelWith(url, cap, null);
  }

  function buildAccelWith(url, cap, mirror) {
    var kind = classify(url);
    if (!kind) return null;
    var origin = stripMirror(url);
    var need = cap || (kind === 'blob' ? 'raw' : kind);
    if (kind === 'blob') origin = toRawUrl(origin);
    else if (kind === 'gist' && /^https?:\/\/gist\.github\.com\//.test(origin)) origin = toRawUrl(origin);
    var m = mirror || pickMirrorFor(need);
    if (!m || !supports(m, need)) return null;
    return joinMirrorUrl(m, origin);
  }

  /**
   * 并发测速全部节点。
   * 用固定大小的并发池而不是 Promise.all 一次性打满：20 个请求同时出去，
   * 不少公益镜像会直接回 429，把「健康」误判成「挂了」。
   * onProgress(done, total) 可用来驱动面板上的「测速中 3/19」（分母是当前节点表长度）。
   *
   * 同一时刻只允许一轮测速：启动时的后台测速还没结束时用户又点「重新测速」，
   * 两轮结果会互相覆盖（慢轮次后完成，反而把刚测出的好节点写成超时）。
   */
  var probeInFlight = null;

  function probeAll(onProgress) {
    if (probeInFlight) return probeInFlight;
    var t0 = Date.now();
    var list = mirrorList();
    var cursor = 0;
    var finished = 0;

    probeInFlight = new Promise(function (resolve) {
      if (!list.length) { resolve(); return; }

      function tick() {
        if (onProgress) { try { onProgress(finished, list.length); } catch (e) { /* ignore */ } }
        if (finished === list.length) {
          setStore(KEY_HEALTH, health);
          resolve();
          return;
        }
        launch();
      }

      function launch() {
        if (cursor >= list.length) return;
        var m = list[cursor++];
        var route = probeRouteFor(m);
        if (!route) {
          // 一条路线都不支持（配置写错时才会出现）：按不可用记到它声称的所有路线上
          for (var c0 in m.caps) record(m, c0, { ok: false, ms: 0, status: 0, limited: false, ts: t0 });
          finished++;
          tick();
          return;
        }
        // v1.1.0：改用探测能力闸门（有 GM_xhr 走强探测 / 无则走免 CORS 的 Image 探测）。
        probeNode(m, route, PROBE_TIMEOUT).then(function (r) {
          record(m, route.cap, {
            ok: r.ok,
            ms: r.ms,
            status: r.status,
            limited: !!r.limited,
            ts: t0
          });
          // v1.1.0：删掉了「单路线失败扩散到该节点所有 caps」的逻辑。
          // 2026-11 实测同一节点 raw 挂、archive/release 却 206 可用是常态，
          // 旧逻辑会把整站误杀 10 分钟（配合旧的 10 分钟失败 TTL 更是雪上加霜）。
          // 现在每条路线独立记账，失败只冷却 1 分钟，由看门狗自动重测复活。
          finished++;
          tick();
        }, function () {
          // 探测实现本身抛错（自定义脚本管理器实现不合规等）时也要记账并推进，
          // 否则 finished 永远追不上 list.length，probeInFlight 卡死、看门狗再也动不了。
          record(m, route.cap, { ok: false, ms: 0, status: 0, limited: false, ts: t0 });
          finished++;
          tick();
        });
      }

      // 初始并发 + 轻微错峰，避免同一毫秒打出 4 个请求
      var initial = Math.min(PROBE_CONCURRENCY, list.length);
      for (var k = 0; k < initial; k++) {
        (function (n) { setTimeout(launch, n * 120); }(k));
      }
    }).then(function () {
      probeInFlight = null;
    }, function (err) {
      probeInFlight = null;
      throw err;
    });

    return probeInFlight;
  }

  /** 当前是否存在「任一节点、任一路线」新鲜成功记录 */
  function hasAnyVerified() {
    var list = mirrorList();
    for (var i = 0; i < list.length; i++) {
      if (freshOkOf(list[i])) return true;
    }
    return false;
  }

  /**
   * v1.1.0 自动复活看门狗。
   * 旧版只在 boot（有 stale）或用户手动点「重新测速」时重探；一旦某轮全网
   * 抖动把节点全判死，之后网络恢复了也不会自己回来，只能一直直连。
   * 这里带退避地周期性检查：只要「一个已验证节点都没有」，就自动重测；
   * 恢复后回到 30s 间隔，持续失败则翻倍到 5 分钟封顶，避免疯狂打公益镜像。
   * 由 boot() 启动一次，页面生命周期内常驻。
   */
  var watchdogDelay = WATCHDOG_MIN;
  var watchdogTimer = null;

  function scheduleWatchdog(delay) {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(watchdogTick, delay);
  }

  function watchdogTick() {
    watchdogTimer = null;
    try {
      if (accelReady() && !probeInFlight && !hasAnyVerified()) {
        probeAll().then(function () {
          try {
            renderPanel();
            resetDecorations();
            decorateAll();
          } catch (e) { /* ignore */ }
          // 这轮仍没探活 → 退避；探活了 → 回到最短间隔
          watchdogDelay = hasAnyVerified()
            ? WATCHDOG_MIN
            : Math.min(WATCHDOG_MAX, watchdogDelay * 2);
        });
      } else {
        watchdogDelay = WATCHDOG_MIN;
      }
    } catch (e) { /* ignore */ }
    scheduleWatchdog(watchdogDelay);
  }

  function startWatchdog() {
    scheduleWatchdog(WATCHDOG_MIN);
  }

  /* ═══════════════════════════════════════════════════════════
   * 4. 样式
   * ═══════════════════════════════════════════════════════════ */

  var CSS = [
    '.gha-chip{display:inline-flex;align-items:center;gap:2px;margin-left:6px;padding:1px 7px;',
    'border-radius:999px;border:1px solid var(--borderColor-default,#d0d7de);',
    'background:var(--bgColor-muted,#f6f8fa);color:var(--fgColor-accent,#0969da);',
    'font-size:11px;font-weight:600;line-height:18px;text-decoration:none!important;',
    'vertical-align:middle;white-space:nowrap;transition:all .12s ease;}',
    '.gha-chip:hover{background:var(--bgColor-accent-muted,#ddf4ff);border-color:var(--fgColor-accent,#0969da);}',
    '.gha-dl{display:inline-flex;align-items:center;margin-left:6px;font-size:12px;line-height:1;',
    'color:var(--fgColor-accent,#0969da);text-decoration:none!important;vertical-align:middle;',
    'opacity:0;transition:opacity .12s ease;flex:none;}',
    '[role="row"]:hover .gha-dl,.Box-row:hover .gha-dl,tr:hover .gha-dl,.gha-dl:focus{opacity:1;}',
    '#gha-fab{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:40px;height:40px;',
    'box-sizing:border-box;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;',
    'background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);',
    'border:1px solid var(--borderColor-default,#d0d7de);box-shadow:0 6px 18px rgba(0,0,0,.16);',
    'font-size:18px;user-select:none;transition:transform .15s ease;}',
    '#gha-fab:hover{transform:scale(1.08);}',
    '#gha-fab.gha-off{opacity:.45;filter:grayscale(1);}',
    '#gha-panel{position:fixed;right:16px;bottom:64px;z-index:2147483000;width:280px;box-sizing:border-box;',
    'max-height:calc(100vh - 96px);display:flex;flex-direction:column;',
    'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    'background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);',
    'border:1px solid var(--borderColor-default,#d0d7de);border-radius:12px;',
    'box-shadow:0 12px 32px rgba(0,0,0,.18);overflow:hidden;}',
    '#gha-panel[hidden]{display:none;}',
    '.gha-hd{display:flex;align-items:center;gap:6px;padding:9px 12px;font-weight:600;',
    'border-bottom:1px solid var(--borderColor-default,#d0d7de);background:var(--bgColor-muted,#f6f8fa);}',
    '.gha-hd .gha-x{margin-left:auto;cursor:pointer;opacity:.6;font-weight:400;}',
    '.gha-hd .gha-x:hover{opacity:1;}',
    '.gha-bd{padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:0;overflow-y:auto;}',
    '.gha-row{display:flex;align-items:center;gap:6px;}',
    '.gha-row .gha-grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#gha-actions{flex-wrap:wrap;gap:6px;}',
    '.gha-dot{width:8px;height:8px;border-radius:50%;background:#8c959f;flex:none;}',
    '.gha-dot.ok{background:#1a7f37;}.gha-dot.dead{background:#cf222e;}.gha-dot.wait{background:#bf8700;}',
    '.gha-btn{flex:1 1 auto;padding:5px 8px;border-radius:7px;cursor:pointer;text-align:center;',
    'border:1px solid var(--borderColor-default,#d0d7de);background:var(--bgColor-muted,#f6f8fa);',
    'color:var(--fgColor-default,#1f2328);font-size:11.5px;font-weight:600;white-space:nowrap;}',
    '.gha-btn:hover{background:var(--bgColor-accent-muted,#ddf4ff);border-color:var(--fgColor-accent,#0969da);}',
    '.gha-list{max-height:160px;overflow-y:auto;overflow-x:hidden;scrollbar-width:thin;',
    'border-top:1px dashed var(--borderColor-default,#d0d7de);padding-top:6px;}',
    '.gha-list::-webkit-scrollbar{width:8px;}',
    '.gha-list::-webkit-scrollbar-thumb{background:var(--borderColor-default,#d0d7de);border-radius:4px;}',
    '.gha-item{display:flex;align-items:center;gap:6px;padding:2px 2px 2px 0;font-size:11.5px;}',
    '.gha-item>span{flex:none;}',
    '.gha-item .gha-grow{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.gha-item b{font-weight:600;}',
    '.gha-item .gha-use{cursor:pointer;color:var(--fgColor-accent,#0969da);font-size:11px;}',
    '.gha-item.gha-on .gha-use{color:var(--fgColor-muted,#59636e);cursor:default;}',
    '.gha-toggles{display:grid;grid-template-columns:1fr 1fr;gap:6px 8px;',
    'border-top:1px dashed var(--borderColor-default,#d0d7de);padding-top:8px;}',
    '.gha-toggles label{display:flex;align-items:center;gap:5px;cursor:pointer;font-size:11.5px;white-space:nowrap;}',
    '.gha-toggles .gha-wide{grid-column:1/-1;font-weight:600;}',
    '.gha-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483001;',
    'background:#1f2328;color:#fff;padding:8px 16px;border-radius:8px;font-size:12.5px;',
    'box-shadow:0 8px 24px rgba(0,0,0,.28);opacity:0;transition:opacity .18s ease;pointer-events:none;}',
    '.gha-toast.show{opacity:1;}',
    /* ---- raw 页面工具条 ---- */
    '.gha-rawbar{position:fixed;top:12px;right:12px;z-index:2147483000;display:flex;align-items:center;gap:6px;',
    'padding:7px 9px;border-radius:10px;box-sizing:border-box;',
    'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    'background:var(--bgColor-default,#fff);color:var(--fgColor-default,#1f2328);',
    'border:1px solid var(--borderColor-default,#d0d7de);box-shadow:0 6px 20px rgba(0,0,0,.18);}',
    '.gha-rawbar .gha-rb-title{font-weight:600;opacity:.75;white-space:nowrap;}',
    '.gha-rawbar a,.gha-rawbar button{display:inline-flex;align-items:center;gap:3px;padding:3px 8px;',
    'border-radius:7px;border:1px solid var(--borderColor-default,#d0d7de);',
    'background:var(--bgColor-muted,#f6f8fa);color:var(--fgColor-accent,#0969da);',
    'font-family:inherit;font-size:11.5px;font-weight:600;line-height:1.5;',
    'text-decoration:none!important;cursor:pointer;white-space:nowrap;}',
    '.gha-rawbar a:hover,.gha-rawbar button:hover{background:var(--bgColor-accent-muted,#ddf4ff);',
    'border-color:var(--fgColor-accent,#0969da);}',
    '.gha-rawbar .gha-rb-x{cursor:pointer;opacity:.5;padding:0 2px;font-weight:400;}',
    '.gha-rawbar .gha-rb-x:hover{opacity:1;}',
    '@media (max-width:520px){.gha-rawbar .gha-rb-title{display:none;}}',
    /* ---- Release 增强显示 ---- */
    '.gha-tag{display:inline-block;margin-left:6px;padding:0 5px;line-height:16px;font-size:10px;',
    'border:1px solid currentColor;border-radius:999px;opacity:.9;vertical-align:middle;white-space:nowrap;}',
    '.gha-rec{display:inline-block;margin-left:6px;padding:0 6px;line-height:16px;font-size:10px;',
    'border-radius:999px;background:#1a7f37;color:#fff;font-weight:600;vertical-align:middle;white-space:nowrap;}',
    /* 左侧色条用 inset 阴影而不是 border：不改变行高与宽度，避免 GitHub 表格错位 */
    '.gha-g-windows{box-shadow:inset 3px 0 0 #1f6feb!important;}.gha-g-windows .gha-tag{color:#1f6feb;}',
    '.gha-g-mac{box-shadow:inset 3px 0 0 #8957e5!important;}.gha-g-mac .gha-tag{color:#8957e5;}',
    '.gha-g-deb{box-shadow:inset 3px 0 0 #db6d28!important;}.gha-g-deb .gha-tag{color:#db6d28;}',
    '.gha-g-rpm{box-shadow:inset 3px 0 0 #f85149!important;}.gha-g-rpm .gha-tag{color:#f85149;}',
    '.gha-g-appimage{box-shadow:inset 3px 0 0 #1a7f37!important;}.gha-g-appimage .gha-tag{color:#1a7f37;}',
    '.gha-g-flatpak{box-shadow:inset 3px 0 0 #0abda0!important;}.gha-g-flatpak .gha-tag{color:#0abda0;}',
    '.gha-g-arch{box-shadow:inset 3px 0 0 #bf4b8a!important;}.gha-g-arch .gha-tag{color:#bf4b8a;}',
    '.gha-g-linux{box-shadow:inset 3px 0 0 #bf8700!important;}.gha-g-linux .gha-tag{color:#bf8700;}',
    '.gha-g-android,.gha-g-ios{box-shadow:inset 3px 0 0 #d4a72c!important;}',
    '.gha-g-android .gha-tag,.gha-g-ios .gha-tag{color:#d4a72c;}',
    '.gha-aux-group{margin:0!important;border-top:1px dashed var(--borderColor-default,#d0d7de);}',
    '.gha-aux-group>summary{cursor:pointer;padding:6px 12px;font-size:11.5px;opacity:.75;}',
    '.gha-aux-group>li{box-shadow:none!important;}',
    '.gha-count{margin-left:6px;font-size:11px;opacity:.65;white-space:nowrap;font-variant-numeric:tabular-nums;}',
    /* 精确时间：替换掉 <relative-time> 的那段文本，保持原位置与原字号 */
    '.gha-time{white-space:nowrap;font-variant-numeric:tabular-nums;}',
    '.gha-notes-toggle{display:inline-flex;align-items:center;gap:5px;margin:0 0 6px;padding:0;',
    'border:none;background:none;cursor:pointer;font-size:13px;font-weight:600;',
    'color:var(--fgColor-default,#1f2328);opacity:.72;font-family:inherit;}',
    '.gha-notes-toggle:hover{opacity:1;}',
    '.gha-notes-chev{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;',
    'border-top:6px solid currentColor;transition:transform .12s ease;transform-origin:50% 40%;}',
    '.gha-notes-toggle.is-collapsed .gha-notes-chev{transform:rotate(-90deg);}',
    '.gha-notes-hidden{display:none!important;}',
    '.gha-sel select{flex:1;min-width:0;padding:4px 6px;font-size:11.5px;border-radius:7px;',
    'border:1px solid var(--borderColor-default,#d0d7de);background:var(--bgColor-muted,#f6f8fa);color:inherit;}',
    '@media (max-width:700px){.gha-dl{display:none;}}'
  ].join('');

  var styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    try {
      if (GM_API.addStyle) { GM_API.addStyle(CSS); return; }
    } catch (e) { /* ignore */ }
    var s = document.createElement('style');
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  var toastTimer = null;
  function toast(msg) {
    injectStyle();
    var box = document.getElementById('gha-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'gha-toast';
      box.className = 'gha-toast';
      (document.body || document.documentElement).appendChild(box);
    }
    box.textContent = msg;
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('show'); }, 2200);
  }

  function copyText(text) {
    try {
      if (GM_API.clipboard) { GM_API.clipboard(text); toast('已复制到剪贴板'); return; }
    } catch (e) { /* ignore */ }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制到剪贴板'); },
        function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch (e) { toast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }

  /* ═══════════════════════════════════════════════════════════
   * 5. 页面上下文识别
   * ═══════════════════════════════════════════════════════════ */

  function pageContext() {
    var u = parseUrl(location.href);
    if (!u) return {};
    var m = u.pathname.match(/^\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m || u.hostname !== 'github.com') {
      if (u.hostname === 'raw.githubusercontent.com' || u.hostname === 'gist.githubusercontent.com') {
        var r = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(.+)$/);
        return { type: 'raw', owner: r && r[1], repo: r && r[2] };
      }
      return {};
    }
    var sub = m[3] || '/';
    var ctx = { owner: m[1], repo: m[2], type: 'repo' };
    if (/^\/blob\//.test(sub)) { ctx.type = 'blob'; ctx.filePath = sub.replace(/^\/blob\/[^/]+\//, ''); }
    else if (/^\/raw\//.test(sub)) ctx.type = 'raw';
    return ctx;
  }

  /** URL 里的 release tag（没有就返回 null） */
  function tagOfPath() {
    var m = location.pathname.match(/\/releases\/tag\/([^/?#]+)/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  /**
   * 私有仓库的 Release / raw 都要登录态，公开镜像拿不到（只会 404），
   * 而且也不该把私有链接交给第三方。检测到私有就整体跳过加速，只留面板说明。
   * secret gist 同理：它的 URL 本身就是访问凭据，交给镜像等于把内容转给镜像方。
   *
   * 这个函数会被 MutationObserver 每批变更调到（GitHub 的 DOM 变更非常频繁），
   * 所以按 href 缓存结果：同一页面内的可见性不会变，换页时 href 变了自然失效。
   */
  var privCacheHref = null;
  var privCacheVal = false;

  function isPrivateRepo() {
    if (privCacheHref === location.href) return privCacheVal;
    var out = false;
    try {
      var meta = document.querySelector('meta[name="octolytics-dimension-repository_public"]');
      if (meta) out = String(meta.getAttribute('content') || '').toLowerCase() === 'false';
      else {
        var vis = document.querySelector('[data-testid="repository-visibility"]');
        if (vis && /^(private|internal|私有|内部)$/i.test((vis.textContent || '').trim())) out = true;
      }
      // secret gist：GitHub 没有长期稳定的公开标记，只能尽力识别（官方 meta 优先，其次页面徽标）。
      // 识别不到就退回原行为，宁可漏判也不误伤公开 gist。
      if (!out && location.hostname === 'gist.github.com') {
        var gmeta = document.querySelector('meta[name="octolytics-dimension-gist_secret"]');
        if (gmeta) out = String(gmeta.getAttribute('content') || '').toLowerCase() === 'true';
        if (!out) {
          var badge = document.querySelector('.gist-secret-label, [data-testid="gist-visibility"]');
          if (badge && /^(secret|私有)$/i.test((badge.textContent || '').trim())) out = true;
        }
      }
    } catch (e) { /* ignore */ }
    privCacheHref = location.href;
    privCacheVal = out;
    return out;
  }

  /** 所有装饰 / 拦截动作的统一闸门 */
  function accelReady() {
    return !!cfg.enabled && !isPrivateRepo();
  }

  /* ═══════════════════════════════════════════════════════════
   * 6. 页面注入
   * ═══════════════════════════════════════════════════════════ */

  function makeChip(acc, label, title) {
    var chip = document.createElement('a');
    chip.className = 'gha-chip';
    chip.setAttribute('data-gha-chip', '1');
    chip.href = acc;
    chip.target = '_blank';
    chip.rel = 'noopener noreferrer';
    chip.textContent = label;
    chip.title = title;
    return chip;
  }

  /**
   * 为一个链接算出加速按钮。每个链接只放 1 个，
   * 避免真实 Releases 页一次长出 30+ 个按钮；测速落地后会自动换成最快节点。
   */
  function chipFor(url, cap) {
    var kind = classify(url);
    if (!kind) return null;
    var need = cap || (kind === 'blob' ? 'raw' : kind);
    var m = pickMirrorFor(need);
    if (!m || !supports(m, need)) return null;
    var acc = buildAccelWith(url, need, m);
    return acc ? { m: m, url: acc, verified: isVerified(m, need) } : null;
  }

  /** 按钮悬浮说明；测速还没落地时明确告诉用户「稍后会换」 */
  function chipTitle(it, action) {
    return '通过 ' + it.m.label + action
      + (it.verified ? '' : '（测速中，完成后自动切到最快节点）')
      + '\n' + it.url;
  }

  /** 在 anchor 后面插入一个加速按钮 */
  function insertChip(anchor, item, title) {
    var chip = makeChip(item.url, '⚡ 加速', title);
    if (anchor.parentNode) anchor.parentNode.insertBefore(chip, anchor.nextSibling);
  }

  /** Releases 附件旁的加速按钮 */
  function decorateChips() {
    if (!accelReady() || !cfg.chips) return;
    var links = document.querySelectorAll('a[href*="/releases/download/"]:not([data-gha]):not([data-gha-chip]),'
      + 'a[href*="/releases/latest/download/"]:not([data-gha]):not([data-gha-chip])');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.getAttribute('data-gha-chip') === '1') continue;
      a.setAttribute('data-gha', '1');
      var item = chipFor(a.href, 'release');
      if (item) insertChip(a, item, chipTitle(item, ''));
    }
  }

  /**
   * 源码包（Code → Download ZIP / TAR.GZ，Release 里的 Source code）旁的加速按钮。
   * 以前只在点击时静默接管，用户看不到入口；现在补一个显式按钮，和 Releases 附件一致。
   */
  function decorateArchive() {
    if (!accelReady() || !cfg.chips) return;
    var links = document.querySelectorAll('a[href*="/archive/"]:not([data-gha]):not([data-gha-chip])');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (!/^https:\/\/(www\.)?github\.com\/[^/]+\/[^/]+\/archive\//.test(a.href)) continue;
      a.setAttribute('data-gha', '1');
      var item = chipFor(a.href, 'archive');
      if (item) insertChip(a, item, chipTitle(item, ' 下载源码包'));
    }
  }

  /**
   * blob 页面的 Raw / Download raw file 按钮。
   * GitHub 改过几轮 DOM：老版是 #raw-url，新版是 data-testid="raw-button"，
   * 还出现过 data-testid="download-raw-button"，这里一并兼容。
   */
  function decorateRawButtons() {
    if (!accelReady() || !cfg.chips) return;
    var btns = document.querySelectorAll([
      'a[data-testid="raw-button"]:not([data-gha])',
      'a[data-testid="download-raw-button"]:not([data-gha])',
      'a#raw-url:not([data-gha])',
      'a[href*="/raw/"][data-testid]:not([data-gha])'
    ].join(','));
    if (!btns.length) return;
    var item = chipFor(toRawUrl(location.href), 'raw');   // 同页面的 Raw 按钮都指向同一个文件
    if (!item) return;
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('data-gha', '1');
      insertChip(btns[i], item, chipTitle(item, ' 下载原始文件'));
    }
  }

  /**
   * 仓库文件列表：每行一个 ☁ 单文件直下（悬停显示）。
   * GitHub 同一行里会有两个指向同一文件的 <a>（图标一个、文件名一个），
   * 所以按「行」处理并只挑文字最长的那个（也就是文件名链接），避免一行两个 ☁。
   */
  function decorateFileList() {
    if (!accelReady() || !cfg.fileList) return;
    var rows = document.querySelectorAll(
      '[role="row"]:not([data-gha-row]), .Box-row:not([data-gha-row]), tr:not([data-gha-row])'
    );
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var links = row.querySelectorAll('a[href*="/blob/"]');
      var best = null;
      for (var j = 0; j < links.length; j++) {
        // href 已由浏览器补全成绝对地址；直接正则比每次 new URL 便宜得多（文件列表动辄上千行）
        if (!/^https:\/\/(www\.)?github\.com\/[^/]+\/[^/]+\/blob\//.test(links[j].href)) continue;
        if (!best || (links[j].textContent || '').trim().length > (best.textContent || '').trim().length) {
          best = links[j];
        }
      }
      if (!best) continue;
      row.setAttribute('data-gha-row', '1');
      // 去掉 ?plain=1 / #L12 这类页内参数，它们对 raw 地址没有意义，还可能弄脏下载链接
      var acc = buildAccel(toRawUrl(best.href.split('#')[0].split('?')[0]), 'raw');
      if (!acc) continue;
      var name = (best.textContent || 'file').trim();
      // 跨域时 download 属性会被浏览器忽略，实际行为是新标签页打开，文案按真实行为写
      var dl = makeChip(acc, '☁', '通过镜像下载 ' + name + '（新标签页打开）\n' + acc);
      dl.className = 'gha-dl';
      dl.setAttribute('download', name);
      dl.setAttribute('data-gha-chip', '1');
      if (best.parentNode) best.parentNode.insertBefore(dl, best.nextSibling);
    }
  }

  /** Gist 页面：Raw 链接旁加加速按钮 */
  function decorateGist() {
    if (!accelReady() || !cfg.chips) return;
    var links = document.querySelectorAll('a[href*="/raw/"]:not([data-gha])');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var href = a.getAttribute('href') || '';
      // 真实页面里可能给相对地址，先补全再判断
      var abs = /^https?:/i.test(href) ? href : (location.origin + href);
      if (classify(abs) !== 'gist') continue;
      a.setAttribute('data-gha', '1');
      var item = chipFor(abs, 'gist');
      if (item) insertChip(a, item, chipTitle(item, ''));
    }
  }

  function decorateImages() {
    if (!accelReady() || !cfg.images) return;
    if (!pickMirrorFor('avatar')) return;
    var imgs = document.querySelectorAll('img[src*="githubusercontent.com"]');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.getAttribute('data-gha-img') === '1') continue;
      var src = img.getAttribute('src');
      if (!src || classify(src) !== 'avatar') continue;
      var acc = buildAccel(src, 'avatar');
      if (!acc) continue;
      img.setAttribute('data-gha-img', '1');
      img.setAttribute('data-gha-origin', src);
      // 处理函数挂在元素上：重新测速换节点时可以精确摘掉，不会越挂越多
      img.__ghaErr = function () {
        var origin = this.getAttribute('data-gha-origin');
        if (origin && this.src !== origin) this.src = origin;
      };
      img.addEventListener('error', img.__ghaErr);
      img.src = acc;
    }
  }

  /* ---- raw / gist 原文页：顶部一键镜像下载工具条 ---- */
  var rawBarEl = null;
  var rawPadPrev = null;
  var rawPadAdjusted = false;

  function rawPageKind() {
    var h = location.hostname;
    if (h !== 'raw.githubusercontent.com' && h !== 'gist.githubusercontent.com') return null;
    var kind = classify(location.href);
    return (kind === 'raw' || kind === 'gist') ? kind : null;
  }

  /** raw 原文页没有内边距，工具条会压住第一行代码；给它让出 52px，关闭时还原 */
  function ensureRawPad() {
    if (rawPadAdjusted) return;
    try {
      var cur = parseFloat(getComputedStyle(document.documentElement).paddingTop) || 0;
      if (cur >= 52) return;
      rawPadPrev = document.documentElement.style.paddingTop;
      document.documentElement.style.paddingTop = '52px';
      rawPadAdjusted = true;
    } catch (e) { /* ignore */ }
  }

  function restoreRawPad() {
    if (!rawPadAdjusted) return;
    try { document.documentElement.style.paddingTop = rawPadPrev || ''; } catch (e) { /* ignore */ }
    rawPadAdjusted = false;
  }

  function removeRawBar() {
    if (rawBarEl && rawBarEl.parentNode) rawBarEl.parentNode.removeChild(rawBarEl);
    rawBarEl = null;
    restoreRawPad();
  }

  function decorateRawPage() {
    if (!accelReady() || !cfg.chips) { removeRawBar(); return; }
    var kind = rawPageKind();
    if (!kind) return;
    var acc = buildAccel(location.href, kind);
    if (!acc) { removeRawBar(); return; }
    if (rawBarEl && rawBarEl.getAttribute('data-url') === acc) return;
    removeRawBar();

    var bar = document.createElement('div');
    bar.id = 'gha-rawbar';
    bar.className = 'gha-rawbar';
    bar.setAttribute('data-url', acc);
    bar.setAttribute('data-gha-chip', '1');

    var title = document.createElement('span');
    title.className = 'gha-rb-title';
    title.textContent = '⚡ GitHub Turbo';

    var dl = document.createElement('a');
    dl.href = acc;
    dl.target = '_blank';
    dl.rel = 'noopener noreferrer';
    dl.textContent = '镜像下载';

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制链接';
    copy.addEventListener('click', function () { copyText(acc); });

    var close = document.createElement('span');
    close.className = 'gha-rb-x';
    close.textContent = '✕';
    close.title = '关闭工具条';
    close.addEventListener('click', removeRawBar);

    var m = pickMirrorFor(kind);
    dl.title = '通过 ' + (m ? m.label : '镜像') + ' 下载\n' + acc;

    bar.appendChild(title);
    bar.appendChild(dl);
    bar.appendChild(copy);
    bar.appendChild(close);
    ensureRawPad();
    (document.body || document.documentElement).appendChild(bar);
    rawBarEl = bar;
  }

  function decorateAll() {
    decorateChips();
    decorateArchive();
    decorateRawButtons();
    decorateFileList();
    decorateGist();
    decorateImages();
    decorateRawPage();
    decorateEnhance();
  }

  /**
   * 测速结果落地后要重排按钮：先摘掉旧节点，再按最新结果重新注入。
   * 不清掉旧节点的话，首屏渲染的那批（可能还是兜底节点）会一直留着。
   * 关闭开关时也复用这里把已注入的入口摘干净。
   */
  function resetDecorations() {
    removeRawBar();
    var chips = document.querySelectorAll('[data-gha-chip]');
    for (var i = 0; i < chips.length; i++) {
      if (chips[i].parentNode) chips[i].parentNode.removeChild(chips[i]);
    }
    var marked = document.querySelectorAll('[data-gha],[data-gha-row],[data-gha-img]');
    for (var j = 0; j < marked.length; j++) {
      var el = marked[j];
      el.removeAttribute('data-gha');
      el.removeAttribute('data-gha-row');
      if (el.getAttribute('data-gha-img') !== '1') continue;
      // 图片：还原原始地址，摘下 error 兜底，允许下次按新节点重新加速
      var origin = el.getAttribute('data-gha-origin');
      if (origin && el.getAttribute('src') !== origin) el.setAttribute('src', origin);
      el.removeAttribute('data-gha-img');
      el.removeAttribute('data-gha-origin');
      if (el.__ghaErr) { el.removeEventListener('error', el.__ghaErr); el.__ghaErr = null; }
    }
  }

  /* ═══════════════════════════════════════════════════════════
   * 6-b. Release 增强显示
   *   平台分组排序 / 下载量 / 精确时间 / 日志折叠，四项独立开关。
   *   全部是幂等装饰：重复执行不增殖节点，排序靠签名比对收口，
   *   否则我们自己重排 <li> 会触发 MutationObserver，形成死循环。
   * ═══════════════════════════════════════════════════════════ */

  var OS_OPTIONS = [
    { value: '', label: '跟随设备' },
    { value: 'windows', label: 'Windows' },
    { value: 'mac', label: 'macOS' },
    { value: 'linux', label: 'Linux' },
    { value: 'android', label: 'Android' },
    { value: 'ios', label: 'iOS' }
  ];

  var ARCH_OPTIONS = [
    { value: '', label: '跟随设备' },
    { value: 'x86_64', label: 'x64' },
    { value: 'arm64', label: 'arm64' },
    { value: 'x86', label: 'x86' },
    { value: 'arm32', label: 'arm32' }
  ];

  var GROUP_LABEL = {
    windows: 'Win', mac: 'Mac', deb: 'Deb', rpm: 'RPM', appimage: 'AppImage',
    flatpak: 'Flatpak', arch: 'Arch', linux: 'Linux', android: 'Android', ios: 'iOS'
  };

  // 非当前系统时的组间基准分（当前系统组一律 10000 起）
  var GROUP_BASE = {
    windows: 9000, mac: 8000, deb: 7000, rpm: 6000, appimage: 5200, flatpak: 5000,
    arch: 4500, linux: 4000, android: 3500, ios: 3000, other: 2000, meta: -1000, source: -2000
  };

  // Linux 专属的包格式分组：os=linux 时它们也算「当前系统」。
  // 少了这一条，.deb 的基准分（7000）低于通用 tarball（10000），
  // 「推荐」徽章会标到 tarball 上，与「优先原生包管理器格式」的意图相反。
  var LINUX_GROUPS = { deb: 1, rpm: 1, appimage: 1, flatpak: 1, arch: 1 };

  // 非所选架构时的兜底偏好分（所选架构 +500，通用包 +60）
  var ARCH_SCORE = { universal: 60, x86_64: 50, arm64: 20, x86: 10, arm32: 5 };

  var Arch = {
    currentOS: function () {
      // Chromium 的 UA-CH 比 UA 字符串更可靠（UA 被冻结/精简后仍能拿到平台）
      var uad = navigator.userAgentData;
      var plat = uad && uad.platform ? String(uad.platform).toLowerCase() : '';
      if (plat) {
        if (plat.indexOf('windows') >= 0) return 'windows';
        if (plat.indexOf('android') >= 0) return 'android';
        if (plat.indexOf('ios') >= 0) return 'ios';
        if (plat.indexOf('mac') >= 0) return 'mac';
        if (plat.indexOf('linux') >= 0) return 'linux';
      }
      var ua = String(navigator.userAgent || '').toLowerCase();
      // 顺序有讲究：Android 的 UA 里带 linux，iOS 的带 "like mac os x"
      if (ua.indexOf('android') >= 0) return 'android';
      if (ua.indexOf('iphone') >= 0 || ua.indexOf('ipad') >= 0) return 'ios';
      if (ua.indexOf('windows') >= 0) return 'windows';
      if (ua.indexOf('mac os') >= 0 || ua.indexOf('macintosh') >= 0) return 'mac';
      if (ua.indexOf('linux') >= 0) return 'linux';
      return 'windows';
    },

    currentArch: function () {
      var ua = String(navigator.userAgent || '').toLowerCase();
      var pf = String(navigator.platform || '').toLowerCase();
      if (ua.indexOf('aarch64') >= 0 || ua.indexOf('arm64') >= 0 || pf.indexOf('arm64') >= 0) return 'arm64';
      if (ua.indexOf('win64') >= 0 || ua.indexOf('x86_64') >= 0 || ua.indexOf('wow64') >= 0
        || pf.indexOf('win64') >= 0 || pf.indexOf('x86_64') >= 0) return 'x86_64';
      if (ua.indexOf('armv7') >= 0 || ua.indexOf('armhf') >= 0) return 'arm32';
      if (ua.indexOf('i686') >= 0 || ua.indexOf('i386') >= 0) return 'x86';
      return this.currentOS() === 'mac' ? 'arm64' : 'x86_64';
    },

    /**
     * 从文件名解析架构。判定顺序关键：先 64 位后 32 位，
     * 否则 arm64 会被 arm 规则先吃掉、x86_64 会被 x86 吃掉。
     */
    parseArch: function (name) {
      var n = String(name).toLowerCase();
      if (n.indexOf('aarch64') >= 0 || n.indexOf('arm64') >= 0 || n.indexOf('armv8') >= 0) return 'arm64';
      if (n.indexOf('x86_64') >= 0 || n.indexOf('x64') >= 0 || n.indexOf('amd64') >= 0
        || n.indexOf('win64') >= 0 || n.indexOf('x86-64') >= 0) return 'x86_64';
      if (n.indexOf('riscv') >= 0 || n.indexOf('mips') >= 0 || n.indexOf('ppc') >= 0
        || n.indexOf('s390') >= 0 || n.indexOf('loongarch') >= 0) return 'other';
      if (n.indexOf('armv7') >= 0 || n.indexOf('armhf') >= 0 || n.indexOf('armv6') >= 0
        || n.indexOf('armeabi') >= 0 || /(^|[-_.])arm([-_.]|$)/.test(n) || n.indexOf('arm32') >= 0) return 'arm32';
      if (n.indexOf('i386') >= 0 || n.indexOf('i686') >= 0 || n.indexOf('ia32') >= 0
        || n.indexOf('win32') >= 0 || n.indexOf('x86-32') >= 0
        || /(^|[-_.])x86([-_.]|$)/.test(n) || n.indexOf('32-bit') >= 0 || n.indexOf('32bit') >= 0) return 'x86';
      if (n.indexOf('universal') >= 0 || n.indexOf('universal2') >= 0) return 'universal';
      return null;
    },

    /** 文件名 → 平台分组 id */
    groupOf: function (name) {
      var n = String(name).toLowerCase();
      if (/\.(sig|asc|sha1|sha256|sha512|md5|pem|blockmap|sbom)$/.test(n)) return 'meta';
      if (/\.(sha\d+sum|md5sum|checksums?|sums)$/.test(n)) return 'meta';
      if (n.indexOf('source') >= 0 || /(^|[-_.])src\.(tar\.gz|tgz|zip)$/.test(n)) return 'source';
      if (/\.(exe|msi)$/.test(n) || n.indexOf('windows') >= 0
        || /(^|[-_.])win(dows)?([-_.]|$)/.test(n) || /(^|[-_.])win(32|64)([-_.]|$)/.test(n)) return 'windows';
      if (/\.(dmg|pkg)$/.test(n) || n.indexOf('macos') >= 0 || n.indexOf('darwin') >= 0
        || n.indexOf('osx') >= 0 || n.indexOf('os x') >= 0) return 'mac';
      if (/\.(apk|aab)$/.test(n) || n.indexOf('android') >= 0) return 'android';
      if (/\.ipa$/.test(n) || /(^|[-_.])ios([-_.]|$)/.test(n)) return 'ios';
      if (/\.deb$/.test(n)) return 'deb';
      if (/\.rpm$/.test(n)) return 'rpm';
      if (/\.appimage$/.test(n)) return 'appimage';
      if (/\.flatpak$/.test(n)) return 'flatpak';
      if (/\.pacman$/.test(n) || /\.pkg\.tar\.(zst|xz)$/.test(n)) return 'arch';
      if (n.indexOf('linux') >= 0 || /\.tar\.xz$/.test(n)) return 'linux';
      return 'other';
    },

    score: function (name, os, arch, group) {
      var n = String(name).toLowerCase();
      var score;
      var isCurrent = group === os || (os === 'linux' && LINUX_GROUPS[group] === 1);
      if (isCurrent) {
        score = 10000;
        // 同为当前系统时，优先原生包管理器格式（安装体验最好）
        if (group === 'deb') score += 300;
        else if (group === 'rpm') score += 200;
        else if (group === 'appimage' || group === 'flatpak') score += 100;
      } else {
        score = GROUP_BASE[group] != null ? GROUP_BASE[group] : 0;
      }
      var fa = this.parseArch(name);
      score += (fa === arch) ? 500 : (ARCH_SCORE[fa] || 0);
      if (/\.(exe|dmg|appimage|flatpak|apk)$/.test(n)) score += 10;   // 一步到位的安装包
      if (/\.(zip|7z)$/.test(n)) score += 5;
      return score;
    }
  };

  var RELEASE_PATH = /^\/[^/]+\/[^/]+\/releases/;

  function isReleasePage() { return RELEASE_PATH.test(location.pathname); }

  /** 附件名：优先 URL 末段（API 里也是这个），取不到再退回可见文字 */
  function fileNameOf(link) {
    var href = link.getAttribute('href') || link.href || '';
    var seg = href.split('?')[0].split('#')[0].split('/').pop();
    try { seg = decodeURIComponent(seg); } catch (e) { /* 保持原样 */ }
    if (seg) return seg;
    var t = link.querySelector('.Truncate-text');
    return (t ? t.textContent : link.textContent || '').trim();
  }

  /** 当前 release 块的 tag：优先 URL，其次块内的 tag 链接 */
  function tagOf(details) {
    var direct = tagOfPath();
    if (direct) return direct;
    var box = details.closest('section, .Box, div[data-testid="release-card"], .release-entry');
    var a = box && box.querySelector('a[href*="/releases/tag/"]');
    if (!a) return null;
    var mm = (a.getAttribute('href') || '').match(/\/releases\/tag\/([^/?#]+)/);
    if (!mm) return null;
    try { return decodeURIComponent(mm[1]); } catch (e) { return mm[1]; }
  }

  /** 单个 release 块的附件重排（幂等：签名相同直接跳过） */
  function sortAssets(details, os, arch) {
    // GitHub 的附件行是 <li class="Box-row">，但老版/实验版结构用过纯 .Box-row 容器，
    // 这里两种都认，并按「最内层的行」去重，避免同一行被数两次。
    var candidates = details.querySelectorAll('li, .Box-row, [role="row"]');
    if (!candidates.length) return;

    var items = [];
    for (var i = 0; i < candidates.length; i++) {
      var row = candidates[i];
      if (row.closest('li, .Box-row, [role="row"]') !== row) continue;   // 只要最内层
      var link = row.querySelector('a[href*="/releases/download/"], a[href*="/archive/"]');
      if (!link) continue;
      var name = fileNameOf(link);
      var href = link.getAttribute('href') || '';
      var group = /\/archive\//.test(href) ? 'source' : Arch.groupOf(name);
      items.push({
        row: row,
        link: link,
        name: name,
        group: group,
        score: Arch.score(name, os, arch, group)
      });
    }
    if (items.length < 2) return;

    // 容器记忆：全都被折叠进 wrapper 后，直接用 parentNode 会把 wrapper 认成列表。
    // 若记忆失效且首个候选行恰好已经在 wrapper 里（整页只有校验文件时会这样），
    // 必须再往上取一层，否则后面的行会被塞进一个马上要被删掉的 wrapper，整组附件消失。
    var parent = details.__ghaList;
    if (!parent || !details.contains(parent) || parent.classList.contains('gha-aux-group')) parent = null;
    if (!parent) {
      // 取「装的行数最多」的父节点当列表容器。附件区和源码包区可能在不同容器里，
      // 用 items[0].row.parentNode 会随 DOM 顺序漂移，把附件搬进源码包那块容器。
      var owners = [], counts = [];
      items.forEach(function (it) {
        var p = it.row.parentNode;
        if (!p) return;
        var idx = owners.indexOf(p);
        if (idx < 0) { owners.push(p); counts.push(0); idx = owners.length - 1; }
        counts[idx]++;
      });
      var maxIdx = -1;
      for (var t = 0; t < counts.length; t++) {
        if (maxIdx < 0 || counts[t] > counts[maxIdx]) maxIdx = t;
      }
      parent = maxIdx >= 0 ? owners[maxIdx] : null;
      // 全都已经被折叠进 wrapper 时，真正的列表在 wrapper 的上一层
      if (parent && parent.classList && parent.classList.contains('gha-aux-group')) parent = parent.parentNode;
    }
    if (!parent) return;
    details.__ghaList = parent;

    var sig = os + '|' + arch + '|' + items.length;
    if (details.getAttribute('data-gha-sig') === sig) return;
    details.setAttribute('data-gha-sig', sig);

    // 先摘下所有行，再清上一轮容器，最后按新顺序放回
    items.forEach(function (it) { if (it.row.parentNode) it.row.parentNode.removeChild(it.row); });
    var olds = details.querySelectorAll('.gha-aux-group');
    for (var k = 0; k < olds.length; k++) {
      if (olds[k].parentNode) olds[k].parentNode.removeChild(olds[k]);
    }

    items.sort(function (a, b) { return b.score - a.score; });

    var normal = [];
    var meta = [];
    items.forEach(function (it) { (it.group === 'meta' ? meta : normal).push(it); });

    normal.forEach(function (it) {
      parent.appendChild(it.row);
      paintAsset(it);
    });
    markRecommend(details, normal[0]);
    if (meta.length) {
      var wrap = document.createElement('details');
      wrap.className = 'gha-aux-group';
      var sum = document.createElement('summary');
      sum.textContent = '签名 / 校验文件（' + meta.length + '）';
      wrap.appendChild(sum);
      meta.forEach(function (it) {
        wrap.appendChild(it.row);
        paintAsset(it);
      });
      parent.appendChild(wrap);
    }
  }

  /** 给一行加左侧色条与平台标签 */
  function paintAsset(it) {
    var row = it.row;
    var cls = String(row.className || '').replace(/\bgha-g-\S+/g, '').trim();
    row.className = (cls + ' gha-g-' + it.group).trim();

    var old = row.querySelector('[data-gha-tag]');
    if (old) old.parentNode.removeChild(old);
    var label = GROUP_LABEL[it.group];
    if (!label) return;
    var tag = document.createElement('span');
    tag.className = 'gha-tag';
    tag.setAttribute('data-gha-tag', '1');
    tag.textContent = label;
    if (it.link.parentNode) it.link.parentNode.insertBefore(tag, it.link.nextSibling);
    else row.appendChild(tag);
  }

  /** 给排序后的第一行加「推荐」徽章：用户不用自己在一堆文件名里找当前平台的包 */
  function markRecommend(details, it) {
    var olds = details.querySelectorAll('[data-gha-rec]');
    for (var i = 0; i < olds.length; i++) {
      if (olds[i].parentNode) olds[i].parentNode.removeChild(olds[i]);
    }
    if (!it || !it.link || !it.link.parentNode) return;
    if (it.group === 'source' || it.group === 'meta') return;
    var badge = document.createElement('span');
    badge.className = 'gha-rec';
    badge.setAttribute('data-gha-rec', '1');
    badge.textContent = '推荐';
    badge.title = '按当前系统 / 架构推荐：' + it.name;
    it.link.parentNode.insertBefore(badge, it.link.nextSibling);
  }

  /** 增强显示主入口：分组排序 */
  function decorateAssets() {
    if (!cfg.enhance || !cfg.enhGroup || !isReleasePage()) return;
    var os = cfg.os || Arch.currentOS();
    var arch = cfg.arch || Arch.currentArch();
    var boxes = document.querySelectorAll('details');
    for (var i = 0; i < boxes.length; i++) {
      var summary = boxes[i].querySelector('summary');
      if (!summary || !/assets/i.test(summary.textContent || '')) continue;
      sortAssets(boxes[i], os, arch);
    }
  }

  /* ---- 下载量：GitHub API，按 repo@tag 缓存 10 分钟并持久化（换页/刷新不用重新请求） ---- */
  var countCache = getStore(KEY_COUNTS, {}) || {};  // "owner/repo@tag" → { ts, assets }
  var countAsked = {};                              // 本次页面会话内已发起的请求
  var COUNT_TTL = 10 * 60 * 1000;
  var COUNT_KEEP = 6 * 60 * 60 * 1000;
  var COUNT_MAX = 80;

  function countKey(tag) {
    var ctx = pageContext();
    return (ctx.owner || '') + '/' + (ctx.repo || '') + '@' + tag;
  }

  function saveCounts() {
    var now = Date.now();
    var keys = Object.keys(countCache).filter(function (k) {
      var v = countCache[k];
      return v && typeof v.ts === 'number' && now - v.ts <= COUNT_KEEP;
    });
    if (keys.length > COUNT_MAX) {
      keys.sort(function (a, b) { return countCache[a].ts - countCache[b].ts; });
      keys.slice(0, keys.length - COUNT_MAX).forEach(function (k) { delete countCache[k]; });
      keys = keys.slice(keys.length - COUNT_MAX);
    }
    var pruned = {};
    keys.forEach(function (k) { pruned[k] = countCache[k]; });
    countCache = pruned;
    setStore(KEY_COUNTS, countCache);
  }

  function fetchCounts(tag) {
    return new Promise(function (resolve, reject) {
      if (!GM_API.xhr) { reject(new Error('无跨域能力')); return; }
      var ctx = pageContext();
      if (!ctx.owner || !ctx.repo) { reject(new Error('无仓库上下文')); return; }
      var url = 'https://api.github.com/repos/' + ctx.owner + '/' + ctx.repo
        + '/releases/tags/' + encodeURIComponent(tag);
      GM_API.xhr({
        method: 'GET',
        url: url,
        timeout: 10000,
        headers: { Accept: 'application/vnd.github+json' },
        onload: function (r) {
          if (r.status !== 200) { reject(new Error('HTTP ' + r.status)); return; }
          try {
            var data = JSON.parse(r.responseText || '{}');
            resolve(data.assets || []);
          } catch (e) { reject(e); }
        },
        onerror: function () { reject(new Error('网络错误')); },
        ontimeout: function () { reject(new Error('超时')); }
      });
    });
  }

  function formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function injectCounts(details, assets) {
    if (!assets || !assets.length) return;
    var map = {};
    assets.forEach(function (a) { if (a && a.name) map[a.name] = a; });
    var rows = details.querySelectorAll('li, .Box-row, [role="row"]');
    for (var i = 0; i < rows.length; i++) {
      var link = rows[i].querySelector('a[href*="/releases/download/"], a[href*="/archive/"]');
      if (!link) continue;
      var asset = map[fileNameOf(link)];
      if (!asset || typeof asset.download_count !== 'number') continue;
      var old = rows[i].querySelector('[data-gha-count]');
      if (old) {
        // 已有缓存先画、新数据回来后就地更新，不重复插入
        old.title = asset.download_count.toLocaleString('zh-CN') + ' 次下载';
        old.textContent = '↓' + formatCount(asset.download_count);
        continue;
      }
      var span = document.createElement('span');
      span.className = 'gha-count';
      span.setAttribute('data-gha-count', '1');
      span.title = asset.download_count.toLocaleString('zh-CN') + ' 次下载';
      span.textContent = '↓' + formatCount(asset.download_count);
      if (link.parentNode) link.parentNode.insertBefore(span, link.nextSibling);
    }
  }

  function decorateCounts() {
    if (!cfg.enhance || !cfg.enhCount || !isReleasePage()) return;
    var boxes = document.querySelectorAll('details');
    var budget = 3;
    for (var i = 0; i < boxes.length && budget > 0; i++) {
      var summary = boxes[i].querySelector('summary');
      if (!summary || !/assets/i.test(summary.textContent || '')) continue;
      var tag = tagOf(boxes[i]);
      if (!tag) continue;
      var key = countKey(tag);
      var cached = countCache[key];
      if (cached && Date.now() - cached.ts < COUNT_TTL) { injectCounts(boxes[i], cached.assets); continue; }
      if (cached) injectCounts(boxes[i], cached.assets);   // 过期也先显示旧值，再后台刷新
      if (countAsked[key]) continue;
      countAsked[key] = 1;
      budget--;
      // 闭包固定住当前的 details / tag / key，否则循环变量会被后续迭代覆盖
      (function (details, tagName, cacheKey) {
        fetchCounts(tagName).then(function (assets) {
          var slim = (assets || []).filter(function (a) { return a && a.name; })
            .map(function (a) { return { name: a.name, download_count: a.download_count }; });
          countCache[cacheKey] = { ts: Date.now(), assets: slim };
          saveCounts();
          injectCounts(details, slim);
        }, function () {
          delete countAsked[cacheKey];   // 失败放行，下次页面变化可重试
        });
      }(boxes[i], tag, key));
    }
  }

  /* ---- 相对时间 → 精确时间 ---- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * 相对时间 → 精确时间。
   * <relative-time> 是带 shadow DOM 的自定义元素，文本渲染在 shadow 里，
   * 直接改它的 textContent 宿主节点上看不到变化。所以改成
   * 「原元素隐藏 + 后面补一个自己的 span」，关闭时删掉 span、还原 display。
   */
  function decorateTimes() {
    if (!cfg.enhance || !cfg.enhTime) return;
    var els = document.querySelectorAll('relative-time:not([data-gha-time])');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var iso = el.getAttribute('datetime');
      if (!iso) continue;
      var d = new Date(iso);
      if (isNaN(d.getTime())) continue;
      if (!el.parentNode) continue;
      var span = document.createElement('span');
      span.className = 'gha-time';
      span.setAttribute('data-gha-time-text', '1');
      span.title = iso;
      span.textContent = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      el.setAttribute('data-gha-time', '1');
      el.setAttribute('data-gha-disp', el.style.display || '');
      el.style.display = 'none';
      el.parentNode.insertBefore(span, el.nextSibling);
    }
  }

  /* ---- 更新日志折叠（默认展开，只折叠 release 正文，不动 README） ---- */
  function decorateNotes() {
    if (!cfg.enhance || !cfg.enhNotes || !isReleasePage()) return;
    var bodies = document.querySelectorAll('.markdown-body:not([data-gha-notes])');
    for (var i = 0; i < bodies.length; i++) {
      var body = bodies[i];
      var box = body.closest('section, .Box, div[data-testid="release-card"], .release-entry');
      // 必须能在一个 release 卡片里找到 tag 链接，否则可能是仓库首页的 README
      if (!box || !box.querySelector('a[href*="/releases/tag/"]')) continue;
      body.setAttribute('data-gha-notes', '1');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gha-notes-toggle';
      btn.innerHTML = '<span class="gha-notes-chev"></span>更新日志';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        var target = ev.currentTarget.__ghaTarget;
        if (!target) return;
        var hidden = target.classList.toggle('gha-notes-hidden');
        ev.currentTarget.classList.toggle('is-collapsed', hidden);
      });
      btn.__ghaTarget = body;
      body.parentNode.insertBefore(btn, body);
    }
  }

  /** 关闭增强显示时把注入物摘干净、时间还原、排序签名作废 */
  function resetEnhance() {
    var kill = document.querySelectorAll('[data-gha-tag],[data-gha-count],[data-gha-rec],.gha-notes-toggle');
    for (var i = 0; i < kill.length; i++) {
      if (kill[i].parentNode) kill[i].parentNode.removeChild(kill[i]);
    }
    var bodies = document.querySelectorAll('[data-gha-notes]');
    for (var j = 0; j < bodies.length; j++) {
      bodies[j].removeAttribute('data-gha-notes');
      bodies[j].classList.remove('gha-notes-hidden');
    }
    var times = document.querySelectorAll('[data-gha-time]');
    for (var k = 0; k < times.length; k++) {
      var timeEl = times[k];
      var nxt = timeEl.nextSibling;
      if (nxt && nxt.nodeType === 1 && nxt.getAttribute('data-gha-time-text') === '1') {
        nxt.parentNode.removeChild(nxt);
      }
      timeEl.style.display = timeEl.getAttribute('data-gha-disp') || '';
      timeEl.removeAttribute('data-gha-time');
      timeEl.removeAttribute('data-gha-disp');
      timeEl.removeAttribute('data-gha-orig');   // 兼容旧版写过的标记
    }
    var leftovers = document.querySelectorAll('[data-gha-time-text]');
    for (var t = 0; t < leftovers.length; t++) {
      if (leftovers[t].parentNode) leftovers[t].parentNode.removeChild(leftovers[t]);
    }
    var groups = document.querySelectorAll('.gha-aux-group');
    for (var g = 0; g < groups.length; g++) {
      var parent = groups[g].parentNode;
      while (groups[g].firstChild) parent.appendChild(groups[g].firstChild);
      parent.removeChild(groups[g]);
    }
    var boxes = document.querySelectorAll('[data-gha-sig]');
    for (var b = 0; b < boxes.length; b++) boxes[b].removeAttribute('data-gha-sig');
    var rows = document.querySelectorAll('.gha-g-windows,.gha-g-mac,.gha-g-deb,.gha-g-rpm,.gha-g-appimage,'
      + '.gha-g-flatpak,.gha-g-arch,.gha-g-linux,.gha-g-android,.gha-g-ios,.gha-g-meta,'
      + '.gha-g-source,.gha-g-other');
    for (var r = 0; r < rows.length; r++) {
      rows[r].className = String(rows[r].className || '').replace(/\bgha-g-\S+/g, '').trim();
    }
  }

  /** 增强显示统一入口（decorateAll / 面板开关都走这里） */
  function decorateEnhance() {
    if (!cfg.enhance) return;
    decorateAssets();
    decorateCounts();
    decorateTimes();
    decorateNotes();
  }

  /* ═══════════════════════════════════════════════════════════
   * 7. 悬浮面板
   * ═══════════════════════════════════════════════════════════ */

  var panelEl = null;
  var fabEl = null;

  function buildPanel() {
    if (panelEl) return panelEl;
    injectStyle();
    var p = document.createElement('div');
    p.id = 'gha-panel';
    p.innerHTML = [
      '<div class="gha-hd"><span>⚡</span><span>GitHub 高速通道</span>',
      '<span class="gha-x" title="收起">—</span></div>',
      '<div class="gha-bd">',
      '  <div class="gha-row"><span class="gha-dot wait" id="gha-dot"></span>',
      '    <span class="gha-grow" id="gha-cur">正在测速…</span>',
      '    <span id="gha-ms" style="opacity:.65"></span></div>',
      '  <div class="gha-row">',
      '    <button class="gha-btn" id="gha-retest">重新测速</button>',
      '    <button class="gha-btn" id="gha-auto">自动选择</button>',
      '  </div>',
      '  <div class="gha-row" id="gha-actions"></div>',
      '  <div class="gha-list" id="gha-list"></div>',
      '  <div class="gha-toggles">',
      '    <label class="gha-wide"><input type="checkbox" id="gha-t-on"> 启用加速</label>',
      '    <label><input type="checkbox" id="gha-t-chip"> 附件按钮</label>',
      '    <label><input type="checkbox" id="gha-t-dl"> 文件☁下载</label>',
      '    <label><input type="checkbox" id="gha-t-zip"> 源码包加速</label>',
      '    <label><input type="checkbox" id="gha-t-alt"> Alt 点击</label>',
      '    <label><input type="checkbox" id="gha-t-img"> 图片加速</label>',
      '  </div>',
      '  <div class="gha-toggles">',
      '    <label class="gha-wide"><input type="checkbox" id="gha-t-enh"> 增强显示（Releases）</label>',
      '    <label><input type="checkbox" id="gha-t-group"> 平台排序</label>',
      '    <label><input type="checkbox" id="gha-t-cnt"> 下载量</label>',
      '    <label><input type="checkbox" id="gha-t-time"> 精确时间</label>',
      '    <label><input type="checkbox" id="gha-t-notes"> 日志折叠</label>',
      '  </div>',
      '  <div class="gha-row gha-sel">',
      '    <select id="gha-os" title="按哪个系统排序附件"></select>',
      '    <select id="gha-arch" title="按哪个架构排序附件"></select>',
      '  </div>',
      '</div>'
    ].join('');
    document.body.appendChild(p);
    panelEl = p;

    p.querySelector('.gha-x').addEventListener('click', function () { togglePanel(false); });
    p.querySelector('#gha-retest').addEventListener('click', function (ev) {
      var btn = ev.target;
      btn.disabled = true;
      btn.textContent = '测速中 0/' + mirrorList().length;
      probeAll(function (done, total) {
        btn.textContent = '测速中 ' + done + '/' + total;
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '重新测速';
        resetDecorations();
        decorateAll();
        renderPanel();
        toast('测速完成');
      });
    });
    p.querySelector('#gha-auto').addEventListener('click', function () {
      cfg.mirror = '';
      saveCfg();
      reapplyMirror();          // 只改配置不动 DOM 的话，页面上已注入的按钮还是旧节点
      toast('已切换为自动选择最快节点');
    });

    var onBox = p.querySelector('#gha-t-on');
    onBox.checked = !!cfg.enabled;
    onBox.addEventListener('change', function () { applyEnabled(onBox.checked); });

    bindToggle(p, '#gha-t-chip', 'chips');
    bindToggle(p, '#gha-t-dl', 'fileList');
    bindToggle(p, '#gha-t-zip', 'autoArchive');
    bindToggle(p, '#gha-t-alt', 'altClick');
    bindToggle(p, '#gha-t-img', 'images');

    bindToggle(p, '#gha-t-enh', 'enhance');
    bindToggle(p, '#gha-t-group', 'enhGroup');
    bindToggle(p, '#gha-t-cnt', 'enhCount');
    bindToggle(p, '#gha-t-time', 'enhTime');
    bindToggle(p, '#gha-t-notes', 'enhNotes');
    bindSelect(p.querySelector('#gha-os'), OS_OPTIONS, 'os');
    bindSelect(p.querySelector('#gha-arch'), ARCH_OPTIONS, 'arch');

    return p;
  }

  /** 系统 / 架构下拉：切换后已渲染的 release 块全部重排 */
  function bindSelect(sel, options, key) {
    if (!sel) return;
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = cfg[key] || '';
    sel.addEventListener('change', function () {
      cfg[key] = sel.value;
      saveCfg();
      resetEnhance();                 // 清掉标签/下载量并把排序签名作废
      if (cfg.enabled) decorateAll();
    });
  }

  /** 总开关：即时生效，不必刷新页面 */
  function applyEnabled(on) {
    cfg.enabled = !!on;
    saveCfg();
    if (fabEl) fabEl.classList.toggle('gha-off', !cfg.enabled);
    if (cfg.enabled) decorateAll();
    else { resetDecorations(); resetEnhance(); }   // 关掉后不留可点的加速入口，避免「以为生效了」
    if (panelEl) {
      var box = panelEl.querySelector('#gha-t-on');
      if (box) box.checked = cfg.enabled;
    }
    toast(!cfg.enabled ? '加速已关闭（所有按钮暂停拦截）'
      : (isPrivateRepo() ? '私有仓库：已跳过镜像加速' : '加速已开启'));
  }

  function bindToggle(root, sel, key) {
    var box = root.querySelector(sel);
    if (!box) return;
    box.checked = !!cfg[key];
    box.addEventListener('change', function () {
      cfg[key] = box.checked;
      saveCfg();
      if (key === 'chips' || key === 'fileList' || key === 'images') {
        resetDecorations();                 // 关掉的分支要把已注入的按钮摘掉
        if (cfg.enabled) decorateAll();
      } else if (key.indexOf('enh') === 0) {
        resetEnhance();                     // 增强显示：先摘干净再按新开关重画
        if (cfg.enabled) decorateAll();
      }
    });
  }

  function renderPanel() {
    if (!panelEl) return;
    // 记住「最佳节点是用哪条路线选出来的」，否则面板显示的延迟会取错记录
    var bestCap = 'raw';
    var best = pickMirrorFor('raw');
    if (!best) { bestCap = 'archive'; best = pickMirrorFor('archive'); }
    if (!best) { bestCap = 'release'; best = pickMirrorFor('release'); }
    var dot = panelEl.querySelector('#gha-dot');
    var cur = panelEl.querySelector('#gha-cur');
    var msEl = panelEl.querySelector('#gha-ms');
    var priv = isPrivateRepo();

    if (priv) {
      // 私有仓库不派活，但把原因说清楚，别让用户以为是脚本坏了
      cur.textContent = '私有仓库 · 跳过镜像加速';
      msEl.textContent = '';
      dot.className = 'gha-dot dead';
    } else if (cfg.mirror) {
      var fixed = null;
      var all = mirrorList();
      for (var i = 0; i < all.length; i++) if (all[i].id === cfg.mirror) fixed = all[i];
      cur.textContent = fixed ? fixed.label : '原固定节点已下线 · 自动选择';
    } else {
      cur.textContent = best ? best.label : '无可用节点（直连）';
    }
    if (!priv) {
      var st = best ? hOf(best, bestCap) : null;
      msEl.textContent = st && typeof st.ms === 'number' && st.ok ? st.ms + 'ms' : '';
      dot.className = 'gha-dot ' + (best ? (isVerified(best, bestCap) ? 'ok' : 'wait') : 'dead');
    }

    // 节点列表
    var list = panelEl.querySelector('#gha-list');
    list.innerHTML = '';
    var sorted = mirrorList().slice().sort(function (a, b) {
      var ha = healthOf(a) || {}, hb = healthOf(b) || {};
      return ((hb.ok ? 1 : 0) - (ha.ok ? 1 : 0)) || ((ha.ms || 99999) - (hb.ms || 99999));
    });
    sorted.forEach(function (m) {
      var h = healthOf(m) || {};
      var row = document.createElement('div');
      row.className = 'gha-item' + (cfg.mirror === m.id ? ' gha-on' : '');
      // 限流（429/403）用黄点而不是红点：节点可能只是临时拒绝，和「域名挂了」不是一回事
      var cls = h.ok === true ? 'ok' : (h.ok === false ? (h.limited ? 'wait' : 'dead') : 'wait');
      var msText = h.ok && typeof h.ms === 'number' ? h.ms + 'ms'
        : (h.limited ? '限流' : (h.status ? 'HTTP ' + h.status : '—'));
      row.innerHTML = '<span class="gha-dot ' + cls + '"></span>'
        + '<span class="gha-grow"><b>' + m.label + '</b></span>'
        + '<span style="opacity:.6">' + msText + '</span>'
        + '<span class="gha-use">' + (cfg.mirror === m.id ? '已用' : '使用') + '</span>';
      row.querySelector('.gha-use').addEventListener('click', function () {
        cfg.mirror = cfg.mirror === m.id ? '' : m.id;
        saveCfg();
        reapplyMirror();        // 同上：换节点必须重画页面上的加速入口
        toast(cfg.mirror ? '已固定使用 ' + m.label : '已恢复自动选择');
      });
      list.appendChild(row);
    });

    // 上下文动作
    var actions = panelEl.querySelector('#gha-actions');
    actions.innerHTML = '';
    var ctx = pageContext();
    if (priv) {
      if (ctx.owner && ctx.repo) {
        addAction(actions, 'SSH 443', function () {
          copyText('git clone ssh://git@ssh.github.com:443/' + ctx.owner + '/' + ctx.repo + '.git');
        });
      }
      addEscapeActions(actions);
      return;
    }
    if (ctx.owner && ctx.repo) {
      addAction(actions, 'clone 加速', function () {
        var cmd = cloneCommand(ctx.owner, ctx.repo);
        if (cmd) copyText(cmd);
        else toast('暂无实测可用节点，建议直连 clone');
      });
      addAction(actions, 'SSH 443', function () {
        copyText('git clone ssh://git@ssh.github.com:443/' + ctx.owner + '/' + ctx.repo + '.git');
      });
      addAction(actions, '源码 zip', function () {
        // 必须是 /archive/HEAD.zip：/archive/refs/heads/HEAD.zip 实测 404（仓库没有叫 HEAD 的分支）
        openAccel('https://github.com/' + ctx.owner + '/' + ctx.repo + '/archive/HEAD.zip', 'archive');
      });
      addAction(actions, '复制链接', function () {
        var target = ctx.type === 'blob'
          ? toRawUrl(location.href)
          : 'https://github.com/' + ctx.owner + '/' + ctx.repo + '/archive/HEAD.zip';
        var cap = ctx.type === 'blob' ? 'raw' : 'archive';
        var acc = buildAccel(target, cap);
        if (!acc) { copyText(target); toast('暂无可用节点，已复制原始地址'); return; }
        copyText(acc);
      });
      if (ctx.type === 'blob' && ctx.filePath) {
        var rawUrl = 'https://raw.githubusercontent.com/' + ctx.owner + '/' + ctx.repo + '/HEAD/' + ctx.filePath;
        addAction(actions, '加速此文件', function () { openAccel(rawUrl, 'raw'); });
      }
    } else if (ctx.type === 'raw') {
      addAction(actions, '镜像下载本文件', function () { openAccel(location.href, 'raw'); });
      addAction(actions, '复制镜像链接', function () {
        var acc = buildAccel(location.href, 'raw');
        if (acc) copyText(acc);
        else toast('暂无可用节点');
      });
    }
    addEscapeActions(actions);
  }

  /**
   * 换节点后的统一收尾：先把旧的加速入口摘掉再按新节点重画，
   * 最后刷新面板。缺了这一步，用户点「使用」只会看到面板变了、按钮没变。
   */
  function reapplyMirror() {
    if (cfg.enabled && !isPrivateRepo()) {
      resetDecorations();
      decorateAll();
    }
    renderPanel();
  }

  function addAction(root, label, fn) {
    var b = document.createElement('button');
    b.className = 'gha-btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    root.appendChild(b);
  }

  /**
   * v1.1.0 逃生入口按钮组。故意放在「私有仓库」分支之外共用的位置：
   * 私有仓库恰恰是完全不能走镜像的场景，此时用户更需要「换条路进 GitHub」。
   * 已经在镜像站上就不再显示「打开本页」（套一层没意义）。
   */
  function addEscapeActions(root) {
    if (!onMirrorHost()) {
      ESCAPE_HOSTS.forEach(function (item) {
        addAction(root, item.label, function () { openEscape(item); });
      });
    }
    addAction(root, '复制 hosts', copyHosts);
  }

  /** git clone 只能走「前缀式」节点，且要支持仓库归档 */
  function cloneCommand(owner, repo) {
    var cands = pickCandidates('archive', 5);
    var m = null;
    for (var i = 0; i < cands.length; i++) {
      if (cands[i].style === 'full') { m = cands[i]; break; }
    }
    // 兜底不再写死 MIRRORS[0]（它可能已经挂了，等于给用户一条死命令），
    // 而是优先挑一个实测通过的 full 节点；一个都没有就返回 null 让调用方提示直连。
    if (!m) {
      var all = mirrorList();
      for (var j = 0; j < all.length; j++) {
        if (all[j].style === 'full' && isVerified(all[j], 'archive')) { m = all[j]; break; }
      }
    }
    if (!m) return null;
    return 'git clone ' + joinMirror(m.base, 'https://github.com/' + owner + '/' + repo + '.git');
  }

  function openAccel(url, cap) {
    var m = pickMirrorFor(cap || 'raw');
    var acc = m ? buildAccelWith(url, cap, m) : null;
    if (!acc) { toast('暂无可用节点，已使用直连'); window.open(url, '_blank', 'noopener'); return; }
    toast('走 ' + m.label + ' 下载');
    window.open(acc, '_blank', 'noopener');
  }

  /* ──────────────────────────────────────────────────────────
   * v1.1.0 逃生入口：连不上 github.com 主站时用
   * ────────────────────────────────────────────────────────── */

  /** 把当前页面换到 HTML 反向代理上打开（不是文件镜像，gh-proxy 系做不了 HTML） */
  function openEscape(item) {
    var host = item && item.host;
    if (!host) return;
    var target = 'https://' + host + location.pathname + location.search + location.hash;
    window.open(target, '_blank', 'noopener');
    toast('已用 ' + host + ' 打开本页（需国内 IP，不能登录 / 上传）');
  }

  /** 当前页面是否已经在某个镜像站上（在镜像站上就别再套一层） */
  function onMirrorHost() {
    var h = String(location.hostname || '');
    for (var i = 0; i < ESCAPE_HOSTS.length; i++) {
      if (h === ESCAPE_HOSTS[i].host) return true;
    }
    return false;
  }

  /**
   * 复制 GitHub520 hosts 到剪贴板。
   * 按 HOSTS_SOURCES 顺序试：gitcdn.top 带 ACAO（无 GM_xhr 也能 fetch），
   * raw.hellogithub.com 没有 ACAO（只能靠 GM_xhr）。取到后必须校验
   * 「不是 HTML 落地页」且「确实含 github.com」，否则会把一页导航骨架塞进 hosts。
   */
  function copyHosts() {
    function attempt(idx) {
      if (idx >= HOSTS_SOURCES.length) {
        toast('hosts 源暂时取不到（可能都被墙），请稍后再试');
        return;
      }
      toast('正在获取 hosts…');
      fetchText(HOSTS_SOURCES[idx], 8000).then(function (text) {
        var body = String(text || '');
        // 落地页 / 错误页识别：真 hosts 以 # 注释或 IP 开头，绝不会是 <!doctype
        var isHtml = /^\s*<(?:!doctype|html|head|body)/i.test(body);
        if (!body || isHtml || body.indexOf('github.com') < 0) { attempt(idx + 1); return; }
        copyText(body);
        toast('已复制 GitHub520 hosts 共 ' + body.split('\n').length
          + ' 行：粘贴到系统 hosts 即可（只治 DNS 污染 / 图裂，治不了 SNI 封锁；HelloGitHub 端点 2026-12-31 有到期风险）');
      });
    }
    attempt(0);
  }

  /**
   * v1.1.0 点击故障转移：对候选节点并行验证，用第一个通过的。
   * 没有 GM_xhr 时不验证（Image 探测只能证明「图片能加载」，不足以证明
   * 这条下载链接可用），直接打开手头这条加速链接 —— 仍好于回退直连。
   * 验证结果写回 health，让面板与后续选择跟着变好。
   */
  function openWithFailover(origin, need, fallbackHref) {
    var cands = pickCandidates(need, FAILOVER_TRIES);
    if (!cands.length) {
      if (fallbackHref) { window.open(fallbackHref, '_blank', 'noopener'); return; }
      window.open(origin, '_blank', 'noopener');
      return;
    }
    if (!GM_API.xhr || cands.length === 1) {
      var only = buildAccelWith(origin, need, cands[0]) || fallbackHref || origin;
      window.open(only, '_blank', 'noopener');
      return;
    }
    var settled = false;
    var pending = cands.length;
    toast('正在挑选可用节点…');
    cands.forEach(function (m) {
      var url = buildAccelWith(origin, need, m);
      if (!url) { if (--pending === 0 && !settled) flushFallback(); return; }
      probe(url, FAILOVER_TIMEOUT).then(function (r) {
        record(m, need, { ok: r.ok, ms: r.ms, status: r.status, limited: !!r.limited, ts: Date.now() });
        if (settled) return;
        if (r.ok) {
          settled = true;
          window.open(url, '_blank', 'noopener');
          toast('走 ' + m.label + ' 下载');
          return;
        }
        if (--pending === 0) flushFallback();
      }).catch(function () {
        if (--pending === 0 && !settled) flushFallback();
      });
    });
    function flushFallback() {
      if (settled) return;
      settled = true;
      var href = fallbackHref || buildAccel(origin, need) || origin;
      window.open(href, '_blank', 'noopener');
      toast('节点都不稳定，已用备用链接打开');
    }
  }

  /** 写一条健康记录（故障转移与测速共用，只改内存，持久化由调用方负责） */
  function record(m, cap, rec) {
    health[hKey(m, cap)] = rec;
  }

  function togglePanel(show) {
    cfg.panel = !!show;
    saveCfg();
    if (!show) { if (panelEl) panelEl.hidden = true; return; }
    buildPanel();
    panelEl.hidden = false;
    renderPanel();
  }

  function buildFab() {
    if (fabEl) return fabEl;
    injectStyle();
    var fab = document.createElement('div');
    fab.id = 'gha-fab';
    fab.textContent = '⚡';
    fab.title = 'GitHub 高速通道（点击展开 / Shift+点击 开关加速）';
    // 用 div 而不是 button 是为了不继承 GitHub 的按钮样式，但键盘可达性要自己补
    fab.setAttribute('role', 'button');
    fab.setAttribute('tabindex', '0');
    fab.setAttribute('aria-label', 'GitHub 高速通道：打开面板');
    fab.addEventListener('click', function (ev) {
      if (ev.shiftKey) { applyEnabled(!cfg.enabled); return; }
      togglePanel(!panelEl || panelEl.hidden);
    });
    fab.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
        ev.preventDefault();
        fab.click();
      }
    });
    document.body.appendChild(fab);
    fabEl = fab;
    if (!cfg.enabled) fab.classList.add('gha-off');
    return fab;
  }

  /* ═══════════════════════════════════════════════════════════
   * 8. 点击拦截
   * ═══════════════════════════════════════════════════════════ */

  /**
   * 挂在 document 捕获阶段，页面上每一次点击都会经过这里，所以先做最便宜的判断：
   * 两条触发路径（Alt 点击 / 源码包自动接管）都关掉时直接退出，不碰 DOM 也不解析 URL。
   *
   * v1.1.0 拆成两条完全独立的路径：
   *   A. 点我们注入的加速徽标（data-gha-chip）—— 永远接管，带逐节点故障转移。
   *      旧版在这里直接 return，把徽标交给浏览器；结果「徽标指向的那个节点刚好挂了」
   *      就是一次下载失败，用户只能自己回去重试。现在改由脚本挑一个真能通的节点。
   *   B. 点页面原生的 archive / release / raw 链接 —— 保持原有的 Alt 点击 / 自动接管行为，
   *      同样换成带故障转移的打开方式。
   */
  function onDocumentClick(e) {
    if (!accelReady()) return;
    if (e.button !== 0 || e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;      // 尊重用户"新标签/新窗口"意图

    var t = e.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    if (!a) return;

    // ── A. 我们自己的加速徽标：优先且无条件接管 ──
    if (a.getAttribute('data-gha-chip') === '1') {
      var origin = stripMirror(a.href);
      var chipKind = classify(origin);
      if (!chipKind) return;
      var need = chipKind === 'blob' ? 'raw' : chipKind;
      e.preventDefault();
      e.stopPropagation();
      openWithFailover(origin, need, a.href);
      return;
    }

    // ── B. 页面原生链接：沿用 Alt 点击 / 源码包自动接管 ──
    var byAlt = e.altKey && cfg.altClick;
    if (!byAlt && !cfg.autoArchive) return;
    var kind = classify(a.href);
    if (!kind) return;
    if (!byAlt && !(kind === 'archive' && cfg.autoArchive)) return;

    e.preventDefault();
    e.stopPropagation();
    openWithFailover(stripMirror(a.href), kind === 'blob' ? 'raw' : kind, buildAccel(a.href, kind));
  }

  /* ═══════════════════════════════════════════════════════════
   * 9. 生命周期
   * ═══════════════════════════════════════════════════════════ */

  /**
   * GitHub 是会持续变异的 SPA（相对时间、通知红点、滚动加载都在改 DOM），
   * 所以「任何变异都重扫一遍全文档」代价很高。这里只认会带来新可加速元素的插入，
   * 并且把扫描排到空闲时间做，避免和 GitHub 自己的渲染抢主线程。
   */
  var RELEVANT_SEL = [
    'a[href*="/releases/download/"]',   // Release 附件
    'a[href*="/releases/latest/download/"]',
    'a[href*="/archive/"]',             // 源码包
    'a[href*="/raw/"]',                 // Gist / raw 链接
    'a[data-testid="raw-button"]',      // blob 页 Raw 按钮
    '[role="row"]', '.Box-row', 'tr',   // 文件列表行
    'img[src*="githubusercontent.com"]' // 头像与图片
  ].join(',');

  /** 我们自己注入的节点（注入动作本身也会触发 MutationObserver，必须排除，否则自我反馈） */
  var SELF_SEL = '.gha-chip,.gha-dl,#gha-panel,#gha-fab,#gha-rawbar,.gha-toast';

  function isSelfNode(n) {
    if (!n || n.nodeType !== 1 || !n.matches) return false;
    return n.matches(SELF_SEL) || !!n.closest('#gha-panel,#gha-fab,#gha-rawbar');
  }

  function mutationMatters(list) {
    for (var i = 0; i < list.length; i++) {
      var added = list[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        var n = added[j];
        if (n.nodeType !== 1) continue;
        if (isSelfNode(n)) continue;
        if (n.matches(RELEVANT_SEL)) return true;
        if (n.querySelector && n.querySelector(RELEVANT_SEL)) return true;
      }
    }
    return false;
  }

  var decorateTimer = null;
  function scheduleDecorate() {
    if (decorateTimer) return;
    decorateTimer = setTimeout(function () {
      decorateTimer = null;
      var run = function () {
        try { decorateAll(); } catch (e) { /* 页面结构变化时静默 */ }
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 600 });   // 主线程忙时最多等 600ms
      } else {
        run();
      }
    }, 200);
  }

  function boot() {
    injectStyle();
    buildFab();   // 始终渲染悬浮球：关闭状态下灰显，仍可点开面板重新开启
    if (cfg.enabled) {
      // 窄屏默认只留悬浮球，避免面板遮挡页面
      if (cfg.panel && (window.innerWidth || 1024) >= 700) { buildPanel(); renderPanel(); }
      if (!isPrivateRepo()) {
        try { decorateAll(); } catch (e) { /* ignore */ }
        scheduleDecorate();
        // 任何一个节点缺少新鲜结果就整体重测：换过节点表 / 过了 TTL 都靠这条兜底
        var stale = mirrorList().some(function (m) { return !healthOf(m); });
        if (stale) {
          probeAll().then(function () {
            renderPanel();
            resetDecorations();
            decorateAll();
          });
        } else renderPanel();
      } else if (panelEl) renderPanel();
      // v1.1.0：常驻看门狗。原来的逻辑只在 boot 时探一次，一旦某轮全网抖动
      // 把节点全判死，之后网络恢复了也只有用户手动点「重新测速」才会回来。
      startWatchdog();
    }

    document.addEventListener('click', onDocumentClick, true);

    // GitHub Turbo / pjax 导航
    ['turbo:load', 'pjax:end', 'turbo:render'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        scheduleDecorate();
        if (panelEl && !panelEl.hidden) renderPanel();
      });
    });

    // 兜底：DOM 变化（含懒加载的 Releases 列表、文件列表）
    if (typeof MutationObserver === 'function' && document.documentElement) {
      var mo = new MutationObserver(function (mutations) {
        if (!cfg.enabled || isPrivateRepo()) return;
        if (mutationMatters(mutations)) scheduleDecorate();
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    // 菜单命令
    if (GM_API.menu) {
      GM_API.menu('⚡ 打开 / 收起面板', function () {
        togglePanel(!panelEl || panelEl.hidden);
      });
      GM_API.menu('🔁 重新测速全部节点', function () {
        probeAll().then(function () {
          resetDecorations();
          decorateAll();
          renderPanel();
          toast('测速完成');
        });
      });
      // v1.1.0 逃生入口：主站都打不开时，面板多半也点不到，所以必须进菜单
      if (!onMirrorHost()) {
        ESCAPE_HOSTS.forEach(function (item) {
          GM_API.menu('🚪 ' + item.label, function () { openEscape(item); });
        });
      }
      GM_API.menu('📋 复制 GitHub hosts', copyHosts);
      // 菜单项文案注册后不会跟着状态变，所以写成中性的「切换」，避免关掉后还显示「关闭加速」
      GM_API.menu('⏯ 切换加速开关', function () {
        applyEnabled(!cfg.enabled);
      });
      GM_API.menu('🔗 自定义镜像地址', function () {
        var cur = cfg.custom || '';
        var input = window.prompt(
          '输入自定义镜像前缀（留空 = 清除）：\n'
          + '· 形如 https://xxx.com ，脚本会拼成 https://xxx.com/https://github.com/...\n'
          + '· 自定义节点会排在最前面，并参与测速\n'
          + '· 已用 @connect * 放行任意自建域名\n\n当前：' + (cur || '(未设置)'), cur);
        if (input === null) return;
        cfg.custom = String(input).trim().replace(/\/+$/, '');
        cfg.mirror = '';
        saveCfg();
        paneReset();
        probeAll().then(function () { resetDecorations(); decorateAll(); renderPanel(); toast('已应用自定义节点'); });
      });
      GM_API.menu('♻️ 恢复默认设置', function () {
        if (typeof window.confirm === 'function' && !window.confirm('把所有设置恢复默认（包括自定义镜像与系统选择）？')) return;
        for (var k in DEFAULT_CFG) {
          if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) cfg[k] = DEFAULT_CFG[k];
        }
        saveCfg();
        resetDecorations();
        resetEnhance();
        paneReset();
        if (cfg.enabled) decorateAll();
        renderPanel();
        toast('已恢复默认设置');
      });
    }
  }

  function paneReset() {
    if (panelEl) { panelEl.remove(); panelEl = null; }
    if (cfg.panel && (window.innerWidth || 1024) >= 700) { buildPanel(); }
  }

  function whenReady(fn) {
    if (document.body) { fn(); return; }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  whenReady(boot);
})();
