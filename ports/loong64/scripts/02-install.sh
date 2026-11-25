#!/usr/bin/env bash
# 用龙芯 Node 24 + pnpm 安装整个 workspace（依赖全部走仓库 lockfile + 网络 registry）。
set -euo pipefail

PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIMI_ROOT="$(cd "$PORT_ROOT/../.." && pwd)"
OPT="$PORT_ROOT/opt"
NODE_HOME="$OPT/node-v24.22.3-linux-loong64"
export PATH="$NODE_HOME/bin:$OPT/pnpm-home/bin:$PATH"

mkdir -p "$PORT_ROOT/report"
cd "$KIMI_ROOT"

echo "[install] node $(node -v) / pnpm $(pnpm -v)"
echo "[install] registry=$(pnpm config get registry)"

# supportedArchitectures 让 pnpm 解析 loong64 平台包（clipboard 等无 loong64 变体时跳过，运行期有 JS 回退）。
# engine-strict 保留：Node 24.22.3 >= 24.15.0 满足要求。
pnpm install --no-frozen-lockfile 2>&1 | tee "$PORT_ROOT/report/install.log"

echo "[done] 依赖安装完成"
