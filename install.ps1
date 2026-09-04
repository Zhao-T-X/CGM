# CodeGraph Manager 一键安装（Windows）
# 自动安装缺失依赖：Node.js(>=18) → git → CodeGraph → cgm，然后启动服务
# 用法: .\install.cmd [cgm 参数透传]   例: .\install.cmd --port 9000 --data E:\cgm-data
# 也可: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($m) { Write-Host "==> $m" -ForegroundColor Green }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Get-NodeMajor {
  try { return [int](((node -v) -replace '^v', '').Split('.')[0]) } catch { return 0 }
}
function Install-Winget([string]$Id) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Error "未找到 winget，请手动安装后重试（Node: https://nodejs.org / git: https://git-scm.com）"
  }
  winget install -e --id $Id --accept-source-agreements --accept-package-agreements
  Refresh-Path
}

# ---------- 1) Node.js >= 18 ----------
if ((Get-NodeMajor) -ge 18) {
  Say "Node $(node -v) 已就绪"
} else {
  Say "安装 Node.js 22 LTS ..."
  Install-Winget 'OpenJS.NodeJS.LTS'
  if ((Get-NodeMajor) -lt 18) { Write-Error "Node 安装后仍不可用，请重开终端再运行本脚本" }
}

# ---------- 2) git（服务端 clone 业务仓库依赖） ----------
if (Get-Command git -ErrorAction SilentlyContinue) {
  Say "git 已就绪"
} else {
  Say "安装 git ..."
  Install-Winget 'Git.Git'
}

# ---------- 3) CodeGraph ----------
if (Get-Command codegraph -ErrorAction SilentlyContinue) {
  Say "codegraph 已就绪"
} else {
  Say "安装 CodeGraph ..."
  npm i -g @colbymchenry/codegraph
}

# ---------- 4) cgm（本仓库 CLI，link 到全局） ----------
Say "安装 cgm（npm i -g $Repo）..."
npm i -g $Repo

# ---------- 5) 启动（参数透传） ----------
Say "启动 CodeGraph Manager ...（Ctrl+C 退出；参数透传给 cgm）"
cgm @args
