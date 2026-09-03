# CodeGraph Manager

<p align="center"><a href="README.md">🇨🇳 中文</a> · <b>🇬🇧 English</b></p>

Server-side code indexing & management service — unify repositories from multiple Git hosting platforms (GitLab / Gitee / GitHub), clone them automatically, build a code knowledge graph with [CodeGraph](https://github.com/colbymchenry/codegraph), and let AI agents query the code directly over **MCP (Model Context Protocol)**.

**Zero-dependency Node backend + vanilla-JS frontend.** Start with a single command — no database, no build step.

## ✨ Features

- **Multi-provider repository management** — one UI for GitLab / Gitee / GitHub (config list + add-via-modal, tokens masked)
- **Code indexing** — full `clone → analyze → status → remove` pipeline, building symbol / file / call-relationship graphs via CodeGraph
- **Cross-source search** — one keyword query across all configured providers, merged results with source labels
- **Local repository support** — ingest an already-cloned local directory (auto-detects Git remote & branch)
- **MCP server** — `POST /mcp` (Streamable HTTP / JSON-RPC), exposing 4 tools for AI to query code
  - `search_code` — query a repo's code graph (maps `projectPath` internally and calls CodeGraph's native MCP)
- **Vercel-style dark UI** — near-black theme, minimal whitespace, smooth transitions

## 📸 Screenshots

**Overview (metric cards + top nav)**
![Overview](public/img/index.png)

**Repositories (clone · analyze · remove)**
![Repositories](public/img/repo-show.png)

**Add provider (modal to pick GitLab / Gitee / GitHub)**
![Add provider](public/img/add-provider.png)

**Settings (provider config list)**
![Settings](public/img/setting.png)

## 🧰 MCP Tools

| Tool | Description |
|---|---|
| `query_repository(name)` | Resolve repo name → local path (projectPath) / status / provider |
| `list_repositories(status?)` | List all registered repos, optional status filter |
| `search_repositories(query)` | Fuzzy search repo names |
| `search_code(query, repo?, branch?, maxFiles?)` | **Query code**: maps repo→projectPath, queries the CodeGraph knowledge graph, returns symbols / files / call relationships. Pass `branch` to query that branch's worktree index (first call auto-builds the index in the background and returns "retry later") |

Example (by branch):
```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_code","arguments":{"query":"AuthService loginUser","repo":"tineco-nmp","branch":"dev_ibu","maxFiles":12}}}
```

> Multi-branch: repos are cloned fully (not shallow). The default-branch index covers only the default branch; passing `branch` makes the backend `git worktree add` that branch into its own index. The default index is kept clean via `.gitignore` exempting `worktrees/`.

## 📦 Dependencies

| Component | Notes |
|---|---|
| **CodeGraph** | `npm i -g @colbymchenry/codegraph` (MIT license) |

> Everything else uses Node.js built-ins (`http`/`fetch`/`child_process`) — zero extra dependencies.

## 🚀 Quick Start

### 1. Install CodeGraph
```bash
npm i -g @colbymchenry/codegraph
```

### 2. Start the service
```bash
# Windows
env PORT=8801 DATA_DIR="E:/workspace/cgm-data" CODEGRAPH_BIN='["node","D:/Program Files/nodejs/node_modules/@colbymchenry/codegraph/npm-shim.js"]' node server.mjs

# Linux
PORT=8801 DATA_DIR=/srv/cgm-data CODEGRAPH_BIN=codegraph node server.mjs
```

### 3. Open the UI
Go to **http://127.0.0.1:8801**

### 4. Configure providers & connect MCP
- **UI**: Settings → Add Provider → pick platform → fill URL/token → Save → Add Selected repos → Clone/Analyze
- **MCP clients** (Cursor / Claude Desktop / custom agents):
  ```
  Remote MCP URL: http://127.0.0.1:8801/mcp
  ```
  Or use the bundled `mcp-config.json` (standard `mcpServers` format).

## ⚙️ Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8801` | Listen port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for external access — needs `ADMIN_TOKEN` + reverse proxy) |
| `DATA_DIR` | `<cwd>/data` | Data directory (`settings.json` holds provider registrations incl. tokens; `repos.json` the repo registry) |
| `CODEGRAPH_BIN` | `codegraph` | CodeGraph executable. **On Windows the global install is a bash shim — use the JSON-array form**: `["node","D:/.../npm-shim.js"]` |
| `SYNC_HOURS` | `6` | Auto-refresh indexed repos (`git pull + codegraph sync`) interval in hours; `0` disables |
| `ADMIN_TOKEN` | — | API access token when exposed externally |

## 🗂 Directory Structure

```
codegraph-manager/
├── server.mjs         zero-dep HTTP backend (provider CRUD, repo ops, /mcp routes, static serving)
├── mcp.mjs            MCP module (4 tools + CodeGraph stdio gateway client)
├── public/index.html  Vercel-style frontend (single-file)
├── public/img/        UI screenshots
├── DEPLOY-Linux.md    Linux systemd deployment guide
└── .gitignore         excludes data/ secrets
```

## 🔌 API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/api/settings` | GET/PUT | Global config (cloneBaseDir / activeProviderId) |
| `/api/providers` | GET/POST | Provider list (token masked) / add |
| `/api/providers/:id` | PUT/DELETE | Update / delete provider |
| `/api/providers/check` | POST | Test connection (in-memory, not persisted) |
| `/api/providers/projects` | GET | Cross-source search (`q=` + `providerId=all`) |
| `/api/repos` | GET/POST | Repository registry |
| `/api/repos/local` | POST | Add a local repo |
| `/api/repos/:id/{clone,analyze,status,remove}` | POST | Repo operations |
| `/mcp` | POST(HTTP)/OAuth | MCP endpoint (JSON-RPC 2.0, Streamable HTTP) |
| `/mcp/message` | POST | MCP SSE message endpoint |

## 🔒 Security

- `data/` is excluded via `.gitignore` — **real GitLab/Gitee/GitHub tokens live only in the server data dir, never committed to git**
- Service binds `127.0.0.1` by default; for external exposure set `HOST=0.0.0.0` + `ADMIN_TOKEN` + Nginx reverse proxy (see `DEPLOY-Linux.md`)
- The MCP endpoint has no auth (localhost service) — only for trusted networks

## 🤝 Use Cases

Index multiple code platforms (e.g. company GitLab) on one server so AI coding agents (Cursor, Claude Code, Hermes, etc.) can query code over MCP — symbol lookup, call-relationship analysis and impact assessment across repositories.

## 📄 License

MIT (CodeGraph is MIT; the project's own code is MIT unless otherwise chosen).