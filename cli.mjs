#!/usr/bin/env node
// CodeGraph Manager CLI —— 一键启动
//
// 安装全局命令:  npm i -g .   （项目根执行一次）
// 使用:          cgm [选项]          任意目录一键启动服务
// 不装全局:      node cli.mjs [选项] 效果相同
//
// 选项（优先级：命令行参数 > 环境变量 > 默认值）:
//   --port <n>          监听端口       默认 8801
//   --host <addr>       监听地址       默认 127.0.0.1（对外开放 0.0.0.0 并配 ADMIN_TOKEN）
//   --data <dir>        数据目录       默认 ./data
//   --codegraph <bin>   codegraph 调用方式   默认自动探测（PATH 里的 codegraph → npm 全局 shim）
//   -v / --version      版本
//   -h / --help         帮助
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('./package.json');

const HELP = `CodeGraph Manager v${version} —— 多 Git 平台仓库索引管理 + MCP 代码检索

用法:
  cgm [选项]                启动服务（前台运行，Ctrl+C 退出）
  cgm -v | --version        显示版本
  cgm -h | --help           显示本帮助

选项（优先级：命令行参数 > 环境变量 > 默认值）:
  --port <n>          监听端口            默认 8801
  --host <addr>       监听地址            默认 127.0.0.1
  --data <dir>        数据目录            默认 ./data（settings/repos/克隆仓库都在这，备份=拷目录）
  --codegraph <bin>   codegraph 调用方式  默认自动探测，无需配置

示例:
  cgm                                  # 全默认：http://127.0.0.1:8801
  cgm --port 9000 --data /srv/cgm-data # 自定义端口与数据目录
  HOST=0.0.0.0 ADMIN_TOKEN=xxx cgm     # 对外开放（env 方式）
  界面 http://127.0.0.1:<port>  ·  MCP 端点 /mcp  ·  探活 /healthz`;

function fail(msg) { console.error(`cgm: ${msg}（--help 查看用法）`); process.exit(1); }

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  switch (a) {
    case '-h': case '--help': console.log(HELP); process.exit(0);
    case '-v': case '--version': console.log(version); process.exit(0);
    case '--port': opts.port = argv[++i]; break;
    case '--host': opts.host = argv[++i]; break;
    case '--data': opts.data = argv[++i]; break;
    case '--codegraph': opts.codegraph = argv[++i]; break;
    case 'start': break; // 兼容 `cgm start` 写法
    default: fail(`未知参数: ${a}`);
  }
}

// 参数映射为环境变量（server.mjs 顶层读取），显式参数覆盖 env
if (opts.port !== undefined) {
  const p = Number.parseInt(opts.port, 10);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) fail(`非法端口: ${opts.port}`);
  process.env.PORT = String(p);
}
if (opts.host !== undefined) process.env.HOST = opts.host;
if (opts.data !== undefined) process.env.DATA_DIR = opts.data;
if (opts.codegraph !== undefined) process.env.CODEGRAPH_BIN = opts.codegraph;

// env 已就位，动态加载服务入口（顶层读取上述变量完成初始化）
await import('./server.mjs');
