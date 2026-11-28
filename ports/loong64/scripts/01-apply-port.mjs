#!/usr/bin/env node
/**
 * Kimi Code loong64 幂等源码补丁器。
 * 用法：node scripts/01-apply-port.mjs [--check] [--kimi=/path]
 * 每项补丁是精确字符串替换，--check 只审计不修改。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKimiRoot } from './_layout.mjs';

const portRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.find((a) => a.startsWith('--kimi='));
const kimiRoot = arg ? resolve(arg.slice('--kimi='.length)) : resolveKimiRoot(portRoot);
const checkOnly = process.argv.includes('--check');

/**
 * 每条：{ id, file, from, to, note }
 * from 必须精确匹配一次（或匹配次数 === 期望），否则报错，不允许模糊替换。
 */
const PATCHES = [
  // ── CLI：主干 2.8.1 新增 SUPPORTED_TARGETS 白名单，需显式放行 loong64 ──
  {
    id: 'sea-supported-target-loong64',
    file: 'apps/kimi-code/scripts/native/native-deps.mjs',
    from: "  'linux-arm64',\n  'linux-x64',",
    to: "  'linux-arm64',\n  'linux-loong64',\n  'linux-x64',",
    note: '上游新增目标白名单，之前仅过滤原生依赖不足以通过 SEA 校验',
  },
  // ── CLI：SEA 原生资源在 loong64 上跳过无原生包的 native-only 依赖 ──
  {
    id: 'sea-target-loong64',
    file: 'apps/kimi-code/scripts/native/native-deps.mjs',
    from: "  return nativeDeps\n    .filter((d) => d.collect !== 'virtual')",
    to: "  return nativeDeps\n    .filter((d) => d.collect !== 'virtual')\n    // loong64 port: clipboard/pi-tui 无龙芯原生包，运行期有 OSC52/命令行回退，SEA 收集时跳过\n    .filter((d) => !(target === 'linux-loong64' && (d.collect === 'native-files' || d.collect === 'native-file-only')))",
    note: 'loong64 跳过 clipboard-target / pi-tui 原生资产（无 loong64 包），保留 clipboard-host JS',
  },
  // ── CLI：pi-tui 原生 clipboard helper 在 loong64 上安全跳过（已有 JS/命令行回退） ──
  {
    id: 'pi-tui-arch-guard',
    file: 'packages/pi-tui/src/native-platform.ts',
    from: 'if (arch !== "x64" && arch !== "arm64") return undefined;',
    to: 'if (arch !== "x64" && arch !== "arm64" && arch !== "loong64") return undefined;',
    note: '显式承认 loong64，保持返回 undefined 走命令行剪贴板回退（不加载不存在的 .node）',
  },
  // ── Desktop：Electron 45.1.0 → 龙芯可用 43.7.7 ──
  {
    id: 'electron-43-loong64',
    file: 'apps/desktop/package.json',
    from: '"electron": "45.1.0"',
    to: '"electron": "43.7.7"',
    note: 'electron-loong64 最高 43.7.7；45 无 loong64 预编译且自编译需 >32GiB RAM',
  },
  // ── Desktop：打包 target 去 AppImage（龙芯无 x86_64 fpm/AppImage 工具） ──
  {
    id: 'desktop-linux-target-dir',
    file: 'apps/desktop/electron-builder.config.cjs',
    from: "    target: ['AppImage', 'deb', 'rpm'],",
    to: "    target: ['dir'],",
    note: '龙芯下 AppImage/rpm 走 fpm（x86_64 二进制 + 在线下载），先出 unpacked 目录再由 scripts/10 构造安装包',
  },
  // ── Desktop：Electron 43 不导出 ClipboardItem（45 才有），改用 writeImage ──
  {
    id: 'clipboard-item-import-43',
    file: 'apps/desktop/src/main/screenshot/screenshot-output.ts',
    from: "import { BaseWindow, BrowserWindow, ClipboardItem, Menu, app, clipboard, dialog, ipcMain, screen } from 'electron';",
    to: "import { BaseWindow, BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeImage, screen } from 'electron';",
    note: 'Electron 43 无 ClipboardItem 具名导出；换用 nativeImage',
  },
  {
    id: 'clipboard-writeimage-43',
    file: 'apps/desktop/src/main/screenshot/screenshot-output.ts',
    from: "export async function copyScreenshot(png: Uint8Array): Promise<void> {\n  if (png.byteLength === 0) throw new Error('invalid-png');\n  await clipboard.write([\n    new ClipboardItem({\n      'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }),\n    }),\n  ]);\n}",
    to: "export async function copyScreenshot(png: Uint8Array): Promise<void> {\n  if (png.byteLength === 0) throw new Error('invalid-png');\n  // loong64 port: Electron 43 无 ClipboardItem / clipboard.write(Web API)，改用主进程原生 API\n  await clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)));\n}",
    note: 'writeImage 为 Electron 43 原生能力，功能等价且无 Web API 依赖',
  },
  // ── 全 workspace：pnpm 解析 loong64 平台包 ──
  {
    id: 'supported-arch-loong64',
    file: 'pnpm-workspace.yaml',
    from: 'packages:\n  # Includes the standalone session-import conversion package.',
    to: 'supportedArchitectures:\n  os: [current]\n  cpu: [current, loong64]\n  libc: [current]\n\npackages:\n  # Includes the standalone session-import conversion package.',
    note: '让 pnpm 为 loong64 解析 optional platform 包（缺失的由注入脚本补）',
  },
  // ── Desktop：electron-builder 官方版不认 loong64，换龙芯分支三件套 ──
  {
    id: 'builder-loong64-overrides',
    file: 'pnpm-workspace.yaml',
    from: 'overrides:\n',
    to: 'overrides:\n  "electron-builder": "npm:@loongdotjs/electron-builder@26.15.6"\n  "app-builder-lib": "npm:@loongdotjs/app-builder-lib@26.15.6"\n  "builder-util": "npm:@loongdotjs/builder-util@26.15.3"\n',
    note: '官方 electron-builder 26.15.3 不识别 loong64；龙芯分支 26.15.6 三件套支持 --arch loong64',
  },
  // ── Desktop：允许用本地已校验的 Electron dist，绕开在线下载 ──
  {
    id: 'desktop-electron-dist',
    file: 'apps/desktop/electron-builder.config.cjs',
    from: "  directories: {\n    output: 'dist-app',\n  },",
    to: "  ...(process.env.KIMI_ELECTRON_DIST ? { electronDist: process.env.KIMI_ELECTRON_DIST } : {}),\n  directories: {\n    output: 'dist-app',\n  },",
    note: 'KIMI_ELECTRON_DIST 指向本地 loong64 Electron 目录，避免在线 CDN 下载的架构不匹配与挂起',
  },
  // ── 关键：plugin-dts 0.27+ 引入 yuku 原生解析（无 loong64 包、WASM 又需 SIMD），钉在 0.26.0 用 Babel parser ──
  {
    id: 'plugin-dts-no-yuku',
    file: 'pnpm-workspace.yaml',
    from: '  "kimi-code>@tailwindcss/vite": "4.1.18"',
    to: '  "rolldown-plugin-dts": "0.26.0"\n  "kimi-code>@tailwindcss/vite": "4.1.18"',
    note: '0.26.0 是最后一个不依赖 yuku 原生绑定的版本，改用 Babel parser，绕开 loong64 无解的 yuku-core',
  },
];

let applied = 0, failed = 0;
for (const p of PATCHES) {
  const abs = resolve(kimiRoot, p.file);
  if (!existsSync(abs)) {
    console.error(`MISSING  ${p.id}: ${p.file}`);
    failed += 1;
    continue;
  }
  const src = readFileSync(abs, 'utf8');
  // 幂等判断：目标串出现即视为已应用（替换后 from 可能仍作为子串残留，不能用 !includes(from)）
  const toCount = src.split(p.to).length - 1;
  if (toCount >= 1) {
    console.log(`OK       ${p.id} (已应用)`);
    continue;
  }
  const count = src.split(p.from).length - 1;
  if (count !== 1) {
    console.error(`AMBIG    ${p.id}: 匹配 ${count} 次，期望 1 次`);
    failed += 1;
    continue;
  }
  if (checkOnly) {
    console.log(`PENDING  ${p.id}: ${p.note}`);
    continue;
  }
  writeFileSync(abs, src.replace(p.from, p.to));
  applied += 1;
  console.log(`PATCHED  ${p.id}: ${p.note}`);
}
console.log(`\n共 ${PATCHES.length} 项，本次应用 ${applied}，失败 ${failed}${checkOnly ? '（--check 未写入）' : ''}`);
if (failed) process.exitCode = 1;
