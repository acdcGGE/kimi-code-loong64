#!/usr/bin/env bash
# 09-build-desktop.sh — 构建 Kimi Code Desktop 的 linux-loong64 产物。
#
# 用法：
#   ./09-build-desktop.sh renderer   # vite renderer -> desktop-dist
#   ./09-build-desktop.sh native     # screenshot/clamshell helper（Linux 下为 no-op）
#   ./09-build-desktop.sh main       # tsdown -> out/
#   ./09-build-desktop.sh bundle     # electron-builder --arch loong64 --dir
#   ./09-build-desktop.sh all        # 顺序执行以上四步
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_ROOT="$(cd "$HERE/.." && pwd)"
source "$HERE/_layout.sh"
KIMI_ROOT="$(resolve_kimi_root)"
OPT="$PORT_ROOT/opt"
NODE_VER="24.22.3"
ELECTRON_VER="43.7.7"

export PATH="$OPT/node-v$NODE_VER-linux-loong64/bin:$OPT/pnpm-home/bin:$PATH"
export npm_config_registry="https://registry.npmmirror.com"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export ELECTRON_OVERRIDE_DIST_PATH="$OPT/electron-v$ELECTRON_VER-linux-loong64"
export KIMI_ELECTRON_DIST="$OPT/electron-v$ELECTRON_VER-linux-loong64"
unset ELECTRON_RUN_AS_NODE

cd "$KIMI_ROOT"
mkdir -p "$PORT_ROOT/report"
DESKTOP="apps/desktop"
STAGE="${1:-all}"

run_stage() {
  local name="$1"; shift
  echo "[build] === $name === $(date -Is)"
  set +e
  "$@" 2>&1 | tee "$PORT_ROOT/report/desktop-$name.log"
  local rc=${PIPESTATUS[0]}
  set -e
  echo "[build] $name exit=$rc"
  return "$rc"
}

case "$STAGE" in
  renderer) run_stage renderer pnpm -C "$DESKTOP" run build:renderer ;;
  native)
    run_stage native-screenshot pnpm -C "$DESKTOP" run build:native:screenshot &&
      run_stage native-clamshell pnpm -C "$DESKTOP" run build:native:clamshell
    ;;
  main) run_stage main pnpm -C "$DESKTOP" exec tsdown ;;
  bundle)
    # 龙芯 electron-builder 分支认 --arch loong64；KIMI_ELECTRON_DIST 让它直接用本地已校验 dist。
    (cd "$DESKTOP" && run_stage bundle pnpm exec electron-builder \
      --config electron-builder.config.cjs --linux --dir --loong64)
    ;;
  all)
    run_stage renderer pnpm -C "$DESKTOP" run build:renderer || exit $?
    run_stage native-screenshot pnpm -C "$DESKTOP" run build:native:screenshot || exit $?
    run_stage native-clamshell pnpm -C "$DESKTOP" run build:native:clamshell || exit $?
    run_stage main pnpm -C "$DESKTOP" exec tsdown || exit $?
    (cd "$DESKTOP" && run_stage bundle pnpm exec electron-builder \
      --config electron-builder.config.cjs --linux --dir --loong64)
    ;;
  *) echo "用法: $0 {renderer|native|main|bundle|all}"; exit 2 ;;
esac
