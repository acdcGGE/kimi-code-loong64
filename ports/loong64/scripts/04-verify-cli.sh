#!/usr/bin/env bash
# 验证 Kimi Code CLI 在龙芯上可运行（bundle + SEA 二进制）。
set -uo pipefail
PORT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIMI_ROOT="$(cd "$PORT_ROOT/../.." && pwd)"
OPT="$PORT_ROOT/opt"
NODE_HOME="$OPT/node-v24.22.3-linux-loong64"
export PATH="$NODE_HOME/bin:$OPT/pnpm-home/bin:$PATH"

mkdir -p "$PORT_ROOT/report"
cd "$KIMI_ROOT"
echo "[verify] node $(node -v) / $(node -p process.arch)"

fail=0
pass=0
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS  $name"; pass=$((pass+1))
  else
    echo "FAIL  $name"; fail=$((fail+1))
  fi
}

# 1) bundle 层：node dist/main.mjs --version
if [[ -f apps/kimi-code/dist/main.mjs ]]; then
  ver="$(node apps/kimi-code/dist/main.mjs --version 2>&1 | head -1)"
  if [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    echo "PASS  CLI bundle --version => $ver"; pass=$((pass+1))
  else
    echo "FAIL  CLI bundle --version => $ver"; fail=$((fail+1))
  fi
else
  echo "FAIL  CLI bundle 不存在"; fail=$((fail+1))
fi

# 2) bundle help
if [[ -f apps/kimi-code/dist/main.mjs ]]; then
  help="$(node apps/kimi-code/dist/main.mjs --help 2>&1 | head -3)"
  if [[ -n "$help" ]]; then
    echo "PASS  CLI bundle --help 有输出"; pass=$((pass+1))
  else
    echo "FAIL  CLI bundle --help 无输出"; fail=$((fail+1))
  fi
fi

# 3) SEA 单二进制
SEA="$KIMI_ROOT/apps/kimi-code/dist-native/bin/linux-loong64/kimi"
if [[ -x "$SEA" ]]; then
  ver="$($SEA --version 2>&1 | head -1)"
  if [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    echo "PASS  SEA binary --version => $ver"; pass=$((pass+1))
  else
    echo "FAIL  SEA binary --version => $ver"; fail=$((fail+1))
  fi
  file "$SEA" | head -1
else
  echo "FAIL  SEA 二进制不存在: $SEA"; fail=$((fail+1))
fi

# 4) 关键原生模块可加载：按 .pnpm 虚拟 store 逐实例验证。
#    根目录未直接链接这些包，require('rolldown') 的失败是假阴性，不能代表 binding 缺失。
bind_out="$(node "$PORT_ROOT/scripts/verify-bindings.mjs" 2>&1)"
echo "$bind_out"
bpass="$(printf '%s\n' "$bind_out" | grep -c '^PASS ')"
bfail="$(printf '%s\n' "$bind_out" | grep -c '^FAIL ')"
pass=$((pass+bpass)); fail=$((fail+bfail))

echo ""
echo "结果: PASS=$pass FAIL=$fail"
cat > "$PORT_ROOT/report/verify-cli.json" <<EOF
{
  "node": "$(node -v)",
  "arch": "$(node -p process.arch)",
  "pass": $pass,
  "fail": $fail,
  "generatedAt": "$(date -Is)"
}
EOF
[[ "$fail" -eq 0 ]]
