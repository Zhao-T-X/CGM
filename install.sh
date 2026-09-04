#!/usr/bin/env bash
# CodeGraph Manager 一键安装（Linux / macOS）
# 自动安装缺失依赖：Node.js(>=18) → git → CodeGraph → cgm，然后启动服务
# 用法: bash install.sh [cgm 参数透传]   例: bash install.sh --port 9000 --data /srv/cgm-data
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1) Node.js >= 18 ----------
node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0; }

NM="$(node_major || true)"
if [ "${NM:-0}" -ge 18 ] 2>/dev/null; then
  say "Node $(node -v) 已就绪"
else
  [ "${NM:-0}" -gt 0 ] 2>/dev/null && say "Node $(node -v) 版本过低，需要 >= 18，开始升级..."
  say "安装 Node.js 22 ..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -
    $SUDO dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -
    $SUDO yum install -y nodejs
  elif command -v brew >/dev/null 2>&1; then
    brew install node@22 && brew link --overwrite node@22
  else
    die "未识别的包管理器，请手动安装 Node.js >= 18: https://nodejs.org"
  fi
  command -v node >/dev/null 2>&1 || die "Node 安装后仍不可用，可能需要重开终端再试"
fi

# ---------- 2) git（服务端 clone 业务仓库依赖） ----------
if command -v git >/dev/null 2>&1; then
  say "git $(git --version | awk '{print $3}') 已就绪"
else
  say "安装 git ..."
  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update && $SUDO apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y git
  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y git
  elif command -v brew >/dev/null 2>&1; then brew install git
  else die "请手动安装 git: https://git-scm.com"; fi
fi

# ---------- 3) CodeGraph ----------
if command -v codegraph >/dev/null 2>&1; then
  say "codegraph 已就绪"
else
  say "安装 CodeGraph ..."
  npm i -g @colbymchenry/codegraph
fi

# ---------- 4) cgm（本仓库 CLI，link 到全局） ----------
say "安装 cgm（npm i -g $REPO_DIR）..."
npm i -g "$REPO_DIR"

# ---------- 5) 启动（参数透传） ----------
say "启动 CodeGraph Manager ...（Ctrl+C 退出；参数透传给 cgm）"
exec cgm "$@"
