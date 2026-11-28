# kimi-code loong64 移植报告

**源码**：`acdcGGE/kimi-code` @ `f85f504`（monorepo 0.1.1 / CLI 2.7.3 / Desktop 1.4.3）
**目标**：LoongArch64 / Deepin 25，CLI + Desktop 全做。**结论**：两条线均构建、验证、打包完成。

## 结果总览

| 阶段 | 结果 | 证据 |
|---|---|---|
| 运行时 | Node 24.22.3 / pnpm 10.33.0 / Electron 43.7.7 | `runtime.json`，SHA256 校验 |
| 源码补丁 | 10/10 幂等，`--check` 全 OK | `scripts/01-apply-port.mjs` |
| CLI | bundle + SEA 成功，验证 12/12 PASS | `verify-cli.json`、`verify-bindings.json` |
| Electron API | 0 缺失（5153 源文件 / 49 具名导入） | `electron-api-audit.json` |
| Desktop | renderer 6026 模块 / tsdown 21 文件 / builder `--loong64` | `desktop-*.json` 对应日志可复现 |
| 安装包 | 22/22 PASS | `linux-packages.json` |
| 启动冒烟 | 5/5 PASS（window-created + ui-ready） | `smoke-desktop.json` |

## 产物

| 文件 | 大小 | SHA256 |
|---|---|---|
| `dist-native/bin/linux-loong64/kimi` | 181 MiB | `c48a4b8f50ac18edbb510a8d3eea2446ca72f36a6929155fa75aea282645bda1` |
| `kimi-code_1.4.3_loong64.deb` | 144 MiB | `d470fa68166435f1b20eec6af19ced6af55765ad7e9444e88e4bc96fba4335d0` |
| `kimi-code-1.4.3-1-loong64.pkg.tar.zst` | 145 MiB | `abf22da6e93bfbe94144a442eae58e1d079dccc79908a78b898fe12cf70ad1f7` |
| `linux-loong64-unpacked/` | 441 MiB | LoongArch ELF，含 node-pty loong64 prebuild |

CLI SEA 为 `ELF 64-bit LSB executable, LoongArch`，`--version` = `2.7.3`；Desktop 为 `platform=linux arch=loong64 electron=43.7.7`。

## 关键决策

- **Node 24.22.3 / Electron 43.7.7**：SEA 硬检查 ≥24.15；上游 Electron 45 无龙芯预编译。
- **`ClipboardItem` 降级**：Electron 43 不导出该符号，ESM 具名导入会在链接期杀死主进程；改用 `clipboard.writeImage(...)`，审计 1 缺失 → 0。
- **yuku 绕开**：`rolldown-plugin-dts` 0.27+ 无 loong64 binding，WASM 回退需 SIMD；钉 0.26.0 + TS6 软链。
- **原生绑定**：rolldown 4 / lightningcss 2 / oxide 1 实例，按 `.pnpm` 逐实例验证（根 `require` 失败是 pnpm 布局的假阴性）。
- **electron-builder 龙芯分支**：用 `--loong64`；`--arch loong64` 报“无法识别的选项”。`KIMI_ELECTRON_DIST` 指向本地已校验 Electron。
- **node-pty**：`postinstall` 编出的 LoongArch N-API 模块 `NEEDED` 无 `libnode`，Electron 43 与 Node 24 双加载通过。
- **安装包**：`linux.target=['dir']` + 本机 dpkg-deb 1.22.6 / bsdtar 3.7.4 / zstd 1.5.7；26 项 Depends 由 `readelf DT_NEEDED + dpkg -S` 白名单过滤，滤除 42 个同名 `.so` 误命中。
- **冒烟判据**：以日志 `ui-ready` 为准。龙芯 X11 下 GPU 子进程被 TERM 时的 SIGILL 是退出噪声，不是启动失败。

## 依赖来源

全部二进制来自 GitHub / npm / 龙芯源并校验，无本机预置；主机打包工具只用于构建。详见 `DEPENDENCY-AUDIT.json`。

复现见 `README.md`；`pnpm install` 后必须重跑 `05`（绑定注入）、`06`（TS6 软链）、`07`（node-pty 落地）。
