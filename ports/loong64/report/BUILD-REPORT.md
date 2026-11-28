# Kimi Code loong64 打包报告

2026-11-28 22:45 +08:00，LoongArch64 / Deepin 25。

源码：`main` `a731006`（CLI **2.8.1** / Desktop **1.5.1**）。移植层：`feat/loong64` `8b5591d` + 本次新增的第 11 条主干适配补丁。仓库旧 Release 仍是 2.7.3 / 1.4.3，本次不是重发旧包。

## 工具链

| 组件 | 版本 |
|---|---|
| Node / pnpm | 24.22.3 / 10.33.0（`loong64/node`、npmmirror，均校验） |
| Electron | 43.7.7（`darkyzhou/electron-loong64`，校验） |
| electron-builder | @loongdotjs 26.15.6，支持 `--loong64` |
| 组包 | 本机 dpkg-deb / bsdtar / zstd，不用 x86_64 fpm |

## 验证

- 补丁：原 10 条命中；新增 `sea-supported-target-loong64` 把 `linux-loong64` 加入 `native-deps.mjs` 的 `SUPPORTED_TARGETS`，解决 SEA 的 `Unsupported native asset target`。
- CLI：11/11 PASS，bundle 与 SEA `--version` 均为 2.8.1，原生绑定逐实例可加载。
- Electron API：扫描 5255 文件、49 个具名导入，43 中 0 缺失。
- 安装包：22/22 PASS；deb Depends 26 项（滤除 43 个第三方同名 `.so`），pacman 8 项。
- 桌面冒烟：5/5 PASS，窗口创建、`ui-ready` 均出现。
- CLI 功能：10/10 PASS（隔离 `HOME`，版本/帮助/doctor/provider/session/未知命令）；非法 TOML 的 doctor 负向用例正确 rc=1。
- 独立复核：`sha256sum -c SHA256SUMS.txt` 三项成功；SEA 为 LoongArch ELF，deb/pacman 架构为 `loong64`。

## 产物

| 文件 | 大小 | SHA256 |
|---|---|---|
| `kimi-code-2.8.1-linux-loong64-sea` | 182 MiB | `66456ebe93640e122ad7ddf7f9e0516483519d34f3be94d5b0a2fb9e606e8287` |
| `kimi-code_1.5.1_loong64.deb` | 144 MiB | `b369a4dd7197dd2722bee354bcd301f2b9cc2849bd3c5988e13b80e3a4f209c4` |
| `kimi-code-1.5.1-1-loong64.pkg.tar.zst` | 145 MiB | `62b572d6c20a1ddd619998a62380b6f3f82c40c1ddd3a168e32d96fcf56904a7` |

## 使用

```bash
chmod +x kimi-code-2.8.1-linux-loong64-sea
./kimi-code-2.8.1-linux-loong64-sea --version

sudo dpkg -i kimi-code_1.5.1_loong64.deb
sudo pacman -U kimi-code-1.5.1-1-loong64.pkg.tar.zst
```

社区移植版，非官方发布；Desktop 装到 `/opt/kimi-code/`，启动器 `/usr/bin/kimi-code`。需登录/网络的 `-p <prompt>` 与 `provider catalog` 未测。

工程审查见 `PORT-REVIEW.md`；结构化证据在 `reports/`。
