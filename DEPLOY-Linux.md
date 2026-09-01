# CodeGraph Manager —— 服务器部署说明

一个带前端界面的服务，管理服务器上"GitLab 仓库 → clone → codegraph 分析 → 移除"的完整闭环。
零依赖：只需 Node.js + git + codegraph。

## 一条命令跑起来（Linux）

```bash
# 依赖检查
node -v && git --version
# codegraph（任选安装方式）
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh
codegraph --version

# 拉工程、起服务
cd /opt && git clone <你的仓库> codegraph-manager   # 或 scp server.mjs + public/
cd codegraph-manager
HOST=127.0.0.1 PORT=8801 DATA_DIR=/var/lib/codegraph-manager \
  node server.mjs
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址。只本机管理就默认；**要团队网页访问改 `0.0.0.0` + 设 ADMIN_TOKEN** |
| `PORT` | `8801` | 端口 |
| `DATA_DIR` | `./data` | `settings.json`(含 GitLab token) + `repos.json` 存放 |
| `ADMIN_TOKEN` | 空 | 可选 Bearer 令牌，保护页面/API |
| `CODEGRAPH_BIN` | `codegraph` | codegraph 调用方式：`codegraph`、`/usr/local/bin/codegraph`、或 **JSON 数组**（含空格路径时用，如 `["node","/opt/.../npm-shim.js"]`） |

## systemd 常驻

`/etc/systemd/system/codegraph-manager.service`：
```ini
[Unit]
Description=CodeGraph Manager
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/codegraph-manager
Environment=HOST=127.0.0.1
Environment=PORT=8801
Environment=DATA_DIR=/var/lib/codegraph-manager
Environment=CODEGRAPH_BIN=/usr/local/bin/codegraph
# GitLab appkey 不进 unit，从界面保存后落在 DATA_DIR/settings.json
ExecStart=/usr/bin/node server.mjs
Restart=always
User=codegraph
Group=codegraph

[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload && systemctl enable --now codegraph-manager
```

## 使用流程（界面 http://<host>:8801）
1. **GitLab 配置**：填 GitLab 地址 + AppKey(Access Token)，点"校验 Token"。保存后 token 落盘在 `DATA_DIR/settings.json`。
2. **添加仓库**：搜索 GitLab 项目 → 选中 → 添加 → 自动 Clone。
3. **操作列**：Clone / 分析(跑 codegraph init) / 状态 / 移除(删目录+注册)。

## 关键运维点
- **clone 基目录**（界面上填的"仓库克隆基目录"）应指向本地磁盘；索引放网络盘会退化。
- **版本对齐**：GitLab 项目克隆的是你选的**默认分支**；若要分析部署版本，注册时改 gitUrl/branch 指向部署分支/tag。
- **登录/鉴权**：默认仅本机。要团队访问：`HOST=0.0.0.0` + `ADMIN_TOKEN=...`，并建议前加 Nginx/TLS。
- **token 安全**：`settings.json` 里是明文 GitLab token——`chmod 600` DATA_DIR。
- **代码库形态**：多独立仓库默认**每个 index 独立**（不跨仓）；跨仓调用链需 GitNexus groups 或 monorepo。

## 本机已验证（Windows 开发机）
- 设置持久化(settings.json) / 仓库注册表(repos.json) / GitLab 校验与搜索端点
- clone → (codegraph 真实索引 `codegraph.db`) → status→indexed → remove(删目录+清注册) ✅
- GitLab 实网 clone/搜索需你填真实 GitLab URL + AppKey 验证（本机已用本地 git 源测通 clone 机制）。