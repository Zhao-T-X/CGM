# CodeGraph Manager

服务器端代码索引管理服务——统一管理来自多个 Git 托管平台（GitLab / Gitee / GitHub）的仓库，自动克隆、用 [CodeGraph](https://github.com/colbymchenry/codegraph) 生成代码知识图谱，并通过 **MCP（Model Context Protocol）** 让 AI 代理直接检索代码。

**零依赖 Node 后端 + 原生 JS 前端**，单命令启动，无需数据库、无需构建。

## ✨ 功能

- **多提供商仓库管理**：一个界面统一管理 GitLab / Gitee / GitHub 三个平台的仓库（配置列表 + 弹窗新增，token 脱敏）
- **代码索引**：`clone → analyze → status → remove` 全流程，基于 CodeGraph 生成符号/文件/调用关系图谱
- **跨源搜索**：一次关键词搜索所有已配置的提供商，结果合并展示（带来源标签）
- **本地仓库支持**：直接纳入已克隆的本地目录（自动识别 Git 远程和分支）
- **MCP 服务器**：`POST /mcp`（Streamable HTTP / JSON-RPC），暴露 4 个工具让 AI 检索代码
  - `search_code` —— 指定仓库检索代码图谱（内部经 projectPath 映射调用 CodeGraph 原生 MCP）
- **Vercel 风深色 UI**：纯黑底 + 极简留白 + 平滑动效

## 🧰 MCP 工具

| 工具 | 说明 |
|---|---|
| `query_repository(name)` | 按仓库名查本地路径(projectPath)/状态/提供商 |
| `list_repositories(status?)` | 列出所有已注册仓库，可按状态过滤 |
| `search_repositories(query)` | 模糊搜索仓库名 |
| `search_code(query, repo?, maxFiles?)` | **检索代码**：repo→projectPath 映射后调用 CodeGraph 知识图谱，返回符号/文件/调用关系 |

示例调用：
```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_code","arguments":{"query":"AuthService loginUser","repo":"tineco-nmp","maxFiles":12}}}
```

## 📦 依赖

| 组件 | 说明 |
|---|---|
| **CodeGraph** | `npm i -g @colbymchenry/codegraph`（MIT 许可） |

> 其余全部为 Node.js 内置模块（`http`/`fetch`/`child_process`），零额外依赖。

## 🚀 快速开始

### 1. 安装 CodeGraph
```bash
npm i -g @colbymchenry/codegraph
```

### 2. 启动服务
```bash
# Windows
env PORT=8801 DATA_DIR="E:/workspace/cgm-data" CODEGRAPH_BIN='["node","D:/Program Files/nodejs/node_modules/@colbymchenry/codegraph/npm-shim.js"]' node server.mjs

# Linux
PORT=8801 DATA_DIR=/srv/cgm-data CODEGRAPH_BIN=codegraph node server.mjs
```

### 3. 访问界面
打开 **http://127.0.0.1:8801**

### 4. 配置提供商 & MCP
- **界面**：Settings → Add Provider → 选平台 → 填 URL/token → Save → Add Selected 仓库 → Clone/Analyze
- **MCP 客户端**（Cursor / Claude Desktop / 自定义 Agent）：
  ```
  远程 MCP 地址：http://127.0.0.1:8801/mcp
  ```
  或用项目内提供的 `mcp-config.json`（标准 `mcpServers` 格式）。

## ⚙️ 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8801` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（`0.0.0.0` 对外开放，需配 `ADMIN_TOKEN` + 反代） |
| `DATA_DIR` | `<工作目录>/data` | 数据目录（`settings.json` 含提供商注册 + token，`repos.json` 仓库注册表） |
| `CODEGRAPH_BIN` | `codegraph` | CodeGraph 可执行命令。**Windows 全局安装是 bash shim，必须用 JSON 数组形式**：`["node","D:/.../npm-shim.js"]` |
| `ADMIN_TOKEN` | — | 对外开放时 API 访问令牌 |

## 🗂 目录结构

```
codegraph-manager/
├── server.mjs         零依赖 HTTP 后端（提供商 CRUD、仓库操作、/mcp 路由、静态服务）
├── mcp.mjs            MCP 服务器模块（4 工具 + CodeGraph stdio 网关客户端）
├── public/index.html  Vercel 风前端（single-file）
├── DEPLOY-Linux.md    Linux systemd/systemd 部署说明
└── .gitignore         排除 data/ 敏感数据
```

## 🔌 API 参考

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/settings` | GET/PUT | 全局配置（cloneBaseDir / activeProviderId） |
| `/api/providers` | GET/POST | 提供商列表（token 脱敏）/ 新增 |
| `/api/providers/:id` | PUT/DELETE | 更新 / 删除提供商 |
| `/api/providers/check` | POST | 测试连接（内存校验，不落盘） |
| `/api/providers/projects` | GET | 跨源搜索项目（`q=`+`providerId=all`） |
| `/api/repos` | GET/POST | 仓库注册表 |
| `/api/repos/local` | POST | 添加本地仓库 |
| `/api/repos/:id/{clone,analyze,status,remove}` | POST | 仓库操作 |
| `/mcp` | POST(HTTP)/OAuth | MCP 端点（JSON-RPC 2.0，Streamable HTTP） |
| `/mcp/message` | POST | MCP SSE 消息端点 |

## 🔒 安全说明

- `data/` 已被 `.gitignore` 排除——**真实 GitLab/Gitee/GitHub token 只存服务端数据目录，永不提交到 git**
- `.gitignore` 仅排除运行时数据，源码完整入库
- 服务默认仅监听 `127.0.0.1`；对外开放需 `HOST=0.0.0.0` + `ADMIN_TOKEN` + Nginx 反向代理（见 `DEPLOY-Linux.md`）
- MCP 端点无认证（本机服务）——仅限可信网络使用

## 🤝 用途

适合把公司内网多个代码平台（GitLab 等）的仓库统一索引，供 AI 编码代理（Cursor、Claude Code、Hermes 等）通过 MCP 检索代码，实现跨仓库的符号定位、调用关系分析和影响范围评估。

## 📄 License

MIT（CodeGraph 为 MIT；本项目原生代码可按需选择许可）。