// CodeGraph Manager —— 服务器代码索引管理服务
//
// 零依赖 Node 服务 + 原生 JS 单页前端。管理多提供商仓库的 clone → codegraph 分析 → 移除。
// 支持：GitLab / Gitee / GitHub（可同时配置多个提供商实例）
//
// 运行：node server.mjs   （默认 http://127.0.0.1:8801）
// 环境变量：
//   HOST / PORT        监听地址端口（默认 127.0.0.1 / 8801；HOST 非回环时必须配 token，否则拒绝启动）
//   DATA_DIR           数据目录（settings.json + repos.json 存放，默认 ./data）
//   ADMIN_TOKEN        /api/* 的 Bearer 令牌；未设置时首次启动自动生成随机令牌并持久化到 <DATA_DIR>/auth.json
//   MCP_TOKEN          /mcp* 的令牌（未设置回落 ADMIN_TOKEN，自用只配一个变量即可）
//   LOCAL_NO_AUTH      回环免鉴权开关（默认 1 开启；设 0 关闭，本地也需令牌）
//   TRUSTED_PROXIES    逗号分隔可信代理 IP：仅对可信代理采信 X-Forwarded-For 判定回环来源
//   BASE_PATH          反代前缀部署路径（如 /repair-service-mcp），默认空
//   MAX_BODY_BYTES     请求体大小上限（默认 1MB，超限返回 413）
//   CODEGRAPH_BIN      codegraph 可执行（未设置时自动探测：PATH 里的 codegraph → npm 全局包 shim）
// 数据：
//   <DATA_DIR>/settings.json   提供商配置列表 + clone 基目录
//   <DATA_DIR>/repos.json      仓库注册表（clone 路径、分析状态）
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handleMcpMessage, handleSseConnection, broadcastSse } from './mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8801', 10);
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(HERE, 'data');
// 令牌引导：显式 ADMIN_TOKEN 环境变量优先；未配置时首次启动生成随机令牌（192bit）并持久化到 <DATA_DIR>/auth.json，重启沿用
function bootstrapToken() {
  const file = path.join(DATA_DIR, 'auth.json');
  let saved = {};
  try { saved = JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch {}
  if (process.env.ADMIN_TOKEN) return { token: process.env.ADMIN_TOKEN, file, generated: false };
  if (typeof saved.adminToken === 'string' && saved.adminToken) return { token: saved.adminToken, file, generated: false };
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    fsSync.mkdirSync(DATA_DIR, { recursive: true });
    fsSync.writeFileSync(file, JSON.stringify({ adminToken: token, createdAt: new Date().toISOString() }, null, 2));
    return { token, file, generated: true };
  } catch (e) {
    log('warn: auth.json 写入失败，未能生成默认令牌', e.message);
    return { token: '', file, generated: false };
  }
}
const BOOTSTRAP_TOKEN = bootstrapToken();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || BOOTSTRAP_TOKEN.token;
const MCP_TOKEN = process.env.MCP_TOKEN || ADMIN_TOKEN; // 未设置回落 ADMIN_TOKEN（自用只配一个变量）
const LOCAL_NO_AUTH = process.env.LOCAL_NO_AUTH !== '0'; // 回环免鉴权默认开启（设 0 关闭，本地也强制鉴权）
const TRUSTED_PROXIES = new Set((process.env.TRUSTED_PROXIES || '').split(',').map(s => s.trim()).filter(Boolean));
// BASE_PATH 前缀部署：反代把 /<base>/* 转发进来，路由匹配前剥掉该前缀；未设置行为不变
export const BASE_PATH = process.env.BASE_PATH ? '/' + process.env.BASE_PATH.replace(/^\/+|\/+$/g, '') : '';
// 请求体上限（readBody 与 MCP 消息体共用同一上限，超限 413）
export const MAX_BODY_BYTES = Math.max(1, parseInt(process.env.MAX_BODY_BYTES || String(1024 * 1024), 10) || 1024 * 1024);

// CODEGRAPH_BIN 解析：显式配置原样保留（含 JSON 数组形式）；未设置时自动探测——
// 1) PATH 里的 codegraph（Linux install.sh 方式）；2) npm 全局包 @colbymchenry/codegraph 的
// npm-shim.js（Windows 全局装是 bash shim，PATH 调不通）→ 转 ["node", "<shim>"] 数组形式。
// 都失败回落 'codegraph'，与旧行为一致。
function resolveCodegraphBin() {
  const raw = (process.env.CODEGRAPH_BIN || '').trim();
  if (raw) return raw;
  // 探测必须与实际调用方式一致（run() 无 shell 直接 spawn）：
  // Windows 全局装的 bash shim 经 cmd 包装能通过 shell 探测，直接 spawn 却会失败，故此处不用 shell
  const probe = spawnSync('codegraph', ['--version'], { timeout: 5000 });
  if (!probe.error && probe.status === 0) return 'codegraph';
  try {
    // npm 本体是 npm.cmd（Windows），root 查询经 shell 执行；无用户输入拼接，无注入面
    const root = spawnSync('npm', ['root', '-g'], { timeout: 10000, shell: process.platform === 'win32' }).stdout?.toString().trim();
    if (root) {
      const shim = path.join(root, '@colbymchenry', 'codegraph', 'npm-shim.js');
      if (fsSync.existsSync(shim)) return JSON.stringify(['node', shim]);
    }
  } catch { /* 探测失败走默认 */ }
  return 'codegraph';
}
const CODEGRAPH_BIN = resolveCodegraphBin();
// 回写 env：mcp.mjs 的 stdio 网关子进程读取 CODEGRAPH_BIN，必须拿到探测结果而非裸命令名
process.env.CODEGRAPH_BIN = CODEGRAPH_BIN;

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const REPOS_FILE = path.join(DATA_DIR, 'repos.json');
// clone 基目录默认收敛进 DATA_DIR：备份/迁移 = 拷一个目录（避免相对 cwd 散落）
const CLONE_BASE_DIR_DEFAULT = path.join(DATA_DIR, 'repos');

/* ---------------- 日志 ---------------- */
function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

/* ---------------- 持久化 ---------------- */
async function ensureDataDir() { await fs.mkdir(DATA_DIR, { recursive: true }); }

/* ---------------- 凭证加密（AES-256-GCM） ---------------- */
// 约定：内存中 provider.token 保持明文（供 API/克隆调用），落盘时加密。
// 密钥：优先 ENCRYPTION_KEY 环境变量（64 hex = 32 字节）；否则从 DATA_DIR/.key 读，无则生成。
let encKey = null;
function getEncKey() {
  if (encKey) return encKey;
  const envK = (process.env.ENCRYPTION_KEY || '').trim();
  if (/^[0-9a-f]{64}$/i.test(envK)) { encKey = Buffer.from(envK, 'hex'); return encKey; }
  const keyFile = path.join(DATA_DIR, '.key');
  try {
    const k = fsSync.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(k)) { encKey = Buffer.from(k, 'hex'); return encKey; }
  } catch {}
  const key = crypto.randomBytes(32);
  encKey = key;
  try { ensureDataDir(); fsSync.writeFileSync(keyFile, key.toString('hex'), { flag: 'wx' }); } catch {}
  return encKey;
}
function encryptToken(t) {
  if (!t) return t;
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return 'enc:' + iv.toString('base64') + '.' + tag.toString('base64') + '.' + enc.toString('base64');
}
function decryptToken(t) {
  if (!t || !String(t).startsWith('enc:')) return t; // 非加密（第三方明文/未迁移）按原样返回
  try {
    const key = getEncKey();
    const [ivb, tagb, datab] = String(t).slice(4).split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivb, 'base64'));
    d.setAuthTag(Buffer.from(tagb, 'base64'));
    return Buffer.concat([d.update(Buffer.from(datab, 'base64')), d.final()]).toString('utf8');
  } catch { return ''; } // 密钥不符/损坏 → 视为无 token
}

// 默认设置：providers 数组 + 全局配置
const DEFAULT_SPACE = { id: 'all', name: '全部', builtin: true, order: 0 };
let settings = {
  providers: [],  // [{id, type, name, url, token, createdAt}]
  activeProviderId: '',  // 当前激活的提供商 ID
  cloneBaseDir: CLONE_BASE_DIR_DEFAULT,
  autoSyncHours: null,   // 定时同步频率（小时），null=用 env SYNC_HOURS 或默认 6；0=关闭
  spaces: [DEFAULT_SPACE] // 空间（标签/分组）：[{id,name,builtin?,order}]
};
let repos = []; // [{id,name,providerId,providerType,gitUrl,localPath,branch,status,message,addedAt,worktrees:[...],spaceIds:[]}]
// worktree 状态：registered(待建) / indexing(建+分析中) / indexed(可用) / failed
function ensureWorktreesField() { for (const r of repos) if (!Array.isArray(r.worktrees)) r.worktrees = []; }
function ensureSpaceIdsField() { for (const r of repos) if (!Array.isArray(r.spaceIds)) r.spaceIds = []; }

async function loadAll() {
  await ensureDataDir();
  try {
    const saved = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    // 兼容旧格式：迁移旧的单一提供商配置到新格式
    if (saved.gitlabUrl || saved.gitlabToken || saved.giteeUrl || saved.giteeToken || saved.githubToken) {
      const providers = [];
      if (saved.gitlabUrl || saved.gitlabToken) {
        providers.push({ id: crypto.randomUUID(), type: 'gitlab', name: 'GitLab', url: saved.gitlabUrl || '', token: saved.gitlabToken || '', createdAt: Date.now() });
      }
      if (saved.giteeUrl || saved.giteeToken) {
        providers.push({ id: crypto.randomUUID(), type: 'gitee', name: 'Gitee', url: saved.giteeUrl || 'https://gitee.com', token: saved.giteeToken || '', createdAt: Date.now() });
      }
      if (saved.githubToken) {
        providers.push({ id: crypto.randomUUID(), type: 'github', name: 'GitHub', url: '', token: saved.githubToken, createdAt: Date.now() });
      }
      settings = {
        providers,
        activeProviderId: providers[0]?.id || '',
        cloneBaseDir: saved.cloneBaseDir || ''
      };
    } else {
      settings = { ...settings, ...saved };
    }
  } catch {}
  if (!settings.cloneBaseDir) settings.cloneBaseDir = CLONE_BASE_DIR_DEFAULT; // 兼容旧数据/空值：兜底回 DATA_DIR/repos
  try { repos = JSON.parse(await fs.readFile(REPOS_FILE, 'utf8')); } catch {}
  await healStaleStatus(); // 启动自愈：重置被重启中断的运行中状态
  ensureWorktreesField();  // 兼容旧数据：确保 worktrees 字段存在
  ensureSpaceIdsField();   // 兼容旧数据：确保 spaceIds 字段存在
  if (!Array.isArray(settings.spaces) || !settings.spaces.length) settings.spaces = [DEFAULT_SPACE];
  if (!settings.spaces.some(s => s.id === 'all')) settings.spaces.unshift(DEFAULT_SPACE);
  // 清理 repos.spaceIds 中的脏值（null / 指向已不存在空间的 id）
  const validSpaceIds = new Set(settings.spaces.map(s => s.id));
  for (const r of repos) r.spaceIds = (r.spaceIds || []).filter(id => validSpaceIds.has(id));
  // 解密 providers token 回内存明文；检测明文 token（未迁移/第三方）→ 迁移为加密落盘
  let needsEncrypt = false;
  settings.providers = settings.providers.map(p => {
    const t = p.token;
    if (t && !String(t).startsWith('enc:')) needsEncrypt = true;
    return { ...p, token: decryptToken(t) };
  });
  if (needsEncrypt) await saveSettings();
}
async function saveSettings() {
  await ensureDataDir();
  // 落盘时对 providers token 加密（内存 settings 保持明文供调用）
  const snapshot = {
    ...settings,
    providers: settings.providers.map(p => ({ ...p, token: p.token ? encryptToken(p.token) : '' }))
  };
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(snapshot, null, 2));
}
async function saveRepos() {
  await ensureDataDir();
  await fs.writeFile(REPOS_FILE, JSON.stringify(repos, null, 2));
  broadcastSse('repos-changed', { t: Date.now() }); // 推送前端刷新（替代 4s 轮询）
}
const RUNNING_STATUSES = ['cloning', 'indexing', 'removing', 'syncing'];
// 启动自愈：进程被重启中断时，把卡在"运行中状态"的仓库重置为可重试，防永久处理中
async function healStaleStatus() {
  let changed = false;
  for (const r of repos) {
    if (RUNNING_STATUSES.includes(r.status)) {
      // cloning→registered(重新克隆)；其余有本地目录→cloned(重新 analyze/sync)，无目录→registered
      r.status = r.status === 'cloning' ? 'registered' : (r.localPath ? 'cloned' : 'registered');
      r.message = 'Interrupted by restart — reset.';
      changed = true;
    }
  }
  if (changed) await saveRepos();
}

/* ---------------- 子进程运行器 ---------------- */
function run(cmd, args, opts = {}) {
  // CODEGRAPH_NO_WATCHDOG=1：禁用 codegraph 看门狗子进程，避免其孤儿进程长期锁 .codegraph/codegraph.db（导致再 clone/analyze 时 EBUSY）
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, CODEGRAPH_NO_WATCHDOG: '1', ...(opts.env||{}) } });
    let out = '', err = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, ok: false, out, err: e.message }));
    p.on('close', (code) => resolve({ code, ok: code === 0, out, err }));
  });
}

/** 解析 CODEGRAPH_BIN：支持 "codegraph"(空格分隔) 或 JSON 数组(可含空格路径)。mcp.mjs 复用。 */
export function parseBin(s) {
  s = (s || '').trim();
  if (s.startsWith('[')) { try { const a = JSON.parse(s); return a.map(String); } catch {} }
  return s.split(/\s+/).filter(Boolean);
}

/* ---------------- 全局索引队列 ---------------- */
// codegraph init/sync 是 CPU/IO 密集型，多仓并发会互相抢资源 + 加剧 SQLite db 锁竞争（EBUSY）。
// 所有重量级索引操作经此队列限流执行（QUEUE_CONCURRENCY 可调，默认 2）。
const QUEUE_CONCURRENCY = Math.max(1, parseInt(process.env.QUEUE_CONCURRENCY || '2', 10) || 2);
let queueActive = 0;
const queueWaiting = [];
function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queueWaiting.push({ fn, resolve, reject });
    pumpQueue();
  });
}
function pumpQueue() {
  while (queueActive < QUEUE_CONCURRENCY && queueWaiting.length) {
    const { fn, resolve, reject } = queueWaiting.shift();
    queueActive++;
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { queueActive--; pumpQueue(); });
  }
}

/* ---------------- 提供商抽象层 ---------------- */
function getProviderById(id) {
  return settings.providers.find(p => p.id === id) || null;
}
function getActiveProvider() {
  return getProviderById(settings.activeProviderId) || settings.providers[0] || null;
}
function getProviderHeaders(provider) {
  switch (provider.type) {
    case 'gitlab': return { 'PRIVATE-TOKEN': provider.token, 'Content-Type': 'application/json' };
    case 'gitee': return { 'Authorization': `Bearer ${provider.token}`, 'Content-Type': 'application/json' };
    case 'github': return { 'Authorization': `token ${provider.token}`, 'Content-Type': 'application/json', 'User-Agent': 'CodeGraph-Manager' };
    default: return { 'Content-Type': 'application/json' };
  }
}
function getProviderApiBase(provider) {
  switch (provider.type) {
    case 'gitlab': return provider.url.replace(/\/$/, '');
    case 'gitee': return provider.url.replace(/\/$/, '');
    case 'github': return 'https://api.github.com';
    default: return provider.url.replace(/\/$/, '');
  }
}
async function providerFetch(pathname, search, provider) {
  const base = getProviderApiBase(provider);
  const headers = getProviderHeaders(provider);
  const url = `${base}${pathname}${search || ''}`;
  const r = await fetch(url, { headers });
  if (!r.ok) { const t = await r.text().catch(()=>''); throw { status: r.status, msg: t.slice(0,300) }; }
  return r.json();
}
async function checkProvider(provider) {
  try {
    let user, version = null;
    switch (provider.type) {
      case 'gitlab': {
        const me = await providerFetch('/api/v4/user', '', provider);
        user = me?.username || me?.name;
        try { const v = await providerFetch('/api/v4/version', '', provider); version = v?.version || null; } catch {}
        break;
      }
      case 'gitee': {
        const me = await providerFetch('/api/v5/user', '', provider);
        user = me?.login || me?.name;
        break;
      }
      case 'github': {
        const me = await providerFetch('/user', '', provider);
        user = me?.login || me?.name;
        break;
      }
    }
    return { ok: true, user, version };
  } catch (e) {
    const names = { gitlab: 'GitLab', gitee: 'Gitee', github: 'GitHub' };
    return { ok: false, status: e.status, msg: (e instanceof TypeError ? `无法连接 ${names[provider.type] || provider.type}，请检查地址与网络` : (e.msg || String(e))) };
  }
}
async function searchProjects(query, providerId) {
  const provider = providerId ? getProviderById(providerId) : getActiveProvider();
  if (!provider) throw { msg: '未配置提供商' };
  const q = (query || '').trim();
  if (!q) return [];
  switch (provider.type) {
    case 'gitlab': {
      const projects = await providerFetch('/api/v4/projects', `?search=${encodeURIComponent(q)}&simple=true&per_page=50`, provider);
      return (Array.isArray(projects) ? projects : []).map(p => ({
        id: p.id, name: p.path_with_namespace, gitUrl: p.http_url_to_repo || p.web_url + '.git',
        defaultBranch: p.default_branch || 'main', providerId: provider.id, providerType: 'gitlab'
      }));
    }
    case 'gitee': {
      const projects = await providerFetch('/api/v5/repos/search', `?q=${encodeURIComponent(q)}&per_page=50`, provider);
      return (Array.isArray(projects) ? projects : []).map(p => ({
        id: p.id, name: p.full_name, gitUrl: p.html_url + '.git',
        defaultBranch: p.default_branch || 'main', providerId: provider.id, providerType: 'gitee'
      }));
    }
    case 'github': {
      const data = await providerFetch('/search/repositories', `?q=${encodeURIComponent(q)}&per_page=50`, provider);
      return (data?.items || []).map(p => ({
        id: p.id, name: p.full_name, gitUrl: p.clone_url,
        defaultBranch: p.default_branch || 'main', providerId: provider.id, providerType: 'github'
      }));
    }
    default: return [];
  }
}

/* ---------------- 工具 ---------------- */
const sanitize = (s) => s.replace(/[\\/<>:"|?*\x00-\x1f]/g, '__');
function getCloneAuthUrl(gitUrl, provider) {
  if (!provider.token) return gitUrl;
  if (/^https?:\/\//i.test(gitUrl)) {
    switch (provider.type) {
      case 'gitlab': return gitUrl.replace(/^https:\/\//, `https://oauth2:${encodeURIComponent(provider.token)}@`);
      case 'gitee': return gitUrl.replace(/^https:\/\//, `https://oauth2:${encodeURIComponent(provider.token)}@`);
      case 'github': return gitUrl.replace(/^https:\/\//, `https://x-access-token:${encodeURIComponent(provider.token)}@`);
      default: return gitUrl;
    }
  }
  return gitUrl;
}

/* ---------------- HTTP ---------------- */
function sendJson(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const cs = []; let size = 0, over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { // 超限：拒收并断开（413 由统一 catch 返回）
        over = true; cs.length = 0; req.pause();
        const e = new Error('payload too large'); e.statusCode = 413; reject(e);
        return;
      }
      cs.push(c);
    });
    req.on('end', () => { if (over) return; try { const t = Buffer.concat(cs).toString('utf8'); resolve(t ? JSON.parse(t) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/* ---------------- 鉴权 ---------------- */
// 令牌比较：长度不等直接否；等长用 timingSafeEqual（防时序侧信道），绝不用 === 比字符串
function tokenEquals(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
// 令牌解析顺序：Authorization: Bearer X → 原始 Authorization（兼容现有写法）→ ?token=（仅 MCP，给只能填 URL 的客户端）→ Cookie cgm_token
function extractToken(req, query, allowQuery) {
  const h = req.headers['authorization'];
  if (h) {
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (m) return m[1].trim();
    return h.trim();
  }
  if (allowQuery && query.token) return String(query.token);
  const ck = req.headers['cookie'];
  if (ck) {
    const m = /(?:^|;\s*)cgm_token=([^;]*)/.exec(ck);
    if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  }
  return '';
}
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// 真实来源：仅当对端在可信代理名单内才采信 X-Forwarded-For 最左值（否则一律忽略该头，防伪造）
function clientAddr(req) {
  const peer = req.socket.remoteAddress || '';
  if (TRUSTED_PROXIES.size && TRUSTED_PROXIES.has(peer)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return peer;
}
// Origin 与请求 Host 是否同源（含端口）；无 Origin（curl/MCP 客户端/同源 GET 导航）视为同源
function originMatchesHost(req) {
  const origin = req.headers['origin'];
  if (!origin) return true;
  try { return new URL(origin).host.toLowerCase() === String(req.headers['host'] || '').toLowerCase(); } catch { return false; }
}
// 回环豁免：本机直连 且 无跨源 Origin（浏览器里任意网页都能 POST 127.0.0.1，必须靠 Origin 校验拦住）
function isLocalNoAuth(req) {
  return LOCAL_NO_AUTH && LOOPBACK_ADDRS.has(clientAddr(req)) && originMatchesHost(req);
}
// /api/* 守卫：回环豁免 → ADMIN_TOKEN
function guardAdmin(req) {
  if (isLocalNoAuth(req)) return true;
  return tokenEquals(extractToken(req, {}, false), ADMIN_TOKEN);
}
// /mcp* 守卫：回环豁免 → MCP_TOKEN（未设置回落 ADMIN_TOKEN；?token= 兜底）
function guardMcp(req, query) {
  if (isLocalNoAuth(req)) return true;
  return tokenEquals(extractToken(req, query, true), MCP_TOKEN);
}
async function staticServe(req, res, pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    const f = path.join(HERE, 'public', 'index.html');
    try { const b = await fs.readFile(f); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(b); } catch { sendJson(res, 500, { error: 'missing public/index.html' }); }
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}

/* ---------------- 仓库操作 ---------------- */
function findRepo(id) { return repos.find((r) => r.id === id); }
async function opClone(repo) {
  // 防重复：已 indexed 且目录存在 → 直接返回（不重复 clone，也不把已成功状态打回 failed）
  if (repo.status === 'indexed' && repo.localPath && fsSync.existsSync(repo.localPath)) return true;
  repo.status = 'cloning'; await saveRepos();
  const dest = path.join(settings.cloneBaseDir, sanitize(repo.name));
  await fs.mkdir(settings.cloneBaseDir, { recursive: true }).catch(()=>{});
  // 目标目录已存在（残留/上次失败）→ 清掉重新 clone，避免 "already exists" 失败
  await fs.rm(dest, { recursive: true, force: true }).catch(()=>{});
  const provider = getProviderById(repo.providerId) || getActiveProvider();
  const url = provider ? getCloneAuthUrl(repo.gitUrl, provider) : repo.gitUrl;
  const args = ['clone', '--depth', '1']; // 检索用途不需要历史：浅克隆通常 10x 提速（--depth 隐含 --single-branch）
  if (repo.branch) args.push('--branch', repo.branch);
  args.push(url, dest);
  const r = await run('git', args);
  if (!r.ok) { repo.status = 'failed'; repo.message = (r.err || r.out).slice(-400); await saveRepos(); return false; }
  repo.localPath = dest; repo.status = 'cloned'; repo.message = r.out.slice(-200); await saveRepos();
  // 主仓库 .gitignore 追加 worktrees/，豁免分支 worktree 被主索引扫入（多分支策略）
  await fs.appendFile(path.join(dest, '.gitignore'), '\nworktrees/\n').catch(()=>{});
  // clone 成功 → 自动建索引
  return await opAnalyze(repo);
}
async function opAnalyze(repo) {
  if (!repo.localPath || !fsSync.existsSync(repo.localPath)) { repo.status = 'failed'; repo.message = 'not cloned'; await saveRepos(); return false; }
  repo.status = 'indexing'; repo.message = 'Queued: waiting for index slot...'; await saveRepos();
  // 经全局队列执行 codegraph init（限流，避免多仓并发抢 CPU/IO + db 锁竞争）
  return enqueue(async () => {
    const [cmd, ...args] = parseBin(CODEGRAPH_BIN);
    const r = await run(cmd, [...args, 'init', repo.localPath], { cwd: settings.cloneBaseDir });
    repo.status = r.ok ? 'indexed' : 'failed';
    repo.message = (r.ok ? (r.out || r.err) : (r.err || r.out)).slice(-400);
    await saveRepos();
    return r.ok;
  });
}
async function opSync(repo) {
  if (!repo.localPath || !fsSync.existsSync(repo.localPath)) { repo.status = 'failed'; repo.message = 'not cloned'; await saveRepos(); return false; }
  repo.status = 'indexing'; repo.message = 'Pulling & syncing...'; await saveRepos();
  const pull = await run('git', ['-C', repo.localPath, 'pull']); // 拉取远端变更（浅克隆下 fetch 保持 shallow 边界）
  if (!pull.ok) {
    // pull 失败 → 不执行索引（否则界面显示正常但索引是旧的）：标记拉取失败，status 不得置 indexed
    repo.status = 'pull_failed';
    repo.message = ('pull failed: ' + (pull.err || pull.out || '')).slice(-400);
    await saveRepos();
    return false;
  }
  const [cmd, ...args] = parseBin(CODEGRAPH_BIN);
  const sc = await enqueue(() => run(cmd, [...args, 'sync', repo.localPath], { cwd: settings.cloneBaseDir })); // 增量重建索引（入队限流）
  repo.status = sc.ok ? 'indexed' : 'failed';
  repo.message = (sc.out || sc.err || pull.out || '').slice(-400);
  if (sc.ok) { // 记录同步/索引的 HEAD，便于判断索引新鲜度
    const rev = await run('git', ['-C', repo.localPath, 'rev-parse', 'HEAD']);
    if (rev.ok) repo.lastSyncedCommit = repo.lastIndexedCommit = rev.out.trim();
  }
  await saveRepos();
  return sc.ok;
}
async function opStatus(repo) {
  if (!repo.localPath || !fsSync.existsSync(repo.localPath)) { repo.status = 'failed'; repo.message = 'not cloned'; await saveRepos(); return false; }
  const [cmd, ...args] = parseBin(CODEGRAPH_BIN);
  const r = await run(cmd, [...args, 'status'], { cwd: repo.localPath });
  repo.status = r.ok ? repo.status || 'indexed' : 'failed';
  repo.message = (r.out || r.err).slice(-400);
  return r.ok;
}
async function opRemove(repo) {
  const tryRemove = async () => {
    // 1. 先解所有 worktree 锁（SQLite db 持有者），否则 Windows 上 EBUSY
    for (const w of (repo.worktrees || [])) {
      if (w.localPath && fsSync.existsSync(w.localPath)) {
        await run('git', ['worktree', 'remove', '--force', w.localPath], { cwd: repo.localPath }).catch(()=>{});
      }
    }
    if (repo.localPath && fsSync.existsSync(repo.localPath)) {
      // 主仓库自身若是 worktree 也解一下
      await run('git', ['worktree', 'remove', '--force', repo.localPath], {}).catch(()=>{});
      await fs.rm(repo.localPath, { recursive: true, force: true });
    }
  };
  try {
    await tryRemove();
  } catch (e) {
    if (/EBUSY/i.test(e.message)) {
      // SQLite db 仍被锁（多半是另一 codegraph 实例/本进程 watchdog 占着），后台延迟重试
      log('remove EBUSY, retry later', repo.localPath);
      setTimeout(() => tryRemove().catch(err => log('remove retry failed', err.message)), 5000);
    } else {
      log('remove dir failed', e.message);
    }
  }
  const i = repos.findIndex((r) => r.id === repo.id);
  if (i >= 0) repos.splice(i, 1);
  await saveRepos();
}

// 多分支策略：确保某个分支的 worktree 已建好并索引。
// 返回 { ready:true, localPath } 或 { ready:false, pending:true }（后台异步建，调用方应提示"稍后重试"）
async function opEnsureWorktree(repo, branch) {
  if (!repo.localPath || !fsSync.existsSync(repo.localPath)) return { ready: false, error: '主仓库尚未克隆' };
  const existing = (repo.worktrees || []).find((w) => w.branch === branch);
  if (existing) {
    if (existing.status === 'indexed' && existing.localPath && fsSync.existsSync(existing.localPath)) return { ready: true, localPath: existing.localPath };
    if (existing.status === 'indexing') return { ready: false, pending: true };
    if (existing.status === 'failed') { /* 重建 */ }
  }
  // 触发后台异步建：fetch 分支引用 → worktree add → codegraph init
  const wt = existing || { branch, localPath: path.join(repo.localPath, 'worktrees', sanitize(branch)), status: 'registered', message: '' };
  if (!existing) { repo.worktrees = repo.worktrees || []; repo.worktrees.push(wt); }
  wt.status = 'indexing'; wt.message = 'Creating worktree & indexing...'; await saveRepos();
  (async () => {
    try {
      // 主仓库 .gitignore 追加 worktrees/（豁免分支 worktree 被主索引扫入；兼容已存在的老仓库）
      const gi = path.join(repo.localPath, '.gitignore');
      let giContent = '';
      try { giContent = await fs.readFile(gi, 'utf8'); } catch {}
      if (!giContent.split('\n').map(s => s.trim()).includes('worktrees/')) {
        await fs.appendFile(gi, (giContent && !giContent.endsWith('\n') ? '\n' : '') + 'worktrees/\n').catch(()=>{});
      }
      // fetch 分支引用（浅 fetch 保持 shallow 边界；若远端无此分支，给出友好提示而非堆 git 原始错误）
      const fetchR = await run('git', ['fetch', '--depth', '1', 'origin', `${branch}:refs/remotes/origin/${branch}`], { cwd: repo.localPath });
      if (!fetchR.ok) {
        const errMsg = (fetchR.err || '').toLowerCase();
        if (errMsg.includes('couldn') && errMsg.includes('remote ref')) {
          throw new Error(`远端不存在分支 "${branch}"（请确认分支名拼写与远程分支）`);
        }
        throw new Error('fetch branch failed: ' + (fetchR.err || '').slice(-200));
      }
      // worktree add：若因残留/注册表脏失败，先 prune + 清注册 + 删目录再重试
      let addR = await run('git', ['worktree', 'add', '-q', wt.localPath, `origin/${branch}`], { cwd: repo.localPath });
      if (!addR.ok && /already exists|already registered|missing worktree|missing but|not a valid|is already checked out/i.test(addR.err || addR.out || '')) {
        await run('git', ['worktree', 'prune', '--expire', 'now'], { cwd: repo.localPath }).catch(()=>{});
        await run('git', ['worktree', 'prune'], { cwd: repo.localPath });
        await fs.rm(wt.localPath, { recursive: true, force: true }).catch(()=>{});
        // 清掉 git 内部 worktrees 注册目录（防 "missing worktree" 残留注册）
        await fs.rm(path.join(repo.localPath, '.git', 'worktrees', sanitize(branch)), { recursive: true, force: true }).catch(()=>{});
        addR = await run('git', ['worktree', 'add', '-q', wt.localPath, `origin/${branch}`], { cwd: repo.localPath });
      }
      if (!addR.ok) throw new Error('worktree add failed: ' + (addR.err || addR.out || '').slice(-200));
      const [cmd, ...cargs] = parseBin(CODEGRAPH_BIN);
      const anR = await enqueue(() => run(cmd, [...cargs, 'init', wt.localPath], { cwd: path.dirname(repo.localPath) })); // 入队限流
      wt.status = anR.ok ? 'indexed' : 'failed';
      wt.message = anR.ok ? (anR.out || '').slice(-200) : (anR.err || '').slice(-200);
    } catch (e) {
      wt.status = 'failed'; wt.message = e.message;
    }
    await saveRepos();
    log(`worktree ${repo.name}@${branch} -> ${wt.status}`);
  })();
  return { ready: false, pending: true };
}
export { opEnsureWorktree };

/* ---------------- 索引新鲜度自动刷新（SYNC_HOURS） ---------------- */
async function autoSync() {
  const targets = repos.filter((r) => (r.status === 'indexed' || r.status === 'pull_failed') && r.localPath);
  if (!targets.length) return;
  log(`auto-sync: ${targets.length} 个已索引仓库 git pull + codegraph sync`);
  // 并发 pull（网络型）+ 经队列限流 sync（CPU/IO 型），整体一轮耗时 ~ targets/QUEUE_CONCURRENCY
  await Promise.all(targets.map(async (repo) => {
    try {
      const pull = await run('git', ['-C', repo.localPath, 'pull']);
      if (!pull.ok) log(`sync pull fail ${repo.name}: ${(pull.err || '').slice(-150)}`);
      const [cmd, ...args] = parseBin(CODEGRAPH_BIN);
      const sc = await enqueue(() => run(cmd, [...args, 'sync', repo.localPath], { cwd: settings.cloneBaseDir }));
      log(`sync ${repo.name} -> ${sc.ok ? 'ok' : 'fail ' + (sc.err || '').slice(-150)}`);
    } catch (e) { log(`sync error ${repo.name}: ${e.message}`); }
  }));
}
// 有效同步频率：settings.autoSyncHours（配置页可调）> env SYNC_HOURS > 默认6；0=关闭
function getSyncHours() {
  const s = settings.autoSyncHours;
  if (typeof s === 'number' && s >= 0) return s;
  const e = parseFloat(process.env.SYNC_HOURS || '6');
  return Number.isFinite(e) && e >= 0 ? e : 6;
}
let syncTimer = null;
function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
  const h = getSyncHours();
  if (h > 0) syncTimer = setInterval(autoSync, h * 3600 * 1000);
}
scheduleSync();

/* ---------------- 设置出参脱敏 ---------------- */
const TOKEN_MASK = '••••';
// token 出参一律脱敏（掩码+末4位），绝不返回明文；PUT 回传掩码值会被忽略、不覆盖真实 token
function maskToken(t) { return t ? TOKEN_MASK + String(t).slice(-4) : ''; }
function toSettingsDto(s) { return { ...s, providers: (s.providers || []).map(p => ({ ...p, token: maskToken(p.token) })) }; }

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    let pathname = req.url.split('?')[0];
    const query = Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || ''));
    // BASE_PATH 前缀部署：剥掉前缀后按原路由匹配；前缀外一律 404（未设置时行为不变）
    if (BASE_PATH) {
      if (pathname === BASE_PATH) { res.writeHead(301, { Location: BASE_PATH + '/' }); res.end(); return; }
      if (!pathname.startsWith(BASE_PATH + '/')) return sendJson(res, 404, { error: 'not_found' });
      pathname = pathname.slice(BASE_PATH.length);
    }
    // CORS 预检最先放行（不做鉴权；Allow-Headers 必须含 MCP-Protocol-Version，否则浏览器直连失败）
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }
    // 跨源请求（Origin 与 Host 不符）一律拒绝且不回 CORS 头——防任意网页驱使浏览器打本地服务
    if (!originMatchesHost(req)) {
      log('warn: blocked cross-origin request', req.headers['origin'], req.url);
      return sendJson(res, 401, { error: 'cross_origin_forbidden' });
    }
    // 健康检查（无鉴权，供 systemd/探针/监控）
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true, repos: repos.length, uptime: Math.round(process.uptime()) });
    // MCP 端点（GET /mcp 走 SSE、POST 走消息；/mcp/message 走消息）—— 路由级守卫
    if (pathname === '/mcp' || pathname === '/mcp/message') {
      if (!guardMcp(req, query)) return sendJson(res, 401, { error: 'unauthorized' });
      if (pathname === '/mcp' && req.method === 'GET') return handleSseConnection(req, res);
      return await handleMcpMessage(req, res, repos);
    }
    if (!pathname.startsWith('/api/')) return staticServe(req, res, pathname); // 页面本身公开（否则前端拿不到令牌表单）
    if (!guardAdmin(req)) return sendJson(res, 401, { error: 'unauthorized' });

    // 设置（全局）
    if (pathname === '/api/settings' && req.method === 'GET') return sendJson(res, 200, toSettingsDto(settings));
    if (pathname === '/api/settings' && req.method === 'PUT') {
      const b = await readBody(req);
      // 只更新全局字段，providers 通过专用端点管理
      if (b.cloneBaseDir !== undefined) settings.cloneBaseDir = String(b.cloneBaseDir || '').trim() || CLONE_BASE_DIR_DEFAULT;
      if (b.activeProviderId !== undefined) settings.activeProviderId = b.activeProviderId;
      if (b.autoSyncHours !== undefined) {
        settings.autoSyncHours = (b.autoSyncHours === null || b.autoSyncHours === '') ? null : Number(b.autoSyncHours);
        scheduleSync(); // 频率变更立即重建定时器
      }
      await saveSettings(); return sendJson(res, 200, toSettingsDto(settings));
    }

    // 空间（标签/分组）CRUD
    if (pathname === '/api/spaces' && req.method === 'GET') {
      const sorted = [...settings.spaces].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return sendJson(res, 200, sorted);
    }
    if (pathname === '/api/spaces' && req.method === 'POST') {
      const b = await readBody(req);
      const name = (b.name || '').trim();
      if (!name) return sendJson(res, 400, { error: 'missing name' });
      if (settings.spaces.some(s => s.name === name)) return sendJson(res, 409, { error: 'space exists' });
      const space = { id: crypto.randomUUID(), name, builtin: false, order: (settings.spaces.reduce((m, s) => Math.max(m, s.order ?? 0), 0) + 1) };
      settings.spaces.push(space);
      await saveSettings();
      return sendJson(res, 201, space);
    }
    const spm = pathname.match(/^\/api\/spaces\/([^/]+)$/);
    if (spm) {
      const space = settings.spaces.find(s => s.id === spm[1]);
      if (!space) return sendJson(res, 404, { error: 'no_such_space' });
      if (req.method === 'PUT') {
        const b = await readBody(req);
        if (b.name !== undefined && !space.builtin) space.name = (b.name || '').trim() || space.name;
        if (b.order !== undefined) space.order = Number(b.order);
        await saveSettings();
        return sendJson(res, 200, space);
      }
      if (req.method === 'DELETE') {
        if (space.builtin) return sendJson(res, 400, { error: 'cannot delete builtin space' });
        // 解除所有仓库对该空间的绑定
        for (const r of repos) r.spaceIds = (r.spaceIds || []).filter(id => id !== space.id);
        settings.spaces = settings.spaces.filter(s => s.id !== space.id);
        await saveRepos(); await saveSettings();
        return sendJson(res, 200, { ok: true });
      }
    }
    // 空间 ↔ 仓库绑定
    const spbind = pathname.match(/^\/api\/spaces\/([^/]+)\/repos$/);
    if (spbind && req.method === 'POST') {
      const space = settings.spaces.find(s => s.id === spbind[1]);
      if (!space) return sendJson(res, 404, { error: 'no_such_space' });
      const b = await readBody(req);
      const repoId = b.repoId;
      const repo = repos.find(r => r.id === repoId);
      if (!repo) return sendJson(res, 404, { error: 'no_such_repo' });
      repo.spaceIds = [...new Set([...(repo.spaceIds || []), space.id])];
      await saveRepos();
      return sendJson(res, 200, repo);
    }
    const spunbind = pathname.match(/^\/api\/spaces\/([^/]+)\/repos\/([^/]+)$/);
    if (spunbind && req.method === 'DELETE') {
      const repo = repos.find(r => r.id === spunbind[2]);
      if (!repo) return sendJson(res, 404, { error: 'no_such_repo' });
      repo.spaceIds = (repo.spaceIds || []).filter(id => id !== spunbind[1]);
      await saveRepos();
      return sendJson(res, 200, repo);
    }

    // 提供商 CRUD
    if (pathname === '/api/providers' && req.method === 'GET') {
      // 返回提供商列表（隐藏 token）
      const list = settings.providers.map(p => ({ ...p, token: p.token ? '***' : '' }));
      return sendJson(res, 200, list);
    }
    if (pathname === '/api/providers' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.type || !['gitlab','gitee','github'].includes(b.type)) return sendJson(res, 400, { error: 'invalid provider type' });
      const provider = {
        id: crypto.randomUUID(),
        type: b.type,
        name: b.name || {gitlab:'GitLab',gitee:'Gitee',github:'GitHub'}[b.type],
        url: b.url || '',
        token: b.token || '',
        createdAt: Date.now()
      };
      settings.providers.push(provider);
      if (!settings.activeProviderId) settings.activeProviderId = provider.id;
      await saveSettings();
      return sendJson(res, 201, { ...provider, token: provider.token ? '***' : '' });
    }
    if (pathname.match(/^\/api\/providers\/[^/]+$/) && req.method === 'PUT') {
      const id = pathname.split('/')[3];
      const provider = getProviderById(id);
      if (!provider) return sendJson(res, 404, { error: 'provider not found' });
      const b = await readBody(req);
      if (b.name !== undefined) provider.name = b.name;
      if (b.url !== undefined) provider.url = b.url;
      // 回传脱敏掩码值 → 忽略，不得覆盖真实 token
      if (b.token !== undefined && !String(b.token).startsWith(TOKEN_MASK)) provider.token = b.token;
      await saveSettings();
      return sendJson(res, 200, { ...provider, token: provider.token ? '***' : '' });
    }
    if (pathname.match(/^\/api\/providers\/[^/]+$/) && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      const i = settings.providers.findIndex(p => p.id === id);
      if (i < 0) return sendJson(res, 404, { error: 'provider not found' });
      settings.providers.splice(i, 1);
      if (settings.activeProviderId === id) settings.activeProviderId = settings.providers[0]?.id || '';
      await saveSettings();
      return sendJson(res, 200, { ok: true });
    }

    // 提供商：测试连接
    if (pathname === '/api/providers/check' && req.method === 'POST') {
      const b = await readBody(req);
      const provider = { type: b.type, url: b.url || '', token: b.token || '' };
      if (!provider.type) return sendJson(res, 400, { error: 'missing provider type' });
      if (provider.type !== 'github' && !provider.url) return sendJson(res, 200, { ok: false, msg: '请填写实例 URL' });
      if (!provider.token) return sendJson(res, 200, { ok: false, msg: '请填写 Access Token' });
      const result = await checkProvider(provider);
      return sendJson(res, 200, result);
    }

    // 提供商：搜索项目（支持搜索全部）
    if (pathname === '/api/providers/projects' && req.method === 'GET') {
      try {
        const providerId = query.providerId;
        let projects = [];
        if (providerId === 'all' || !providerId) {
          // 搜索所有已配置的提供商
          const searchPromises = settings.providers.map(async (provider) => {
            try {
              return await searchProjects(query.q, provider.id);
            } catch (e) {
              log(`search error for ${provider.name}:`, e);
              return [];
            }
          });
          const results = await Promise.all(searchPromises);
          projects = results.flat();
        } else {
          projects = await searchProjects(query.q, providerId);
        }
        return sendJson(res, 200, projects);
      } catch (e) { return sendJson(res, 200, { error: e.msg || String(e), status: e.status }); }
    }

    // 仓库注册表
    if (pathname === '/api/repos' && req.method === 'GET') return sendJson(res, 200, repos);
    if (pathname === '/api/repos' && req.method === 'POST') {
      const b = await readBody(req);
      const spaceIds = Array.isArray(b.spaceIds) ? b.spaceIds : (b.spaceId ? [b.spaceId] : []);
      // 去重：同 gitUrl 且已存在 → 仅追加空间绑定关系，不重复注册
      const existing = b.gitUrl && repos.find(r => r.gitUrl === b.gitUrl && r.providerId === (b.providerId || settings.activeProviderId));
      if (existing) {
        const before = (existing.spaceIds || []).slice();
        existing.spaceIds = [...new Set([...(existing.spaceIds || []), ...spaceIds])];
        await saveRepos();
        return sendJson(res, 200, { ...existing, _dedup: true, addedSpaces: existing.spaceIds.filter(id => !before.includes(id)) });
      }
      const id = crypto.randomUUID();
      const repo = { id, name: b.name, providerId: b.providerId || settings.activeProviderId, providerType: b.providerType || '', gitUrl: b.gitUrl, branch: b.branch || '', localPath: null, status: 'registered', message: '', addedAt: Date.now(), worktrees: [], spaceIds };
      repos.push(repo); await saveRepos();
      return sendJson(res, 201, repo);
    }

    // 分支 worktree：GET 列出 / POST 触发创建 / DELETE 删除某分支（异步，返回 pending）
    const wm = pathname.match(/^\/api\/repos\/([^/]+)\/worktree(?:\/([^/]+))?$/);
    if (wm) {
      const repo = findRepo(wm[1]);
      if (!repo) return sendJson(res, 404, { error: 'no_such_repo' });
      if (req.method === 'GET') return sendJson(res, 200, repo.worktrees || []);
      if (req.method === 'POST') {
        const b = await readBody(req);
        const branch = (b.branch || '').trim();
        if (!branch) return sendJson(res, 400, { error: 'missing branch' });
        const result = await opEnsureWorktree(repo, branch);
        return sendJson(res, result.ready ? 200 : 202, { branch, status: (repo.worktrees||[]).find(w=>w.branch===branch)?.status, ...result });
      }
      if (req.method === 'DELETE') {
        const branch = decodeURIComponent(wm[2] || '').trim();
        if (!branch) return sendJson(res, 400, { error: 'missing branch' });
        const wt = (repo.worktrees || []).find((w) => w.branch === branch);
        if (!wt) return sendJson(res, 404, { error: 'no_such_worktree' });
        // 解锁 worktree（解 SQLite db 锁）→ 删目录 → 从列表移除
        if (wt.localPath && fsSync.existsSync(wt.localPath)) {
          await run('git', ['worktree', 'remove', '--force', wt.localPath], { cwd: repo.localPath }).catch(()=>{});
          await fs.rm(wt.localPath, { recursive: true, force: true }).catch(()=>{});
          await fs.rm(path.join(repo.localPath, '.git', 'worktrees', sanitize(branch)), { recursive: true, force: true }).catch(()=>{});
        }
        repo.worktrees = (repo.worktrees || []).filter((w) => w.branch !== branch);
        await saveRepos();
        return sendJson(res, 200, { ok: true, branch });
      }
    }

    // 添加本地仓库
        if (pathname === '/api/repos/local' && req.method === 'POST') {
          const b = await readBody(req);
          const localPath = (b.path || '').trim();
          if (!localPath) return sendJson(res, 400, { error: 'missing path' });
      
          // 检查目录是否存在
          try { await fs.access(localPath); } catch { return sendJson(res, 400, { error: 'directory not found' }); }
      
          // 检查是否是 git 仓库
          const gitDir = path.join(localPath, '.git');
          try { await fs.access(gitDir); } catch { return sendJson(res, 400, { error: 'not a git repository (no .git directory)' }); }
      
          // 获取仓库信息
          let name = b.name || path.basename(localPath);
          let gitUrl = '';
          let branch = '';
      
          try {
            // 尝试获取 remote origin URL
            const remoteResult = await run('git', ['remote', 'get-url', 'origin'], { cwd: localPath });
            if (remoteResult.ok) gitUrl = remoteResult.out.trim();
          } catch {}
      
          try {
            // 尝试获取当前分支
            const branchResult = await run('git', ['branch', '--show-current'], { cwd: localPath });
            if (branchResult.ok) branch = branchResult.out.trim();
          } catch {}
      
          const id = crypto.randomUUID();
          const repo = {
            id, name, providerId: '', providerType: 'local',
            gitUrl, branch, localPath, status: 'cloned', message: 'Added from local directory',
            addedAt: Date.now()
          };
          repos.push(repo); await saveRepos();
          return sendJson(res, 201, repo);
        }

        // 浏览服务器目录
        if (pathname === '/api/browse' && req.method === 'GET') {
          const browsePath = (query.path || '').trim() || '/';
          try {
            const entries = await fs.readdir(browsePath, { withFileTypes: true });
            const dirs = [];
            for (const entry of entries) {
              if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const fullPath = path.join(browsePath, entry.name);
                let isGitRepo = false;
                try {
                  await fs.access(path.join(fullPath, '.git'));
                  isGitRepo = true;
                } catch {}
                dirs.push({ name: entry.name, path: fullPath, isGitRepo });
              }
            }
            // 按名称排序，git 仓库优先
            dirs.sort((a, b) => {
              if (a.isGitRepo && !b.isGitRepo) return -1;
              if (!a.isGitRepo && b.isGitRepo) return 1;
              return a.name.localeCompare(b.name);
            });
            return sendJson(res, 200, { path: browsePath, entries: dirs });
          } catch (e) {
            return sendJson(res, 400, { error: 'cannot read directory: ' + e.message });
          }
        }

    // 单仓操作
    const m = pathname.match(/^\/api\/repos\/([^/]+)\/(clone|analyze|status|remove|sync)$/);
    if (m) {
      const repo = findRepo(m[1]);
      if (!repo) return sendJson(res, 404, { error: 'no_such_repo' });
      const action = m[2];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write(JSON.stringify({ ok: true, msg: 'started' }));
      res.end();
      try {
        let ok = false;
        if (action === 'clone') ok = await opClone(repo);
        else if (action === 'analyze') ok = await opAnalyze(repo);
        else if (action === 'status') ok = await opStatus(repo);
        else if (action === 'sync') ok = await opSync(repo);
        else if (action === 'remove') { await opRemove(repo); return; }
        log(`repo ${repo.name} ${action} -> ${ok ? 'ok' : 'fail'}`);
      } catch (e) { log('op error', e); }
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (e) {
    if (e.statusCode === 413) { log('request body too large'); if (!res.headersSent) sendJson(res, 413, { error: 'payload_too_large' }); return; }
    log('req error', e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e) });
  }
});

await loadAll();
// fail closed 兜底：令牌引导失败（auth.json 不可写等）导致完全无令牌且对外监听 → 拒绝启动
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
if (!LOOPBACK_HOSTS.includes(HOST) && !ADMIN_TOKEN && !MCP_TOKEN) {
  console.error(`[cgm] 拒绝启动：HOST=${HOST} 是对外监听，必须配置 ADMIN_TOKEN 或 MCP_TOKEN（否则局域网内任何人可操作仓库与代码）。本地开发请保持 HOST=127.0.0.1。`);
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  log(`CodeGraph Manager on http://${HOST}:${PORT}`);
  log(`data dir: ${DATA_DIR}`);
  log(`codegraph bin: ${CODEGRAPH_BIN}`);
  if (BOOTSTRAP_TOKEN.generated) {
    log(`首次启动已生成默认访问令牌（已持久化到 ${BOOTSTRAP_TOKEN.file}）：${ADMIN_TOKEN}`);
    log('远程/局域网访问请携带该令牌：Authorization: Bearer <token>，或在界面令牌框输入；本机回环访问默认免鉴权');
  }
  log(`auth: admin_token=${ADMIN_TOKEN ? (BOOTSTRAP_TOKEN.generated ? 'on(自动生成,见 auth.json)' : 'on') : 'off'}, mcp_token=${process.env.MCP_TOKEN ? 'on' : 'off(回落 ADMIN_TOKEN)'}, local_no_auth=${LOCAL_NO_AUTH ? 'on(回环免鉴权)' : 'off(本地也需令牌)'}, base_path=${BASE_PATH || '(none)'}, max_body=${MAX_BODY_BYTES}B`);
  log(`providers: ${settings.providers.length} configured`);
});