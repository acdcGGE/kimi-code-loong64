#!/usr/bin/env bash
# 构建 Kimi Code CLI（含 SEA 原生单二进制）。
set -uo pipefail

PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIMI_ROOT="$(cd "$PORT_ROOT/../.." && pwd)"
OPT="$PORT_ROOT/opt"
NODE_HOME="$OPT/node-v24.22.3-linux-loong64"
export PATH="$NODE_HOME/bin:$OPT/pnpm-home/bin:$PATH"
export KIMI_SKIP_DESKTOP_PTY_REBUILD=1

mkdir -p "$PORT_ROOT/report"
cd "$KIMI_ROOT"

echo "[build] node $(node -v) / pnpm $(pnpm -v)"

# 1) 构建全部 packages + CLI bundle
pnpm run build:packages 2>&1 | tee "$PORT_ROOT/report/build-packages.log"
rc1=${PIPESTATUS[0]}
echo "[build] build:packages exit=$rc1"

# 2) CLI 自身 bundle（tsdown + 资源拷贝 + web 资源检查）
pnpm -C apps/kimi-code run build 2>&1 | tee "$PORT_ROOT/report/build-cli.log"
rc2=${PIPESTATUS[0]}
echo "[build] cli bundle exit=$rc2"

# 3) SEA 单二进制（local profile，无需签名）
if [[ "$rc2" -eq 0 ]]; then
  pnpm -C apps/kimi-code run build:native:sea 2>&1 | tee "$PORT_ROOT/report/build-sea.log"
  rc3=${PIPESTATUS[0]}
  echo "[build] native SEA exit=$rc3"
else
  rc3=1
fi

if [[ "$rc1" -eq 0 && "$rc2" -eq 0 && "$rc3" -eq 0 ]]; then
  echo "[done] CLI + SEA 构建成功"
  exit 0
fi
echo "[fail] rc1=$rc1 rc2=$rc2 rc3=$rc3"
exit 1
