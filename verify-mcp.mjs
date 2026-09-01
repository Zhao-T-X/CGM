// verify-mcp.mjs — MCP 协议合规回归脚本（ad-hoc，CI 可用）
//
// 用法：node verify-mcp.mjs        （默认自起临时实例，端口 8872）
// 说明：验证 server.mjs 的 /mcp 端点符合 MCP 规范（这是 MCP Inspector/官方 SDK 能连的前提）：
//   initialize → 200 + serverInfo；notifications/* → 202（非404）；ping → result{}（非404）；
//   tools/list → 4 工具；CORS 预检 204 + Allow-Headers 含 MCP-Protocol-Version；OPTIONS 放行。
//   不依赖 codegraph（search_code 网关需 codegraph，这里只测其参数校验路径，不 spawn 子进程）。
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.tmpdir(), 'cgm-verify-' + Date.now());
const DATA = path.join(ROOT, 'data');
const PORT = parseInt(process.env.VERIFY_PORT || '8872', 10);
const B = `http://127.0.0.1:${PORT}/mcp`;
let fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} | ${n}${x ? ' | ' + x : ''}`); if (!c) fail++; };

const srv = spawn(process.execPath, [path.resolve('server.mjs')], {
  cwd: path.resolve('.'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', () => {});
srv.on('exit', () => {});

const post = (obj) => fetch(B, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(B, { method: 'OPTIONS' }); if (r.status < 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  check('服务启动并监听 /mcp', await waitReady());

  // 1) CORS 预检（浏览器直连 Inspector 的关键）
  const opt = await fetch(B, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:6274',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,mcp-protocol-version,authorization',
    },
  });
  check('OPTIONS 预检 204', opt.status === 204, 'status=' + opt.status);
  check('CORS Allow-Origin *', opt.headers.get('access-control-allow-origin') === '*');
  check('CORS Allow-Headers 含 MCP-Protocol-Version', /mcp-protocol-version/i.test(opt.headers.get('access-control-allow-headers') || ''));

  // 2) 握手
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } } });
  const initBody = await init.json();
  check('initialize → 200', init.status === 200);
  check('initialize 含 serverInfo', initBody.result?.serverInfo?.name === 'codegraph-manager');
  check('initialize 协议版本 2024-11-05', initBody.result?.protocolVersion === '2024-11-05');

  // 3) 通知（规范：202，非404）—— MCP Inspector/官方 SDK 依赖
  const notif = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('notifications/initialized → 202', notif.status === 202, 'status=' + notif.status);

  // 4) 心跳（规范：result{}, 非404）
  const ping = await post({ jsonrpc: '2.0', id: 2, method: 'ping' });
  const pingBody = await ping.json();
  check('ping → 200', ping.status === 200);
  check('ping → result:{}', JSON.stringify(pingBody.result) === '{}');

  // 5) 工具（search_code 只测参数校验路径，不 spawn codegraph）
  const tools = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  const toolsBody = await tools.json();
  const names = (toolsBody.result?.tools || []).map((t) => t.name);
  check('tools/list → 4 工具', names.length === 4, names.join(','));
  ['query_repository', 'list_repositories', 'search_repositories', 'search_code'].forEach((t) => check('含工具 ' + t, names.includes(t)));

  const call = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_code', arguments: {} } });
  const callBody = await call.json();
  check('search_code 无 query → 友好提示', (callBody.result?.content?.[0]?.text || '').includes('请提供检索语句'));
  check('search_code 缺参 → isError', callBody.result?.isError === true);

  console.log(`\n==== verify-mcp：${fail === 0 ? 'ALL PASS ✅' : fail + ' FAIL ❌'} ====`);
  srv.kill('SIGTERM');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error('VERIFY ERROR', e.message); try { srv.kill('SIGTERM'); } catch {} process.exit(1); });