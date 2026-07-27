/**
 * Build content-hashed HPC bundle tarballs and emit a manifest.
 *
 * Each bundle kind corresponds to a tile of files the workload scripts
 * pull into a fresh sandbox:
 *
 *   fixture-archive  → benchmarks/hpc/fixtures/node-tooling/*
 *                       (used by cpu-node + realworld)
 *   sql-wasm         → vendored sql.js + sql-wasm.wasm from node_modules
 *                       (used by system — SQLite Speedtest)
 *   pglite           → vendored @electric-sql/pglite and its chunks
 *                       (used by pgbench — embedded PG bench)
 *
 * Output:
 *   dist/hpc-bundles/<kind>-<sha256[0..10]>.tar.gz
 *   dist/hpc-bundles/manifest.json
 *
 * Idempotent: only re-writes sources whose contents changed.
 *
 * Run with: `pnpm run build:hpc-bundles`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(ROOT, 'dist', 'hpc-bundles');
const FIXTURE_ROOT = path.join(ROOT, 'benchmarks', 'hpc', 'fixtures', 'node-tooling');
const NODE_MODULES = path.join(ROOT, 'node_modules');

interface BundleEntry {
  kind: string;
  hash: string;
  path: string;
  bytes: number;
  version: string;
  sourceDir: string;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Layout convention for bundle kinds:
 *
 *   fixture-archive  → tar root contains `./BENCH_VERSION.txt`, `./package.json`,
 *                       `./src/index.js` etc. Extracted to `/tmp/hpc/fixture`
 *                       yields the expected fixture files at root.
 *
 *   sql-wasm / pglite → tar root contains `./node_modules/<pkg>/...`.
 *                       Extracted to `/tmp/hpc/fixture` yields
 *                       `/tmp/hpc/fixture/node_modules/<pkg>/...` so the
 *                       workload can `require('/tmp/hpc/fixture/node_modules/...')`.
 *
 * Both `packSrcDir` and `packFromModule` emit tarballs that match one of the
 * two layouts; the orchestrator just does `tar -xzf ... -C /tmp/hpc/fixture`.
 */
function packSrcDir(srcDir: string, baseName: string): { buffer: Buffer; basename: string; version: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpc-bundle-'));
  // fixture-archive: copy contents straight to root (no `fixture/` wrapper)
  // so `tar -C <extract-dir>` returns the bare tree.
  copyDirRecursive(srcDir, tmp);
  const tarPath = path.join(os.tmpdir(), `${baseName}.tar`);
  const c1 = spawnSync('tar', ['-cf', tarPath, '-C', tmp, '.'], { encoding: 'utf8' });
  if (c1.status !== 0) throw new Error(`tar pack failed: ${c1.stderr}`);
  const c2 = spawnSync('gzip', ['-n', '-9', tarPath], { encoding: 'utf8' });
  if (c2.status !== 0) throw new Error(`gzip failed: ${c2.stderr}`);
  const gzPath = `${tarPath}.gz`;
  const buffer = fs.readFileSync(gzPath);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(gzPath, { force: true });
  return {
    buffer,
    basename: `${baseName}-${sha256(buffer).slice(0, 10)}.tar.gz`,
    version: readVersionFor(baseName),
  };
}

function packFromModule(pkgName: string, baseName: string, includeGlobs: ((root: string) => string[])): { buffer: Buffer; basename: string; version: string } {
  const pkgRoot = path.join(NODE_MODULES, pkgName);
  if (!fs.existsSync(pkgRoot)) {
    throw new Error(`Cannot build ${baseName}: ${pkgRoot} not found. Did you run \`pnpm install\`?`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpc-bundle-'));
  const includedFiles = includeGlobs(pkgRoot);
  if (includedFiles.length === 0) {
    throw new Error(`No files matched for ${baseName} (pkg=${pkgName})`);
  }
  // node_modules bundle layout: put pkg under ./node_modules/<pkg>/ in the
  // tarball. Extraction with `-C /tmp/hpc/fixture` lands at
  // `/tmp/hpc/fixture/node_modules/<pkg>/...`.
  const destRoot = path.join(tmp, 'node_modules', pkgName);
  for (const src of includedFiles) {
    const rel = path.relative(pkgRoot, src);
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  const tarPath = path.join(os.tmpdir(), `${baseName}.tar`);
  const c1 = spawnSync('tar', ['-cf', tarPath, '-C', tmp, '.'], { encoding: 'utf8' });
  if (c1.status !== 0) throw new Error(`tar pack failed: ${c1.stderr}`);
  const c2 = spawnSync('gzip', ['-n', '-9', tarPath], { encoding: 'utf8' });
  if (c2.status !== 0) throw new Error(`gzip failed: ${c2.stderr}`);
  const gzPath = `${tarPath}.gz`;
  const buffer = fs.readFileSync(gzPath);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(gzPath, { force: true });
  return {
    buffer,
    basename: `${baseName}-${sha256(buffer).slice(0, 10)}.tar.gz`,
    version: readPkgVersion(pkgName),
  };
}

function readPkgVersion(pkgName: string): string {
  const pkgJsonPath = path.join(NODE_MODULES, pkgName, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function readVersionFor(baseName: string): string {
  if (baseName === 'fixture-archive') {
    const v = path.join(FIXTURE_ROOT, 'BENCH_VERSION.txt');
    if (!fs.existsSync(v)) throw new Error(`Missing fixture version file: ${v}`);
    return fs.readFileSync(v, 'utf8').trim();
  }
  return '0.0.0';
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, e.name);
    const dp = path.join(dest, e.name);
    if (e.isDirectory()) copyDirRecursive(sp, dp);
    else fs.copyFileSync(sp, dp);
  }
}

function main(): void {
  ensureDir(OUT_DIR);

  const manifest: Record<string, BundleEntry> = {};

  // ---- fixture-archive: vendored Node tooling fixture ----
  if (fs.existsSync(FIXTURE_ROOT)) {
    const { buffer, basename, version } = packSrcDir(FIXTURE_ROOT, 'fixture-archive');
    fs.writeFileSync(path.join(OUT_DIR, basename), buffer);
    manifest['fixture-archive'] = {
      kind: 'fixture-archive',
      hash: sha256(buffer),
      path: basename,
      bytes: buffer.byteLength,
      version,
      sourceDir: 'benchmarks/hpc/fixtures/node-tooling',
    };
  }

  // ---- sql-wasm: sql.js + sql-wasm.js + sql-wasm.wasm ----
  try {
    const { buffer, basename, version } = packFromModule('sql.js', 'sql-wasm', root => {
      const wanted = new Set([
        'package.json',
        'dist/sql-wasm.js',
        'dist/sql-wasm.wasm',
      ]);
      const out: string[] = [];
      for (const f of wanted) {
        const full = path.join(root, f);
        if (fs.existsSync(full)) out.push(full);
      }
      return out;
    });
    fs.writeFileSync(path.join(OUT_DIR, basename), buffer);
    manifest['sql-wasm'] = {
      kind: 'sql-wasm',
      hash: sha256(buffer),
      path: basename,
      bytes: buffer.byteLength,
      version,
      sourceDir: 'node_modules/sql.js',
    };
  } catch (err) {
    console.warn(`  (skip sql-wasm) ${err instanceof Error ? err.message : err}`);
  }

  // ---- pglite: vendored @electric-sql/pglite (the in-browser Postgres) ----
  try {
    const { buffer, basename, version } = packFromModule('@electric-sql/pglite', 'pglite', root => {
      // pglite ships dist/chunks + extension tarballs. We bundle the
      // dist directory + a few extension tarballs that pgbench needs.
      const out: string[] = [];
      function pushIfExists(rel: string) {
        const full = path.join(root, rel);
        if (fs.existsSync(full)) out.push(full);
      }
      pushIfExists('package.json');
      pushIfExists('README.md');
      pushIfExists('LICENSE');
      // The whole dist dir is small (<8 MB) and the resolve.wasm lives there.
      const distPath = path.join(root, 'dist');
      if (fs.existsSync(distPath)) {
        for (const e of fs.readdirSync(distPath, { withFileTypes: true })) {
          if (e.isFile()) out.push(path.join(distPath, e.name));
        }
      }
      return out;
    });
    fs.writeFileSync(path.join(OUT_DIR, basename), buffer);
    manifest['pglite'] = {
      kind: 'pglite',
      hash: sha256(buffer),
      path: basename,
      bytes: buffer.byteLength,
      version,
      sourceDir: 'node_modules/@electric-sql/pglite',
    };
  } catch (err) {
    console.warn(`  (skip pglite) ${err instanceof Error ? err.message : err}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${Object.keys(manifest).length} bundle(s) to ${path.relative(ROOT, OUT_DIR)}/`);
  for (const [key, entry] of Object.entries(manifest)) {
    const sizeKb = (entry.bytes / 1024).toFixed(1);
    console.log(`  • ${key}: ${entry.path} (${sizeKb} KiB, v${entry.version}, sha256 ${entry.hash.slice(0, 10)})`);
  }
}

main();
