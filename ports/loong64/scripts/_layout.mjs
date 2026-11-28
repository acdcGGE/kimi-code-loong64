import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const portRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function resolveKimiRoot(portRootDir = portRoot) {
  const repoRoot = resolve(portRootDir, '..', '..');
  if (existsSync(resolve(repoRoot, 'package.json')) && existsSync(resolve(repoRoot, 'apps', 'kimi-code'))) {
    return repoRoot;
  }
  return resolve(portRootDir, '..', 'kimi-code');
}
