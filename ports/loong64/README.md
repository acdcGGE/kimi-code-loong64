# kimi-code → linux-loong64

把 Kimi Code 的 CLI（bundle + SEA 单二进制）和 Desktop（Electron + deb/pacman）移植到 LoongArch64 / Deepin 25。移植层在 `ports/loong64/`：补丁由 `01-apply-port.mjs` 幂等生成，运行时下载并校验，不夹带本机预置二进制。

## 本分支适配

基于主干 `main` `a731006`（CLI **2.8.1** / Desktop **1.5.1**）。原 10 条补丁全部命中；主干新增 `SUPPORTED_TARGETS` 白名单，需第 11 条补丁 `sea-supported-target-loong64` 放行 `linux-loong64`，否则 SEA 报 `Unsupported native asset target`。构建结果见 `report/BUILD-REPORT.md`。

## 运行时

| 组件 | 版本 | 原因 |
|---|---|---|
| Node | 24.22.3 | SEA 要求 ≥24.15，系统 20.15.1 不满足 |
| pnpm | 10.33.0 | 工程 `packageManager` 指定 |
| Electron | 43.7.7 | 上游 45.1.0 无 loong64 预编译 |
| electron-builder | @loongdotjs 26.15.6 | 官方版不认 loong64，用 `--loong64` |

## 关键障碍与解法

1. rolldown / lightningcss / oxide 缺 loong64 `.node` → 逐 `.pnpm` 实例注入社区包。
2. `yuku-core` 无 loong64 且 WASM 需 SIMD → plugin-dts 钉 0.26.0，软链工程自带 TS 6.0.2。
3. Electron 43 无 `ClipboardItem` → 改用 `clipboard.writeImage(nativeImage.createFromBuffer(...))`。
4. 官方 builder 不认 loong64 → 换龙芯三件套；AppImage/rpm 依赖 x86_64 fpm → `target: ['dir']`，再用本机 dpkg-deb / bsdtar / zstd 组包。
5. node-pty 无 prebuild → 本地编译 N-API，Node 24 与 Electron 43 双验证后落地。
6. SEA 的 clipboard-target / pi-tui 无 loong64 资产 → 跳过 native-only 依赖，运行期回退 OSC52 / 命令行。
7. 主干新增目标白名单 → 第 11 条补丁放行 `linux-loong64`。

## 复现

```bash
cd ports/loong64
./scripts/00-fetch-runtime.sh
node scripts/01-apply-port.mjs --check        # 看输出，PENDING 不返回非零
node scripts/01-apply-port.mjs                # 应用 11 条补丁
./scripts/02-install.sh
node scripts/05-inject-native-bindings.mjs
node scripts/06-ts6-for-plugin-dts.mjs
./scripts/07-stage-node-pty.sh
./scripts/03-build-cli.sh && ./scripts/04-verify-cli.sh
node scripts/08-audit-electron-api.mjs
./scripts/09-build-desktop.sh all
node scripts/10-package-linux.mjs
./scripts/11-smoke-desktop.sh
```

`pnpm install` 会清掉注入的 `.node` 和软链，install 后必须重跑 `05`、`06`、`07`。

## 结果

CLI **11/11**、安装包 **22/22**、桌面冒烟 **5/5** PASS；Electron API 0 缺失；CLI 本地功能 **10/10** PASS。

- SEA：`apps/kimi-code/dist-native/bin/linux-loong64/kimi`（LoongArch ELF，182 MiB，`--version` = 2.8.1）
- 安装包：`apps/desktop/dist-app/*_loong64.deb`、`*-loong64.pkg.tar.zst`

证据链：`report/*.json`、`report/BUILD-REPORT.md`、`report/PORT-REVIEW.md`。构建日志不入库，按上述脚本可复现。
