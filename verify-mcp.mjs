// verify-mcp.mjs — MCP 协议合规 + 鉴权/安全回归脚本（ad-hoc，CI 可用）
//
// 用法：node verify-mcp.mjs        （默认自起临时实例，端口 8872；临时 DATA_DIR，不碰真实数据）
// 覆盖三部分：
//   A. MCP 协议合规（默认实例，回环免鉴权）：initialize/serverInfo、notifications 202、ping result{}、
//      tools/list、CORS 预检 204 + Allow-Headers 含 MCP-Protocol-Version。
//   B. 鉴权与安全（独立实例 LOCAL_NO_AUTH=0 + ADMIN_TOKEN）：未授权 401、Bearer 200、
//      settings/providers token 脱敏且 PUT 掩码不覆盖、双 SSE 客户端隔离、请求体超限 413、
//      跨源 Origin 401 且不回 ACAO。
//   C. 默认令牌与并发互斥：HOST=0.0.0.0 无 env → 首启自动生成令牌（auth.json）正常启动；
//      同仓 analyze+remove 并发 → 仓锁串行，不交叉、注册表不损坏。
//   不依赖 codegraph（search_code 只测参数校验路径；并发测试用本地 git fixture，codegraph 缺失时 analyze 快速失败，不影响断言）。
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.tmpdir(), 'cgm-verify-' + Date.now());
const PORT = parseInt(process.env.VERIFY_PORT || '8872', 10);
const PORT_AUTH = PORT + 1, PORT_EXPOSED = PORT + 2;
let fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} | ${n}${x ? ' | ' + x : ''}`); if (!c) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(env) {
  const c = spawn(process.execPath, [path.resolve('server.mjs')], { cwd: path.resolve('.'), env: { ...process.env, ...env } });
  c.stdout.on('data', () => {}); c.stderr.on('data', () => {});
  return c;
}
async function waitReady(base) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + '/mcp', { method: 'OPTIONS' }); if (r.status < 500) return true; } catch {}
    await sleep(200);
  }
  return false;
}
const postJson = (url, obj, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(obj) });
// SSE 收集器：连接 /mcp 并持续累积流文本，stop() 断开
async function sseCollect(base) {
  const ctrl = new AbortController();
  const res = await fetch(base + '/mcp', { signal: ctrl.signal });
  let text = '';
  (async () => { try { const dec = new TextDecoder(); const reader = res.body.getReader(); while (true) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); } } catch {} })();
  return { stop: () => ctrl.abort(), text: () => text };
}

async function main() {
  /* ---------- 实例 A：默认回环免鉴权（协议 + 脱敏 + SSE 隔离 + 413 + 并发互斥） ---------- */
  const DATA = path.join(ROOT, 'data');
  const sA = startServer({ PORT: String(PORT), DATA_DIR: DATA });
  const B = `http://127.0.0.1:${PORT}/mcp`;
  const H = `http://127.0.0.1:${PORT}`;
  check('服务启动并监听 /mcp', await waitReady(B));

  // 1) CORS 预检（浏览器直连 Inspector 的关键）
  const opt = await fetch(B, {
    method: 'OPTIONS',
    headers: { Origin: `http://localhost:${PORT}`, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,mcp-protocol-version,authorization' },
  });
  check('OPTIONS 预检 204', opt.status === 204, 'status=' + opt.status);
  check('CORS Allow-Origin *', opt.headers.get('access-control-allow-origin') === '*');
  check('CORS Allow-Headers 含 MCP-Protocol-Version', /mcp-protocol-version/i.test(opt.headers.get('access-control-allow-headers') || ''));

  // 2) 握手
  const init = await postJson(B, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } });
  const initBody = await init.json();
  check('initialize → 200', init.status === 200);
  check('initialize 含 serverInfo', initBody.result?.serverInfo?.name === 'codegraph-manager');
  check('initialize 协议版本 2024-11-05', initBody.result?.protocolVersion === '2024-11-05');

  // 3) 通知（规范：202，非404）
  const notif = await postJson(B, { jsonrpc: '2.0', method: 'notifications/initialized' });
  check('notifications/initialized → 202', notif.status === 202, 'status=' + notif.status);

  // 4) 心跳（规范：result{}, 非404）
  const ping = await postJson(B, { jsonrpc: '2.0', id: 2, method: 'ping' });
  const pingBody = await ping.json();
  check('ping → 200', ping.status === 200);
  check('ping → result:{}', JSON.stringify(pingBody.result) === '{}');

  // 5) 工具（search_code 只测参数校验路径，不 spawn codegraph）
  const tools = await postJson(B, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  const toolsBody = await tools.json();
  const names = (toolsBody.result?.tools || []).map((t) => t.name);
  check('tools/list → 4 工具', names.length === 4, names.join(','));
  ['query_repository', 'list_repositories', 'search_repositories', 'search_code'].forEach((t) => check('含工具 ' + t, names.includes(t)));

  const call = await postJson(B, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_code', arguments: {} } });
  const callBody = await call.json();
  check('search_code 无 query → 友好提示', (callBody.result?.content?.[0]?.text || '').includes('请提供检索语句'));
  check('search_code 缺参 → isError', callBody.result?.isError === true);

  // 6) 跨源请求拒绝：非同源 Origin → 401 且不回 Access-Control-Allow-Origin
  const xorigin = await fetch(H + '/api/repos', { headers: { Origin: 'http://evil.example.com' } });
  check('跨源 Origin → 401', xorigin.status === 401, 'status=' + xorigin.status);
  check('跨源响应不回 ACAO', !xorigin.headers.get('access-control-allow-origin'));

  // 7) settings/providers token 脱敏 + PUT 掩码不覆盖
  const SECRET = 'ghp_verify_secret_abcd1234';
  const addP = await postJson(H + '/api/providers', { type: 'github', name: 'verify-gh', token: SECRET });
  check('添加 provider → 201', addP.status === 201, 'status=' + addP.status);
  const pid = (await addP.json()).id;
  const sDto = await (await fetch(H + '/api/settings')).json();
  check('GET /api/settings 不含 token 明文', !JSON.stringify(sDto).includes(SECRET));
  check('GET /api/settings 掩码+末4位', (sDto.providers || []).some((p) => String(p.token).endsWith('1234') && String(p.token).includes('••••')));
  const provs = await (await fetch(H + '/api/providers')).json();
  check('GET /api/providers token → ***', provs.find((p) => p.id === pid)?.token === '***');
  await fetch(H + '/api/providers/' + pid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'renamed', token: '••••1234' }) });
  const raw = await fs.readFile(path.join(DATA, 'settings.json'), 'utf8');
  check('PUT 掩码不覆盖真实 token（落盘仍加密非掩码）', !raw.includes('••••1234') && !raw.includes(SECRET) && raw.includes('"enc:'));

  // 8) 双 SSE 客户端隔离：工具结果只经 HTTP 返回发起方，SSE 流不出现 event: message
  const sseA = await sseCollect(H), sseB = await sseCollect(H);
  await sleep(300);
  const tc = await postJson(B, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_repositories', arguments: {} } });
  check('tools/call(list_repositories) → 200', tc.status === 200);
  await sleep(800); sseA.stop(); sseB.stop();
  check('SSE-A 未收到 event: message', !sseA.text().includes('event: message'));
  check('SSE-B 未收到 event: message', !sseB.text().includes('event: message'));

  // 9) 请求体超限 → 413
  const big = await postJson(B, { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {}, pad: 'x'.repeat(1024 * 1024 + 1024) });
  check('超限请求体 → 413', big.status === 413, 'status=' + big.status);

  // 10) 同仓 analyze+remove 并发 → 仓锁串行，注册表最终一致
  const fx = path.join(ROOT, 'fixture-repo');
  await fs.mkdir(fx, { recursive: true });
  const g = (args) => spawnSync('git', args, { cwd: fx });
  g(['init', '-b', 'main']);
  await fs.writeFile(path.join(fx, 'a.js'), 'const a=1;\n');
  g(['add', '-A']); g(['-c', 'user.name=v', '-c', 'user.email=v@v', 'commit', '-m', 'init']);
  const addR = await postJson(H + '/api/repos/local', { path: fx, name: 'verify-fixture' });
  const fid = (await addR.json()).id;
  check('注册本地 fixture 仓库 → 201', addR.status === 201, 'status=' + addR.status);
  const [op1, op2] = await Promise.all([
    fetch(`${H}/api/repos/${fid}/analyze`, { method: 'POST' }),
    fetch(`${H}/api/repos/${fid}/remove`, { method: 'POST' }),
  ]);
  check('并发 analyze/remove 均受理 → 200', op1.status === 200 && op2.status === 200);
  let removed = false;
  for (let i = 0; i < 80 && !removed; i++) { const list = await (await fetch(H + '/api/repos')).json(); removed = !list.some((r) => r.id === fid); if (!removed) await sleep(300); }
  check('并发操作后仓库最终被移除（串行完成，无交叉卡死）', removed);
  const hz = await (await fetch(H + '/healthz')).json();
  check('并发操作后 healthz 正常', hz.ok === true);
  let jsonOk = true; try { JSON.parse(await fs.readFile(path.join(DATA, 'repos.json'), 'utf8')); } catch { jsonOk = false; }
  check('repos.json 未损坏（原子写）', jsonOk);
  sA.kill('SIGTERM');

  /* ---------- 实例 B：LOCAL_NO_AUTH=0 + ADMIN_TOKEN（鉴权强制） ---------- */
  const TOKEN = 'verify-admin-token-xyz';
  const sB = startServer({ PORT: String(PORT_AUTH), DATA_DIR: path.join(ROOT, 'data-auth'), LOCAL_NO_AUTH: '0', ADMIN_TOKEN: TOKEN });
  const BA = `http://127.0.0.1:${PORT_AUTH}`;
  check('鉴权实例启动', await waitReady(BA + '/mcp'));
  const a401 = await postJson(BA + '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  check('无 token tools/list → 401', a401.status === 401, 'status=' + a401.status);
  const api401 = await fetch(BA + '/api/repos');
  check('无 token /api/repos → 401', api401.status === 401, 'status=' + api401.status);
  const auth = { Authorization: 'Bearer ' + TOKEN };
  const a200 = await postJson(BA + '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, auth);
  check('带 Bearer tools/list → 200', a200.status === 200, 'status=' + a200.status);
  const aInit = await postJson(BA + '/mcp', { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } }, auth);
  check('带 Bearer initialize → 200 + serverInfo', aInit.status === 200 && (await aInit.json()).result?.serverInfo?.name === 'codegraph-manager');
  const aNotif = await postJson(BA + '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
  check('带 Bearer notifications → 202', aNotif.status === 202, 'status=' + aNotif.status);
  const api200 = await fetch(BA + '/api/repos', { headers: auth });
  check('带 Bearer /api/repos → 200', api200.status === 200, 'status=' + api200.status);
  sB.kill('SIGTERM');

  /* ---------- 实例 C：HOST=0.0.0.0 无 env → 自动生成令牌，正常启动 ---------- */
  const DATA3 = path.join(ROOT, 'data-exposed');
  const sC = startServer({ PORT: String(PORT_EXPOSED), DATA_DIR: DATA3, HOST: '0.0.0.0' });
  check('对外监听（无 env）可启动（自动令牌兜底）', await waitReady(`http://127.0.0.1:${PORT_EXPOSED}/mcp`));
  let authJson = null; try { authJson = JSON.parse(await fs.readFile(path.join(DATA3, 'auth.json'), 'utf8')); } catch {}
  check('auth.json 已生成随机令牌', typeof authJson?.adminToken === 'string' && authJson.adminToken.length >= 24);
  check('对外实例 healthz → 200', (await fetch(`http://127.0.0.1:${PORT_EXPOSED}/healthz`)).status === 200);
  sC.kill('SIGTERM');

  console.log(`\n==== verify-mcp：${fail === 0 ? 'ALL PASS ✅' : fail + ' FAIL ❌'} ====`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('VERIFY ERROR', e.message); process.exit(1); }).finally(async () => {
  try { await fs.rm(ROOT, { recursive: true, force: true }); } catch {}
});
