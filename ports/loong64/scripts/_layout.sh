#!/usr/bin/env bash
# 布局探测：移植层在 <repo>/ports/loong64/ 下，源码树就是上两级。
set -euo pipefail
_LAYOUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resolve_kimi_root() {
  if [[ -n "${KIMI_ROOT:-}" ]]; then printf '%s\n' "$KIMI_ROOT"; return; fi
  local port_root repo_root
  port_root="$(cd "$_LAYOUT_DIR/.." && pwd)"
  repo_root="$(cd "$port_root/../.." && pwd)"
  if [[ -f "$repo_root/package.json" && -d "$repo_root/apps/kimi-code" ]]; then
    printf '%s\n' "$repo_root"
  else
    printf '%s\n' "$(cd "$port_root/.." && pwd)/kimi-code"
  fi
}
