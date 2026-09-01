# AGENTS.md — 给 AI 编码助手的项目说明

代码索引管理服务：多 Git 平台仓库统一管理 + CodeGraph 代码知识图谱 + MCP 接口供 AI 检索代码。

> 本文件对 Hermes / Cursor / Claude Code / Codex 等 AI 助手生效（cwd-only，可移植）。

## 项目是什么

- 后端 `server.mjs`：零依赖 Node HTTP 服务（仅用内置 `http`/`https`/`fetch`/`child_process`/`crypto`），无数据库，数据存 JSON 文件
- 前端 `public/index.html`：单文件 Vercel 风深色 UI（原生 JS，不引 CDN）
- `mcp.mjs`：MCP 服务器模块（Streamable HTTP + JSON-RPC 2.0），内含 **CodeGraph stdio MCP 网关客户端**
- 管理仓库的 clone → analyze(codegraph) → status → remove 全流程，支持 GitLab/Gitee/GitHub 多提供商

## 启动

```bash
# Linux
PORT=8801 DATA_DIR=/srv/cgm-data CODEGRAPH_BIN=codegraph node server.mjs

# Windows （CODEGRAPH_BIN 必须 JSON 数组——全局安装是 bash shim）
env PORT=8801 DATA_DIR="E:/workspace/cgm-data" \
  CODEGRAPH_BIN='["node","D:/Program Files/nodejs/node_modules/@colbymchenry/codegraph/npm-shim.js"]' \
  node server.mjs
```

- 默认监听 `127.0.0.1:8801`，界面 http://127.0.0.1:8801，MCP 端点在 `/mcp`
- 后台/常驻方式：`terminal(background=true)`（Hermes）或 systemd（见 DEPLOY-Linux.md）

## 验证（改代码后必做）

MCP/后端改动用**独立实例结构冒烟**（不要污染真实 `DATA_DIR`）：

```js
// 临时 DATA_DIR + 独立端口，spawn server.mjs 后 curl /mcp 断言
const DATA = path.join(os.tmpdir(), 'hermes-verify-xxx-' + Date.now());
const PORT = 887_+;  // 用非 8801 的端口
```

- MCP 协议合规断言（关键，MCP Inspector 依赖）：
  - `initialize` → 200 + serverInfo
  - `notifications/initialized` → **202**（不是 404）
  - `ping` → 200 + `result:{}`（不是 404）
  - `tools/list` / `tools/call` → 200
  - CORS 预检 `OPTIONS` → 204 且 `Access-Control-Allow-Headers` **必须含** `MCP-Protocol-Version`（否则浏览器直连 Failed to fetch）
- 验证脚本放 Temp 目录、`hermes-verify-` 前缀、跑完清理

## 代码约定

- **零依赖铁律**：不引任何 npm 包（除用户全局装的 codegraph）。新功能只用 Node 内置模块
- **KISS**：能删/压缩/归位就做，不写多余代码
- **token 安全**：数据在 `DATA_DIR/<settings.json>`，含真实提供商 token；`.gitignore` 已排除 `data/`
- `CODEGRAPH_BIN` 用 `parseBin()` 解析（支持 JSON 数组 → `["node", "...npm-shim.js"]`）
- 前端 Vercel 风：`#000` 底 / `#fafafa` 字 / `#3b82f6` accent

## MCP 工具（mcp.mjs）

- `query_repository(name)` / `list_repositories(status?)` / `search_repositories(query)`
- `search_code(query, repo?, maxFiles?)` —— repo→localPath(projectPath) 映射后经 **stdio 单例子进程**调用 CodeGraph `codegraph_explore`（`CODEGRAPH_MCP_TOOLS` 启用 8 工具，崩溃自动重建，30s 超时）

## 提交 & 推送

```bash
git add -A && git commit -m "type: subject" && git push
```

- 远程：`https://github.com/Zhao-T-X/CGM.git`（HTTPS，系统凭据）
- 首推后见 README；敏感信息（真实 token）永不提交