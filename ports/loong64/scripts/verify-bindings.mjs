#!/usr/bin/env node
// 验证 pnpm 虚拟 store 中的原生模块在 loong64 上确实可加载。
// 背景：pnpm monorepo 根目录 node_modules 不直接链接 rolldown / lightningcss / esbuild，
// 直接 require('rolldown') 失败并不代表 binding 缺失。此脚本按 .pnpm 实例逐个验证。
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT_ROOT = resolve(HERE, '..');
const REPO = resolve(PORT_ROOT, '..', '..');
const PNPM_DIR = join(REPO, 'node_modules', '.pnpm');
const REPORT = join(PORT_ROOT, 'report', 'verify-bindings.json');
const req = createRequire(import.meta.url);

const TARGETS = [
  { id: 'rolldown', kind: 'esm', entry: 'dist/index.mjs', check: (m) => (m.VERSION ? `v${m.VERSION}` : null) },
  { id: 'lightningcss', kind: 'cjs', check: (m) => (typeof m.transform === 'function' ? 'transform ok' : null) },
  { id: 'esbuild', kind: 'cjs', check: (m) => (typeof m.transformSync === 'function' ? `v${m.version}` : null) },
];

function findInstances(id) {
  if (!existsSync(PNPM_DIR)) return [];
  return readdirSync(PNPM_DIR)
    .filter((e) => e.startsWith(`${id}@`))
    .map((e) => join(PNPM_DIR, e, 'node_modules', id))
    .filter((p) => existsSync(p))
    .sort();
}

const results = [];
let failed = 0;
let passed = 0;
for (const t of TARGETS) {
  const instances = findInstances(t.id);
  if (instances.length === 0) {
    results.push({ module: t.id, ok: false, error: 'pnpm 虚拟 store 中无此包实例' });
    console.log(`FAIL  ${t.id} [无实例]`);
    failed++;
    continue;
  }
  for (const pkg of instances) {
    const label = pkg.slice(PNPM_DIR.length + 1).split('/node_modules/')[0];
    try {
      const mod = t.kind === 'esm'
        ? await import(pathToFileURL(join(pkg, t.entry)).href)
        : req(pkg);
      const detail = t.check(mod);
      if (!detail) throw new Error('导出检查未通过');
      results.push({ module: t.id, instance: label, ok: true, detail });
      console.log(`PASS  ${t.id} [${label}] ${detail}`);
      passed++;
    } catch (e) {
      const msg = String(e.message).split('\n')[0];
      results.push({ module: t.id, instance: label, ok: false, error: msg });
      console.log(`FAIL  ${t.id} [${label}] ${msg}`);
      failed++;
    }
  }
}

mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(
  REPORT,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), node: process.version, arch: process.arch, pass: passed, fail: failed, results },
    null,
    2,
  ),
);
console.log(`\n结果: PASS=${passed} FAIL=${failed}`);
process.exit(failed === 0 ? 0 : 1);
