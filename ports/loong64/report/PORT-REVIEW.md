# ports/loong64 工程审查

对象：`feat/loong64` `8b5591d`。应用到主干 `main` `a731006`（CLI 2.8.1 / Desktop 1.5.1）：原 10 条补丁全部命中；主干新增 `SUPPORTED_TARGETS` 白名单（`native-deps.mjs:1-8,54-57`），补第 11 条 `sea-supported-target-loong64` 放行后 SEA 通过。

## P1

1. **摘要同源自证** — `00-fetch-runtime.sh:42-52,88-95`：摘要来自同目录 `.sha256` / 同站 `SHASUMS256.txt`，只防传输损坏，未固定独立值，也未用 GPG 签名。
2. **解压未防穿越** — `00-fetch-runtime.sh:56,100,107`、`05-inject-native-bindings.mjs:101`、`07-stage-node-pty.sh:69`：直接解压，未校验成员路径。
3. **`--check` 假阳性** — `01-apply-port.mjs:124-126`：PENDING 不计 `failed`，退出码仍为 0；实测未打补丁时 10 条 PENDING 仍 `echo $?` = 0。
4. **报告引用缺失** — `PORTING-REPORT.md:14` 的 `desktop-*.json`、`DEPENDENCY-AUDIT.json:18` 的 `fetch-runtime.log` 都不在入库 `report/`。
5. **时序倒挂** — 入库 `verify-bindings.json` / `verify-cli.json` 早于 `native-injections.json` / `node-pty.json`，而 `pnpm install` 会清注入；最终注入状态未被后续验证覆盖。

## P2

- `02-install.sh:19` 用 `--no-frozen-lockfile`；版本在 6 处硬编码。
- `05-inject-native-bindings.mjs:114,122-126` 的 `--check` 仅判非空；oxide 走 `registry.loongnix.cn:5873` 且无 SHA。
- `verify-bindings.mjs:17-21` 未覆盖 oxide；`06-ts6-for-plugin-dts.mjs:20-26,55` 零实例仍退出 0。
- `08-audit-electron-api.mjs:62` 用 `lastIndexOf("import")` 文本启发式；SEA 的 SHA 只见于 Markdown，无 JSON。
- 部分入库 JSON 的 `kimiRoot` 为 `"."`，与脚本输出不符。

## 可取之处

- 补丁是精确替换 + 幂等判断，本机对新主干 10/10 可用，障碍与解法一一对应。
- `10-package-linux.mjs` 对架构、Depends、软链、desktop 文件、setuid、pacman 元数据均做了实际断言。

## 结论

工程可复现、补丁与包校验扎实；但摘要同源自证、证据链缺口与 `--check` 假阳性使入库报告不能当独立可信证据。本机已按 README 重跑，以实际产物为准。
