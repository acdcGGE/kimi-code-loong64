#!/usr/bin/env node
/**
 * 08-audit-electron-api.mjs
 *
 * 目的：找出源码中「从 electron 静态具名导入、但目标 Electron 版本并不导出」的符号。
 *
 * 背景：ESM 的具名导入在模块链接期校验导出表，缺失即抛
 *   SyntaxError: The requested module 'electron' does not provide an export named 'X'
 * 整个主进程直接退出。因此在 loong64（Electron 43）上必须提前把所有 44-only API 找出来。
 *
 * 用法：
 *   node 08-audit-electron-api.mjs [--repo <Kimi Code 路径>] [--dts <electron.d.ts>] [--json <输出>]
 * 退出码：0 = 无非类型缺失；1 = 存在缺失；2 = 前置条件不满足
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveKimiRoot } from "./_layout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT_ROOT = resolve(HERE, "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const REPO = resolve(opt("repo", resolveKimiRoot(PORT_ROOT)));
const DTS = resolve(opt("dts", [
  join(REPO, "apps", "desktop", "node_modules", "electron", "electron.d.ts"),
  join(REPO, "node_modules", "electron", "electron.d.ts"),
].find((p) => existsSync(p)) ?? join(REPO, "node_modules", "electron", "electron.d.ts")));
const JSON_OUT = opt("json", join(HERE, "..", "report", "electron-api-audit.json"));

const SOURCE_ROOTS = ["packages", "apps"].map((d) => join(REPO, d));

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "out" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 从源码中抽取所有 `import { ... } from "electron"` 的具名绑定 */
function collectImports(file) {
  const src = readFileSync(file, "utf8");
  const hits = [];
  // 以 `from "electron"` 为锚点回溯最近的 import 语句，避免跨语句贪婪匹配
  const anchor = /from\s*["']electron["']/g;
  let m;
  while ((m = anchor.exec(src))) {
    const prefix = src.slice(0, m.index);
    const importIdx = Math.max(prefix.lastIndexOf("import"), prefix.lastIndexOf("\nimport"));
    if (importIdx < 0) continue;
    const segment = src.slice(importIdx, m.index);
    const open = segment.indexOf("{");
    const close = segment.lastIndexOf("}");
    if (open < 0 || close < open) continue; // 默认导入 / 命名空间导入，无具名绑定
    const typeOnlyBlock = /^import\s+type\b/.test(segment);
    const line = src.slice(0, importIdx).split("\n").length;
    for (const raw of segment.slice(open + 1, close).split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      const parts = spec.split(/\s+as\s+/);
      const left = parts[0].trim();
      const alias = (parts[1] ?? "").trim();
      const isType = typeOnlyBlock || /^type\s+/.test(left);
      const name = left.replace(/^type\s+/, "").trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      hits.push({ file, line, name, alias, isType });
    }
  }
  return hits;
}

/** electron.d.ts 中该名字是否以「值」的形式声明 */
function classify(dts, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b(class|const|let|var|function|enum)\\s+${esc}\\b`).test(dts)) return "value";
  if (new RegExp(`\\b(interface|type)\\s+${esc}\\b`).test(dts)) return "type";
  return "absent";
}

let dts;
try {
  dts = readFileSync(DTS, "utf8");
} catch {
  console.error(`[audit] 找不到 electron.d.ts: ${DTS}`);
  process.exit(2);
}
const version = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(DTS), "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
})();

const files = SOURCE_ROOTS.flatMap((root) => walk(root));
const imports = files.flatMap(collectImports);

const byName = new Map();
for (const imp of imports) {
  if (!byName.has(imp.name)) byName.set(imp.name, []);
  byName.get(imp.name).push(imp);
}

const missing = [];
const typeOnly = [];
for (const [name, uses] of [...byName].sort()) {
  const kind = classify(dts, name);
  if (kind === "value") continue;
  const valueUses = uses.filter((u) => !u.isType);
  if (kind === "type" && valueUses.length === 0) {
    typeOnly.push({ name, uses: uses.length });
    continue;
  }
  missing.push({
    name,
    declaredAs: kind,
    valueUses: valueUses.length,
    sites: valueUses.map((u) => `${relative(REPO, u.file)}:${u.line}`),
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  electronTypings: version,
  scannedFiles: files.length,
  distinctElectronImports: byName.size,
  importSites: imports.length,
  missing,
  typeOnlyImports: typeOnly.map((t) => t.name),
};

writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + "\n");

console.log(`[audit] electron 类型版本 ${version} · 扫描 ${files.length} 个源文件 · ${byName.size} 个不同的 electron 具名导入`);
if (missing.length === 0) {
  console.log("[audit] ✅ 所有值导入在目标版本中均存在");
  process.exit(0);
}
console.log(`[audit] ❌ 发现 ${missing.length} 个在 ${version} 中不可用的值导入：`);
for (const m of missing) {
  console.log(`  - ${m.name}  (${m.declaredAs === "type" ? "仅类型声明" : "完全不存在"}) ${m.valueUses} 处使用`);
  for (const s of m.sites.slice(0, 6)) console.log(`      ${s}`);
  if (m.sites.length > 6) console.log(`      … 另 ${m.sites.length - 6} 处`);
}
process.exit(1);
