#!/usr/bin/env bash
# 11-smoke-desktop.sh — 启动已打包的 linux-loong64 Desktop，验证主进程/渲染进程真正就绪。
#
# 判据以日志中的 ui-ready 为准，而不是「观察期结束时还活着」：
# 本机 X11 下 Chromium 在收到 SIGTERM 退出时，GPU 子进程会以 SIGILL 结束，
# 那是退出路径的环境噪声，不代表启动失败。
#
#   ./11-smoke-desktop.sh                     # 默认观察 25 秒
#   WAIT_SECONDS=40 ./11-smoke-desktop.sh
#   KIMI_SMOKE_APP=/path/to/app ./11-smoke-desktop.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_ROOT="$(cd "$HERE/.." && pwd)"
source "$HERE/_layout.sh"
KIMI_ROOT="$(resolve_kimi_root)"
APP_DIR="$KIMI_ROOT/apps/desktop/dist-app/linux-loong64-unpacked"
APP="${KIMI_SMOKE_APP:-$APP_DIR/kimi-code}"
WAIT_SECONDS="${WAIT_SECONDS:-25}"
LOG="$PORT_ROOT/report/smoke-desktop.log"
REPORT="$PORT_ROOT/report/smoke-desktop.json"

mkdir -p "$PORT_ROOT/report"
[[ -x "$APP" ]] || { echo "[smoke] 找不到可执行文件：$APP"; exit 2; }
APP_REAL="$(readlink -f "$APP")"
APP_RES="$(dirname "$APP_REAL")/resources/app.asar"
[[ -f "$APP_RES" ]] || { echo "[smoke] 找不到 $APP_RES"; exit 2; }

# 隔离 HOME 与 XDG 目录，避免污染真实会话的 ~/.kimi-code。
SMOKE_HOME="$(mktemp -d /tmp/kimi-smoke-home.XXXXXX)"
export HOME="$SMOKE_HOME"
export XDG_CONFIG_HOME="$SMOKE_HOME/config"
export XDG_DATA_HOME="$SMOKE_HOME/data"
export XDG_CACHE_HOME="$SMOKE_HOME/cache"
unset ELECTRON_RUN_AS_NODE

echo "[smoke] app=$APP_REAL"
echo "[smoke] data=$SMOKE_HOME wait=${WAIT_SECONDS}s"

# --disable-gpu：龙芯 X11 下 GPU 子进程退出时会 SIGILL，关掉它不影响 UI 就绪验证。
setsid "$APP" --disable-gpu > "$LOG" 2>&1 &
LAUNCHER=$!
sleep 1
PGID="$(ps -o pgid= -p "$LAUNCHER" 2>/dev/null | tr -d ' ')"
READY=0
for _ in $(seq 1 "$WAIT_SECONDS"); do
  sleep 1
  if grep -q 'ui-ready' "$LOG" 2>/dev/null; then READY=1; break; fi
  kill -0 "$LAUNCHER" 2>/dev/null || break
done

pass=0; fail=0
check() {
  local name="$1" ok="$2" detail="${3:-}"
  if [[ "$ok" == "1" ]]; then
    echo "PASS  $name${detail:+ — $detail}"; pass=$((pass+1))
  else
    echo "FAIL  $name${detail:+ — $detail}"; fail=$((fail+1))
  fi
}

# 1) 主进程无 ESM 具名导入缺失 / 原生 binding 加载失败
if grep -qiE "does not provide an export named|JavaScript error occurred in the main process|Uncaught Exception|Cannot find native binding|Failed to load native module" "$LOG"; then
  check "主进程无未捕获异常" 0 "详见 $LOG"
else
  check "主进程无未捕获异常" 1
fi

# 2) 渲染页加载成功
if grep -qi "did-fail-load" "$LOG"; then
  check "渲染进程加载成功" 0 "did-fail-load"
else
  check "渲染进程加载成功" 1
fi

# 3) UI 真正就绪（window-created + ui-ready 都出现）
WINDOW=0
grep -q 'window-created' "$LOG" 2>/dev/null && WINDOW=1
check "主窗口已创建" "$WINDOW"
check "UI 完成初始化(ui-ready)" "$READY"

# 4) 日志非空
LINES="$(wc -l < "$LOG" 2>/dev/null || echo 0)"
check "主进程日志非空" "$([[ "$LINES" -gt 0 ]] && echo 1 || echo 0)" "$LINES 行"

cat > "$REPORT" <<EOF
{
  "app": "$APP_REAL",
  "log": "$LOG",
  "lines": $LINES,
  "windowCreated": $WINDOW,
  "uiReady": $READY,
  "waitSeconds": $WAIT_SECONDS,
  "pass": $pass,
  "fail": $fail,
  "generatedAt": "$(date -Is)"
}
EOF
echo "日志：$LOG    报告：$REPORT"

[[ "$fail" -eq 0 ]] || { echo "=== $fail 项失败 ==="; exit 1; }
echo "=== 全部通过 ==="

# 异步清理：龙芯 X11 下 GPU 子进程被 TERM 时以 SIGILL 结束，
# 同步 wait 会让 shell 把该作业异常传播成脚本的非零退出码。
if [[ -n "${PGID:-}" ]]; then
  setsid bash -c "kill -TERM -$PGID 2>/dev/null; sleep 3; kill -KILL -$PGID 2>/dev/null; exit 0" \
    >/dev/null 2>&1 &
fi
exit 0
