# kimi-code → linux-loong64

把 [acdcGGE/kimi-code](https://github.com/acdcGGE/kimi-code) 的 **CLI（bundle + SEA 单二进制）** 和 **Desktop（Electron + deb/pacman）** 移植到 LoongArch64 / Deepin 25。

移植层位于 `ports/loong64/`：源码改动由 `scripts/01-apply-port.mjs` 幂等生成（`--check` 审计），二进制全部网络下载并校验，不夹带本机预置。

## 运行时

| 组件 | 版本 | 来源 / 原因 |
|---|---|---|
| Node | 24.22.3 | `loong64/node`；SEA 要求 ≥24.15（系统 20.15.1 不满足） |
| pnpm | 10.33.0 | 工程 `packageManager` 指定 |
| Electron | 43.7.7 | `darkyzhou/electron-loong64`；上游 45.1.0 无龙芯预编译 |
| electron-builder | @loongdotjs 26.15.6 | 官方 26.15.3 不认 loong64；龙芯分支提供 `--loong64` |

`00-fetch-runtime.sh` 校验 SHA256 后落地 `opt/`，证据 `report/runtime.json`。

## 关键障碍与解法

1. rolldown / lightningcss / oxide 缺 loong64 `.node` → 注入社区包到所有 `.pnpm` 实例（4 / 2 / 1 个）。
2. `yuku-core` 无 loong64 binding，WASM 需 SIMD → `rolldown-plugin-dts` override 钉 **0.26.0**（Babel parser）。
3. plugin-dts 0.26.0 不兼容 TS7 → 软链到工程自带 `typescript-legacy@6.0.2`。
4. Electron 43 缺 `ClipboardItem` → 改用 `clipboard.writeImage(nativeImage.createFromBuffer(...))`。
5. 官方 electron-builder 不认 loong64 → 换龙芯三件套，用 `--loong64`（**不是** `--arch loong64`）。
6. AppImage / rpm 要 x86_64 工具 → `target: ['dir']`，再用本机 dpkg-deb / bsdtar / zstd 构造安装包。
7. node-pty 无 prebuild → `postinstall` 编出干净 N-API 模块，双运行时验证后落地 `prebuilds/linux-loong64/`。
8. SEA 收集原生资产时 clipboard-target / pi-tui 映射为 `undefined` → loong64 跳过 native-only 依赖，运行期用 OSC52 / 命令行回退。

## 复现

```bash
cd ports/loong64
./scripts/00-fetch-runtime.sh
node scripts/01-apply-port.mjs --check        # 审计补丁
node scripts/01-apply-port.mjs                # 应用 10 条补丁
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

**注意**：`pnpm install` 会清掉注入的 `.node` 和软链，install 后必须重跑 `05`、`06`、`07`。

## 结果与产物

CLI **12/12 PASS**；Electron API 审计 **0 缺失**；Desktop `linux/loong64/electron 43.7.7` 打包成功；安装包 **22/22 PASS**；启动冒烟 **5/5 PASS**。

- CLI SEA：`apps/kimi-code/dist-native/bin/linux-loong64/kimi`（LoongArch ELF，181 MiB，`--version` = 2.7.3）
- Desktop unpacked：`apps/desktop/dist-app/linux-loong64-unpacked/`（441 MiB）
- 安装包：`apps/desktop/dist-app/*_loong64.deb`、`*-loong64.pkg.tar.zst`

证据链：`report/*.json`（结构化结果）、`report/PORTING-REPORT.md`（结论）、`report/DEPENDENCY-AUDIT.json`（依赖来源）。构建日志不入库，可由上述脚本复现。
