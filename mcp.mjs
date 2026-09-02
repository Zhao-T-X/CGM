// CodeGraph Manager —— MCP 服务器模块
// 提供 MCP (Model Context Protocol) 支持，让 AI agent 能查询仓库名到 projectPath 的映射
//
// MCP 工具：
//   query_repository - 根据仓库名查询本地路径和状态
//   list_repositories - 列出所有已注册仓库
//   search_repositories - 模糊搜索仓库名
//   search_code - 检索代码（网关：repo→projectPath 映射后调用 codegraph 原生 MCP）
//
// 传输：SSE (Server-Sent Events) + HTTP POST

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { parseBin } from './server.mjs';

// MCP 工具定义
const MCP_TOOLS = [
  {
    name: 'query_repository',
    description: '根据仓库名查询本地路径(projectPath)和状态。支持精确匹配和模糊搜索。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '仓库名（支持模糊匹配，如 "tineco-nmp" 或 "ibu/aftersales"）'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'list_repositories',
    description: '列出所有已注册的仓库，包含名称、本地路径、状态和提供商信息。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: '按状态过滤（可选）：registered, cloning, cloned, indexing, indexed, failed',
          enum: ['registered', 'cloning', 'cloned', 'indexing', 'indexed', 'failed']
        }
      }
    }
  },
  {
    name: 'search_repositories',
    description: '模糊搜索仓库名，返回匹配的仓库列表。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（模糊匹配仓库名）'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'search_code',
    description: '检索代码（网关）。指定仓库名和查询语句，内部调用 codegraph 的知识图谱检索符号/文件/调用关系。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索语句：符号名、文件名或短代码术语（如 "AuthService loginUser"、"GraphTraverser impact"）'
        },
        repo: {
          type: 'string',
          description: '仓库名（精确或模糊，如 "tineco-nmp" 或 "ibu/aftersales"）。省略时自动用第一个已注册仓库。'
        },
        maxFiles: {
          type: 'number',
          description: '最多返回文件数（默认 12）'
        }
      },
      required: ['query']
    }
  }
];

// SSE 连接管理
const sseClients = new Set();

// 发送 SSE 事件
function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// 处理 SSE 连接
export function handleSseConnection(req, res) {
  // 设置 SSE 头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID'
  });

  // 发送初始连接事件
  sendSseEvent(res, 'endpoint', { endpoint: '/mcp/message' });

  // 添加到客户端列表
  sseClients.add(res);

  // 心跳
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // 清理
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

// 处理 MCP 消息（通过 POST）
export async function handleMcpMessage(req, res, repos) {
  // 设置 CORS 头（需允许 MCP 协议头，否则浏览器直连预检失败）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // 读取请求体
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  
  let request;
  try {
    request = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
    return;
  }

  const { jsonrpc, method, params, id } = request;

  // 验证 JSON-RPC 版本
  if (jsonrpc !== '2.0') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id }));
    return;
  }

  // 通知类消息（notifications/*）：按 MCP/JSON-RPC 规范，无 id、不应有响应体，返回 202
  if (method.startsWith('notifications/')) {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end();
    return;
  }

  let result;

  switch (method) {
    case 'ping':
      result = {};
      break;

    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'codegraph-manager',
          version: '1.0.0'
        }
      };
      break;

    case 'tools/list':
      result = { tools: MCP_TOOLS };
      break;

    case 'tools/call':
      result = await handleToolCall(params, repos);
      break;

    default:
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id }));
      return;
  }

  // 发送响应
  const response = { jsonrpc: '2.0', result, id };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));

  // 同时通过 SSE 广播给所有连接的客户端
  for (const client of sseClients) {
    try {
      sendSseEvent(client, 'message', response);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

// ── codegraph MCP 网关客户端（stdio）──────────────────────────────
// 单例子进程：懒加载 + 崩溃自动重建。search_code 通过它调用 codegraph 原生 MCP。
// (parseBin 从 server.mjs 共享)

let cgProc = null; // { child, rl, pending, id, ready }

function getCgProc() {
  if (cgProc && cgProc.child.exitCode === null && !cgProc.closed) return cgProc;
  const [cmd, ...args] = parseBin(process.env.CODEGRAPH_BIN || 'codegraph');
  const child = spawn(cmd, [...args, 'serve', '--mcp', '--no-watch'], {
    env: { ...process.env, CODEGRAPH_MCP_TOOLS: 'explore,node,search,callers,callees,impact,files,status' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const cg = { child, rl, pending: new Map(), id: 0, ready: false, closed: false };
  rl.on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id && cg.pending.has(msg.id)) {
      const { resolve, reject, timer } = cg.pending.get(msg.id);
      cg.pending.delete(msg.id); clearTimeout(timer);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  child.on('exit', () => {
    cg.closed = true;
    for (const { reject, timer } of cg.pending.values()) { clearTimeout(timer); reject(new Error('codegraph 子进程已退出')); }
    cg.pending.clear();
  });
  child.stderr.on('data', () => {}); // 静默，错误通过 JSON-RPC error 返回
  cgProc = cg;
  return cg;
}

function cgSend(method, params = {}, timeoutMs = 30000) {
  const cg = getCgProc();
  const id = ++cg.id;
  cg.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cg.pending.delete(id);
      reject(new Error(`codegraph 响应超时(${timeoutMs / 1000}s): ${method}`));
    }, timeoutMs);
    cg.pending.set(id, { resolve, reject, timer });
  });
}

async function cgReady() {
  const cg = getCgProc();
  if (cg.ready) return cg;
  await cgSend('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codegraph-manager', version: '1.0.0' } });
  cg.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  cg.ready = true;
  return cg;
}

async function cgCallTool(name, args, timeoutMs = 30000) {
  await cgReady();
  const res = await cgSend('tools/call', { name, arguments: args }, timeoutMs);
  const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, isError: !!res.isError };
}

// 仓库匹配：精确 → 模糊 → 多匹配列表
function findRepo(repos, name) {
  const q = name.toLowerCase();
  const exact = repos.find((r) => r.name.toLowerCase() === q);
  if (exact) return { repo: exact };
  const matches = repos.filter((r) => r.name.toLowerCase().includes(q) || (r.gitUrl || '').toLowerCase().includes(q));
  if (matches.length === 1) return { repo: matches[0] };
  if (matches.length > 1) return { multiple: matches.map((r) => r.name) };
  return null;
}

// 处理工具调用
async function handleToolCall(params, repos) {
  const { name, arguments: args } = params;

  switch (name) {
    case 'query_repository': {
      const queryName = (args?.name || '').toLowerCase();
      if (!queryName) {
        return { content: [{ type: 'text', text: '错误：请提供仓库名' }], isError: true };
      }

      // 精确匹配
      let repo = repos.find(r => r.name.toLowerCase() === queryName);
      
      // 模糊匹配
      if (!repo) {
        const matches = repos.filter(r => 
          r.name.toLowerCase().includes(queryName) ||
          (r.gitUrl || '').toLowerCase().includes(queryName)
        );
        
        if (matches.length === 0) {
          return {
            content: [{ type: 'text', text: `未找到匹配 "${args.name}" 的仓库` }],
            isError: false
          };
        }
        
        if (matches.length === 1) {
          repo = matches[0];
        } else {
          // 多个匹配，返回列表
          const list = matches.map(r => 
            `- ${r.name} → ${r.localPath || '未克隆'} (${r.status})`
          ).join('\n');
          return {
            content: [{ type: 'text', text: `找到 ${matches.length} 个匹配仓库：\n${list}` }],
            isError: false
          };
        }
      }

      // 返回单个仓库信息
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            name: repo.name,
            projectPath: repo.localPath || null,
            status: repo.status,
            provider: repo.providerType || 'unknown',
            gitUrl: repo.gitUrl || null,
            branch: repo.branch || null
          }, null, 2)
        }],
        isError: false
      };
    }

    case 'list_repositories': {
      const statusFilter = args?.status;
      let filtered = repos;
      
      if (statusFilter) {
        filtered = repos.filter(r => r.status === statusFilter);
      }

      if (filtered.length === 0) {
        return {
          content: [{ type: 'text', text: statusFilter ? `没有状态为 "${statusFilter}" 的仓库` : '没有注册的仓库' }],
          isError: false
        };
      }

      const list = filtered.map(r => 
        `- ${r.name}\n  路径: ${r.localPath || '未克隆'}\n  状态: ${r.status}\n  提供商: ${r.providerType || 'unknown'}`
      ).join('\n\n');

      return {
        content: [{ type: 'text', text: `共 ${filtered.length} 个仓库：\n\n${list}` }],
        isError: false
      };
    }

    case 'search_repositories': {
      const query = (args?.query || '').toLowerCase();
      if (!query) {
        return { content: [{ type: 'text', text: '错误：请提供搜索关键词' }], isError: true };
      }

      const matches = repos.filter(r => 
        r.name.toLowerCase().includes(query) ||
        (r.gitUrl || '').toLowerCase().includes(query) ||
        (r.localPath || '').toLowerCase().includes(query)
      );

      if (matches.length === 0) {
        return {
          content: [{ type: 'text', text: `未找到匹配 "${args.query}" 的仓库` }],
          isError: false
        };
      }

      const list = matches.map(r => 
        `- ${r.name} → ${r.localPath || '未克隆'} (${r.status})`
      ).join('\n');

      return {
        content: [{ type: 'text', text: `找到 ${matches.length} 个匹配仓库：\n${list}` }],
        isError: false
      };
    }

    case 'search_code': {
      const query = (args?.query || '').trim();
      if (!query) return { content: [{ type: 'text', text: '错误：请提供检索语句 query' }], isError: true };

      // 单仓模式（指定 repo）：完整深度分析（原逻辑，格式不变）
      if (args?.repo) {
        const hit = findRepo(repos, args.repo);
        if (!hit) return { content: [{ type: 'text', text: `未找到匹配 "${args.repo}" 的仓库` }], isError: false };
        if (hit.multiple) return { content: [{ type: 'text', text: `匹配到多个仓库：${hit.multiple.join(', ')}，请用完整仓库名重试` }], isError: false };
        const target = hit.repo;
        if (!target.localPath) return { content: [{ type: 'text', text: `仓库 "${target.name}" 尚未克隆（状态: ${target.status}）` }], isError: false };
        try {
          const { text, isError } = await cgCallTool('codegraph_explore', { query, projectPath: target.localPath, maxFiles: args?.maxFiles ?? 12 });
          const header = `[${target.name}] ${query}\n`;
          return { content: [{ type: 'text', text: text ? header + text : header + '（无结果）' }], isError };
        } catch (e) {
          return { content: [{ type: 'text', text: `检索失败: ${e.message}` }], isError: true };
        }
      }

      // 跨仓模式（缺省 repo）：定位所有已索引仓库——收敛防爆（每仓小 maxFiles + 截断 + 总量 cap）
      const targets = repos.filter((r) => r.status === 'indexed' && r.localPath); // 空仓/未索引跳过
      if (!targets.length) return { content: [{ type: 'text', text: '没有可检索的已索引仓库，请先克隆并分析' }], isError: false };
      const crossMaxFiles = args?.maxFiles ?? 8;
      const settled = await Promise.allSettled(targets.map((t) =>
        cgCallTool('codegraph_explore', { query, projectPath: t.localPath, maxFiles: crossMaxFiles }, 15000)
      ));
      const rows = settled.map((s, i) => {
        const name = targets[i].name;
        if (s.status === 'rejected') return { name, hit: -1, text: `[${name}] 检索失败: ${s.reason.message}` };
        const text = s.value.text;
        const m = text.match(/Found (\d+) symbols?/i); // codegraph 稳定格式, 仅取数字做排序
        const hit = m ? parseInt(m[1], 10) : 0;
        return { name, hit, text };
      }).sort((a, b) => b.hit - a.hit); // 命中多的排前（最相关优先）
      const hitRows = rows.filter((r) => r.hit > 0);
      const summary = hitRows.length
        ? `命中概况：${hitRows.map((r) => `${r.name}(${r.hit})`).join('、')}；${rows.length - hitRows.length} 个仓库无命中`
        : `${rows.length} 个仓库均无命中`;
      const parts = rows.map((r) => r.hit < 0 ? r.text : `[${r.name}]\n${r.text.slice(0, 400)}`); // 每仓收敛 400 字符
      let joined = summary + '\n\n' + parts.join('\n\n');
      if (joined.length > 4000) joined = joined.slice(0, 4000) + '\n...命中过多，请用 repo=<仓库名> 单仓深入';
      return { content: [{ type: 'text', text: joined }], isError: false };
    }

    default:
      return {
        content: [{ type: 'text', text: `未知工具: ${name}` }],
        isError: true
      };
  }
}

// 导出工具定义供主服务器使用
export { MCP_TOOLS };
