/**
 * Tiny helper used by `hpc-smoke.ts` and CI workflows: the bundles we
 * declare in registry.ts are split into "ship this Phase" (none + fixture)
 * and "ship later" (sql-wasm, pglite). For the latter we return a "should
 * gap" sentinel so the calling code (smoke / orchestrator) can mark the
 * suite as `gap: bundle not yet built (Phase 2)` instead of crashing.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import type { HpcBundleKind } from '../hpc/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SHIPPED_BUNDLES: ReadonlySet<HpcBundleKind> = new Set([
  'none',
  'fixture-archive',
  'sql-wasm',
  'pglite',
]);

export interface BundleReadyResult {
  ready: boolean;
  reason?: string;
}

export function ensureHpcBundle(kind: HpcBundleKind): BundleReadyResult {
  if (kind === 'none') return { ready: true };
  if (!SHIPPED_BUNDLES.has(kind)) {
    return {
      ready: false,
      reason: `bundle "${kind}" not yet built (lands in Phase 2 with sql.js / @electric-sql/pglite)`,
    };
  }
  const dir = path.join(ROOT, 'dist', 'hpc-bundles');
  const manifest = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifest)) {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    if (m[kind]) return { ready: true };
  }
  console.log(`[hpc-bundle] manifest missing or no entry for "${kind}" — running build:hpc-bundles`);
  const result = spawnSync('pnpm', ['run', 'build:hpc-bundles'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    return { ready: false, reason: `build:hpc-bundles failed (exit ${result.status})` };
  }
  return { ready: true };
}

export function ensureHpcBundleOrExit(kind: HpcBundleKind): void {
  const r = ensureHpcBundle(kind);
  if (!r.ready) {
    console.warn(`[hpc-bundle] ${r.reason ?? `bundle "${kind}" not ready`}`);
  }
}

export function ensureHpcBundleForRun(kind: HpcBundleKind): { ok: boolean; reason?: string } {
  const r = ensureHpcBundle(kind);
  return { ok: r.ready, reason: r.reason };
}

