/**
 * Shared helper: ensures bundle tarballs are built before a benchmark run.
 * Used by benchmark orchestrators and CI workflows.
 *
 * Bundles are content-hashed tarballs in dist/bundles/ with a manifest.json.
 * If the manifest is missing or doesn't contain the requested kind, we
 * run `pnpm run build:bundles` to rebuild.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SHIPPED_BUNDLES: ReadonlySet<string> = new Set([
  'none',
  'fixture-archive',
  'sql-wasm',
  'pglite',
]);

export interface BundleReadyResult {
  ready: boolean;
  reason?: string;
}

export function ensureBundle(kind: string): BundleReadyResult {
  if (kind === 'none') return { ready: true };
  if (!SHIPPED_BUNDLES.has(kind)) {
    return {
      ready: false,
      reason: `bundle "${kind}" not yet built`,
    };
  }
  const dir = path.join(ROOT, 'dist', 'bundles');
  const manifest = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifest)) {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    if (m[kind]) return { ready: true };
  }
  console.log(`[bundle] manifest missing or no entry for "${kind}" — running build:bundles`);
  const result = spawnSync('pnpm', ['run', 'build:bundles'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    return { ready: false, reason: `build:bundles failed (exit ${result.status})` };
  }
  return { ready: true };
}

export function ensureBundleForRun(kind: string): { ok: boolean; reason?: string } {
  const r = ensureBundle(kind);
  return { ok: r.ready, reason: r.reason };
}
