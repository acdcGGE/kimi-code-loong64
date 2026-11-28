#!/usr/bin/env bash
# 07-stage-node-pty.sh — 落地并验证 linux-loong64 node-pty 原生模块。
#
# 优先级：
#  A. 沿用 pnpm install 阶段 electron-rebuild 生成的 build/Release/pty.node
#     （源码编译，N-API，DT_NEEDED 无 libnode，Electron 43 / Node 24 双通过）。
#  B. 若 A 不存在或验证失败，从龙芯官方源下载 @lydell/node-pty-linux-loong64
#     的 prebuild（与 ZCode 移植层同源），再验证后落地。
#
# 落地位置：node-pty/prebuilds/linux-loong64/pty.node
#   node-pty/lib/utils.js 的加载顺序是 build/Release → build/Debug → prebuilds/<platform>-<arch>，
#   两处都放可保证 electron-builder asarUnpack 后仍能解析。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_ROOT="$(cd "$HERE/.." && pwd)"
source "$HERE/_layout.sh"
KIMI_ROOT="$(resolve_kimi_root)"

NODE_VER="24.22.3"
ELECTRON_VER="43.7.7"
NODE_HOME="$PORT_ROOT/opt/node-v$NODE_VER-linux-loong64"
ELECTRON_BIN="${ELECTRON_BIN:-$PORT_ROOT/opt/electron-v$ELECTRON_VER-linux-loong64/electron}"
LOONGNIX="https://registry.loongnix.cn:5873"
OFFICIAL_VER="1.2.0-beta.10"
OFFICIAL_TGZ="$PORT_ROOT/downloads/native/loongnix/node-pty-linux-loong64-$OFFICIAL_VER.tgz"
REPORT="$PORT_ROOT/report/node-pty.json"
export PATH="$NODE_HOME/bin:$PORT_ROOT/opt/pnpm-home/bin:$PATH"

log()  { printf '[node-pty] %s\n' "$*"; }
die()  { printf '[node-pty] ERROR: %s\n' "$*" >&2; exit 1; }

PTY_ROOT="$KIMI_ROOT/apps/desktop/node_modules/node-pty"
BUILT="$PTY_ROOT/build/Release/pty.node"
PREBUILD_DIR="$PTY_ROOT/prebuilds/linux-loong64"
PREBUILD="$PREBUILD_DIR/pty.node"
SOURCE="none"
[[ -d "$PTY_ROOT" ]] || die "node-pty 未安装: $PTY_ROOT"
[[ -x "$ELECTRON_BIN" ]] || die "Electron 二进制不存在: $ELECTRON_BIN"

# 验证失败一律 return 1，供调用方触发回退。
verify_pty() {
  local bin="$1" out
  [[ -f "$bin" ]] || { log "验证失败: 文件不存在 $bin"; return 1; }
  file "$bin" | grep -qi 'LoongArch' || { log "验证失败: 非 LoongArch ELF: $bin"; return 1; }
  if readelf -d "$bin" | grep -q 'libnode.so'; then
    log "验证失败: 存在 libnode DT_NEEDED（Electron 下会 SIGSEGV）: $bin"
    return 1
  fi
  out="$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" -e \
    "const p=require('$bin'); console.log(Object.keys(p).join(','))" 2>&1)" \
    || { log "验证失败: Electron $ELECTRON_VER 加载失败: ${out:0:300}"; return 1; }
  echo "$out" | grep -q 'fork' || { log "验证失败: Electron 导出异常: $out"; return 1; }
  out="$(node -e "const p=require('$bin'); console.log(Object.keys(p).join(','))" 2>&1)" \
    || { log "验证失败: Node $(node -v) 加载失败: ${out:0:300}"; return 1; }
  echo "$out" | grep -q 'fork' || { log "验证失败: Node 导出异常: $out"; return 1; }
  log "双运行时加载通过: fork,open,resize,process"
  return 0
}

fetch_official() {
  log "从龙芯官方源获取 @lydell/node-pty-linux-loong64@$OFFICIAL_VER"
  mkdir -p "$(dirname "$OFFICIAL_TGZ")"
  curl -fsSL -m 180 -o "$OFFICIAL_TGZ" \
    "$LOONGNIX/@lydell%2fnode-pty-linux-loong64/-/node-pty-linux-loong64-$OFFICIAL_VER.tgz" \
    || return 1
  local tmp
  tmp="$(mktemp -d)"
  tar -xzf "$OFFICIAL_TGZ" -C "$tmp" || { rm -rf "$tmp"; return 1; }
  local bin="$tmp/package/prebuilds/linux-loong64/pty.node"
  [[ -f "$bin" ]] || { log "官方包内无 prebuilds/linux-loong64/pty.node"; rm -rf "$tmp"; return 1; }
  if verify_pty "$bin"; then
    cp -f "$bin" "$BUILT"
    rm -rf "$tmp"
    SOURCE="loongnix-official@$OFFICIAL_VER"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

if verify_pty "$BUILT"; then
  SOURCE="local-build-from-source"
else
  log "本地产物不可用，尝试官方源回退"
  fetch_official || die "node-pty 两条路径均失败，无法继续"
fi

mkdir -p "$PREBUILD_DIR"
cp -f "$BUILT" "$PREBUILD"
verify_pty "$PREBUILD" || die "落地后的 prebuild 验证失败: $PREBUILD"

mkdir -p "$(dirname "$REPORT")"
cat > "$REPORT" <<EOF
{
  "platform": "linux-loong64",
  "nodePtyVersion": "$(node -p "require('$PTY_ROOT/package.json').version")",
  "electronVersion": "$ELECTRON_VER",
  "nodeVersion": "$(node -v)",
  "source": "$SOURCE",
  "stagedPrebuild": "$PREBUILD",
  "exports": "fork,open,resize,process",
  "elf": "$(file -b "$PREBUILD")",
  "needed": "$(readelf -d "$PREBUILD" | sed -n 's/.*NEEDED.*\[\(.*\)\].*/\1/p' | tr '\n' ' ')",
  "verified": true,
  "generatedAt": "$(date -Is)"
}
EOF
log "报告写入 $REPORT"
log "完成（来源: $SOURCE）"
