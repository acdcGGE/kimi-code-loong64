#!/usr/bin/env node
/**
 * 把 loong64 原生绑定注入 kimi-code（所有来源均为公开 npm 包，网络获取）。
 * 用法：node scripts/05-inject-native-bindings.mjs [--check] [--kimi=/path]
 *
 * 相对 zcode 的差异：
 *  - rolldown 1.2.15 / rc.15 / rc.12 的 JS 层原生支持 loong64 分支，只缺 .node；
 *    社区 1.2.8 binding 实测可加载三个版本（版本校验默认关闭）
 *  - lightningcss 1.32.0 / 1.30.2 用版本精确对齐的 @loong64/... @1.32.0
 *  - clipboard / pi-tui 无 loong64 包，但源码已有 JS/命令行回退，不强行注入
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveKimiRoot } from './_layout.mjs';

const portRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kimiArg = process.argv.find((a) => a.startsWith('--kimi='));
const kimiRoot = kimiArg ? resolve(kimiArg.slice('--kimi='.length)) : resolveKimiRoot(portRoot);
const checkOnly = process.argv.includes('--check');
const registry = 'https://registry.npmmirror.com';
const cacheDir = join(portRoot, 'downloads', 'native');
const pnpmDir = join(kimiRoot, 'node_modules', '.pnpm');

const BINDINGS = [
  {
    id: 'rolldown',
    community: '@rolldown-loong64/binding-linux-loong64-gnu',
    version: '1.2.8',
    pkgPrefix: 'rolldown@',
    rel: 'node_modules/rolldown/dist/shared/rolldown-binding.linux-loong64-gnu.node',
    note: 'JS 层自带 loong64 分支，社区 1.2.8 binding 兼容 1.2.15 / rc.15 / rc.12',
  },
  {
    id: 'lightningcss',
    community: '@loong64/lightningcss-linux-loong64-gnu',
    version: '1.32.0',
    pkgPrefix: 'lightningcss@',
    rel: 'node_modules/lightningcss/lightningcss.linux-loong64-gnu.node',
    note: '版本精确对齐 lockfile；上游 node/index.js 直接 require 同目录 .node',
  },
  {
    id: 'oxide-4.2.2',
    community: '@tailwindcss/oxide-linux-loong64-gnu',
    version: '4.2.2',
    registry: 'https://registry.loongnix.cn:5873',
    pkgPrefix: '@tailwindcss+oxide@4.2.2',
    rel: 'node_modules/@tailwindcss/oxide/tailwindcss-oxide.linux-loong64-gnu.node',
    note: '龙芯官方源直取，与 lockfile 4.2.2 精确对齐（4.1.18 实例不用此包）',
  },
];

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败: ${r.stderr?.slice(0, 300)}`);
  return r.stdout;
}

function findNodeFile(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const found = findNodeFile(p);
      if (found) return found;
    } else if (e.name.endsWith('.node')) return p;
  }
  return null;
}

/** 扫描 .pnpm 下所有匹配前缀的实例目录 */
function findInstances(prefix) {
  if (!existsSync(pnpmDir)) return [];
  return readdirSync(pnpmDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => join(pnpmDir, e.name))
    .filter((d) => existsSync(join(d, 'node_modules')));
}

const results = [];
let failed = 0;
for (const b of BINDINGS) {
  const result = { id: b.id, community: `${b.community}@${b.version}`, targets: [] };
  // 先确定源文件（--check 不下载）
  let nodeFile = null;
  const tgz = join(cacheDir, `${b.id}-${b.version}.tgz`);
  const unpack = join(cacheDir, `${b.id}-${b.version}`);
  if (!checkOnly) {
    if (!existsSync(tgz)) {
      mkdirSync(cacheDir, { recursive: true });
      const name = b.community.split('/')[1];
      const base = b.registry ?? registry;
      const url = b.registry
        ? `${base}/${b.community.replace('/', '%2f')}/-/${name}-${b.version}.tgz`
        : `${base}/${b.community}/-/${name}-${b.version}.tgz`;
      console.log(`[download] ${b.community}@${b.version}`);
      sh('curl', ['-fsSL', '-m', '180', '-o', tgz, url]);
    }
    if (!existsSync(unpack)) {
      mkdirSync(unpack, { recursive: true });
      sh('tar', ['-xzf', tgz, '-C', unpack]);
    }
    nodeFile = findNodeFile(unpack);
    if (!nodeFile) throw new Error(`${b.id}: tarball 中无 .node`);
    result.sourceFile = basename(nodeFile);
    result.sizeBytes = statSync(nodeFile).size;
  }

  const instances = findInstances(b.pkgPrefix);
  for (const inst of instances) {
    const dest = join(inst, b.rel);
    const pkg = basename(inst).split('_')[0];
    if (checkOnly) {
      result.targets.push({ path: pkg, landed: existsSync(dest) && statSync(dest).size > 0 });
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(nodeFile, dest);
    result.targets.push({ path: pkg, landed: true, bytes: statSync(dest).size });
  }

  result.state = checkOnly ? 'CHECKED' : 'INJECTED';
  results.push(result);
  const ok = result.targets.filter((t) => t.landed).length;
  console.log(`${result.state.padEnd(10)} ${b.id.padEnd(14)} ${ok}/${result.targets.length} 实例  ${b.note}`);
  if (ok === 0) failed += 1;
}

mkdirSync(join(portRoot, 'report'), { recursive: true });
if (!checkOnly) {
  writeFileSync(
    join(portRoot, 'report', 'native-injections.json'),
    `${JSON.stringify({ kimiRoot, injectedAt: new Date().toISOString(), results }, null, 2)}\n`,
  );
}
console.log(`\n共 ${BINDINGS.length} 项，失败 ${failed}`);
if (failed) process.exitCode = 1;
