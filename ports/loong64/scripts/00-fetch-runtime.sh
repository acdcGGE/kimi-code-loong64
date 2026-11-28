#!/usr/bin/env bash
# 获取 Kimi Code 龙芯移植所需运行时（Node 24.22.3 / pnpm 10.33.0 / Electron 43.7.7 loong64）。
# 所有二进制都从网络获取并校验，不依赖本机预置。
set -euo pipefail

PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIMI_ROOT="$(cd "$PORT_ROOT/../.." && pwd)"
NODE_VER="24.22.3"
ELECTRON_VER="43.7.7"
PNPM_VER="10.33.0"
DL="$PORT_ROOT/downloads"
OPT="$PORT_ROOT/opt"
REGISTRY="https://registry.npmmirror.com"

mkdir -p "$DL" "$OPT" "$PORT_ROOT/report"

NODE_TAR="node-v${NODE_VER}-linux-loong64.tar.xz"
ELE_ZIP="electron-v${ELECTRON_VER}-linux-loong64.zip"
NODE_URL="https://github.com/loong64/node/releases/download/v${NODE_VER}"
ELE_URL="https://github.com/darkyzhou/electron-loong64/releases/download/v${ELECTRON_VER}"

PROXY_PREFIXES=("" "https://ghproxy.net/" "https://gh-proxy.com/")

fetch() {
  local upstream="$1" name="$2" uris=() p
  local out="$DL/$name"
  if [[ -s "$out" ]]; then
    echo "[fetch] skip (exists): $name"
    return 0
  fi
  for p in "${PROXY_PREFIXES[@]}"; do uris+=("${p}${upstream}"); done
  echo "[fetch] $name <- ${#uris[@]} mirrors"
  if command -v aria2c >/dev/null 2>&1; then
    aria2c -x 12 -s 12 -k 1M --min-split-size=1M --file-allocation=none \
      --max-tries=5 --retry-wait=3 --timeout=60 --console-log-level=warn \
      --summary-interval=0 -d "$DL" -o "$name" "${uris[@]}"
  else
    curl -fL --retry 5 --retry-delay 3 -o "$out" "$upstream"
  fi
}

check_sha() {
  local file="$DL/$1" expected="$2"
  echo "${expected}  ${file}" | sha256sum -c - >/dev/null
  echo "[verify] OK: $1"
}

# ---- Node.js 24.22.3 (loong64/node glibc) ----
fetch "${NODE_URL}/${NODE_TAR}" "$NODE_TAR"
fetch "${NODE_URL}/${NODE_TAR}.sha256" "${NODE_TAR}.sha256"
NODE_SHA="$(awk '{print $1}' "$DL/${NODE_TAR}.sha256")"
check_sha "$NODE_TAR" "$NODE_SHA"

NODE_HOME="$OPT/node-v${NODE_VER}-linux-loong64"
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  tar -xJf "$DL/$NODE_TAR" -C "$OPT"
fi
export PATH="$NODE_HOME/bin:$PATH"
echo "[runtime] node $(node -v) / $(node -p process.arch) / ABI $(node -p process.versions.modules)"

# ---- pnpm 10.33.0 ----
if [[ ! -x "$OPT/pnpm-home/bin/pnpm" ]]; then
  "$NODE_HOME/bin/npm" install -g --prefix "$OPT/pnpm-home" --registry="$REGISTRY" "pnpm@${PNPM_VER}"
fi
export PATH="$OPT/pnpm-home/bin:$PATH"
echo "[runtime] pnpm $(pnpm -v)"

# ---- Electron 43.7.7 loong64 (desktop 用；CLI 不依赖) ----
fetch "${ELE_URL}/${ELE_ZIP}" "$ELE_ZIP"
fetch "${ELE_URL}/SHASUMS256.txt" "SHASUMS256.txt"
fetch "${ELE_URL}/ffmpeg-v${ELECTRON_VER}-linux-loong64.zip" "ffmpeg-v${ELECTRON_VER}-linux-loong64.zip"

HEADERS="node-v${ELECTRON_VER}-headers.tar.gz"
if [[ ! -s "$DL/$HEADERS" ]] || ! tar -tzf "$DL/$HEADERS" >/dev/null 2>&1; then
  HEADERS_URL="${ELE_URL}/${HEADERS}"
  for prefix in "${PROXY_PREFIXES[@]}"; do
    echo "[fetch] $HEADERS <- ${prefix:-direct}"
    if curl -fsSL -m 120 -o "$DL/$HEADERS" "${prefix}${HEADERS_URL}" && \
       [[ $(stat -c%s "$DL/$HEADERS") -gt 200000 ]] && \
       tar -tzf "$DL/$HEADERS" >/dev/null 2>&1; then
      echo "[verify] OK: $HEADERS"
      break
    fi
  done
fi
tar -tzf "$DL/$HEADERS" >/dev/null 2>&1 || { echo "[verify] $HEADERS 不完整"; exit 1; }

ELE_SHA="$(awk -v n="$ELE_ZIP" '$2 == "*" n || $2 == n {print $1}' "$DL/SHASUMS256.txt" | head -1)"
[[ -z "$ELE_SHA" ]] && { echo "[verify] 找不到 $ELE_ZIP 摘要"; exit 1; }
check_sha "$ELE_ZIP" "$ELE_SHA"

FFMPEG_ZIP="ffmpeg-v${ELECTRON_VER}-linux-loong64.zip"
FFMPEG_SHA="$(awk -v n="$FFMPEG_ZIP" '$2 == "*" n || $2 == n {print $1}' "$DL/SHASUMS256.txt" | head -1)"
[[ -z "$FFMPEG_SHA" ]] && { echo "[verify] 找不到 $FFMPEG_ZIP 摘要"; exit 1; }
check_sha "$FFMPEG_ZIP" "$FFMPEG_SHA"

ELE_HOME="$OPT/electron-v${ELECTRON_VER}-linux-loong64"
if [[ ! -x "$ELE_HOME/electron" ]]; then
  mkdir -p "$ELE_HOME"
  unzip -oq "$DL/$ELE_ZIP" -d "$ELE_HOME"
fi
echo "[runtime] electron binary: $(file -b "$ELE_HOME/electron" | cut -c1-90)"

ELE_CACHE="$HOME/.cache/electron/node-v${ELECTRON_VER}-headers"
if [[ ! -f "$ELE_CACHE/include/node/node.h" ]]; then
  mkdir -p "$ELE_CACHE"
  tar -xzf "$DL/$HEADERS" -C "$ELE_CACHE" --strip-components=1
fi

cat > "$PORT_ROOT/report/runtime.json" <<EOF
{
  "kimiRoot": "$KIMI_ROOT",
  "node": {"version": "$(node -v)", "arch": "$(node -p process.arch)", "modules": "$(node -p process.versions.modules)", "home": "$NODE_HOME"},
  "pnpm": "$(pnpm -v)",
  "electron": {"version": "${ELECTRON_VER}", "home": "$ELE_HOME", "source": "darkyzhou/electron-loong64", "sha256": "$ELE_SHA"},
  "generatedAt": "$(date -Is)"
}
EOF
echo "[done] 运行时就绪"
