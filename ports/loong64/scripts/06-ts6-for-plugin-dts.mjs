#!/usr/bin/env node
/**
 * rolldown-plugin-dts 0.26.0 用 tsc generator 生成声明，但其 peer typescript 被工程解析到 7.0.2，
 * 而 0.26.0 只兼容 TS <=6（ts.sys API 变更导致 useCaseSensitiveFileNames 报错）。
 * 工程已自带 typescript-legacy = npm:typescript@6.0.2，本脚本在 plugin-dts 的 node_modules 下
 * 建立 typescript -> TS 6.0.2 的软链，使其就近解析到兼容版本（不动工程源码、不改 lockfile）。
 * 用法：node scripts/06-ts6-for-plugin-dts.mjs [--check] [--kimi=/path]
 */
import { existsSync, mkdirSync, symlinkSync, readlinkSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKimiRoot } from './_layout.mjs';

const portRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kimiArg = process.argv.find((a) => a.startsWith('--kimi='));
const kimiRoot = kimiArg ? resolve(kimiArg.slice('--kimi='.length)) : resolveKimiRoot(portRoot);
const checkOnly = process.argv.includes('--check');
const pnpmDir = join(kimiRoot, 'node_modules', '.pnpm');

function findInstances() {
  if (!existsSync(pnpmDir)) return [];
  return readdirSync(pnpmDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('rolldown-plugin-dts@0.26.0'))
    .map((e) => join(pnpmDir, e.name, 'node_modules', 'rolldown-plugin-dts'))
    .filter((d) => existsSync(join(d, 'dist')));
}

// TS 6.0.2 真实目录
const ts6Root = join(pnpmDir, 'typescript@6.0.2', 'node_modules', 'typescript');
if (!existsSync(ts6Root)) {
  console.error(`找不到 TypeScript 6.0.2: ${ts6Root}`);
  process.exit(2);
}

let changed = 0, failed = 0;
for (const inst of findInstances()) {
  const link = join(inst, 'node_modules', 'typescript');
  let ok = false;
  if (existsSync(link) || (lstatSync(link, { throwIfNoEntry: false }) !== undefined)) {
    try { ok = resolve(readlinkSync(link)) === resolve(ts6Root); } catch { ok = false; }
  }
  if (checkOnly) {
    console.log(`${ok ? 'OK      ' : 'PENDING '} ${inst.split('/').slice(-2)[0]} TS6 link`);
    if (!ok) failed += 1;
    continue;
  }
  if (ok) { console.log(`OK       TS6 link already set`); continue; }
  mkdirSync(dirname(link), { recursive: true });
  // 若已存在普通目录/错误链接，先移除
  try { rmSync(link, { recursive: true, force: true }); } catch {}
  symlinkSync(ts6Root, link, 'dir');
  changed += 1;
  console.log(`PATCHED  ${inst.split('/').slice(-2)[0]} -> TypeScript 6.0.2`);
}
console.log(`\nTS6 链接：应用 ${changed}，失败 ${failed}${checkOnly ? '（--check 未写入）' : ''}`);
if (failed) process.exitCode = 1;
