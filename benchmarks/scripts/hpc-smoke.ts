/**
 * HPC smoke harness. Runs a suite locally (no ComputeSDK, no cloud sandbox)
 * and asserts the workload emits a parseable WorkloadResult JSON line.
 *
 * Use this when wiring up a new suite (`pnpm run hpc:smoke --suite=memory`).
 * It is the fastest signal that the workload ITSELF (not the cloud plumbing)
 * works end to end — fixture ok, parse-stdout ok, scoreMetric ok.
 *
 * This is NOT a substitute for an end-to-end run against every ComputeSDK
 * provider — the test surface for that is `pnpm bench:hpc:<suite> --provider
 * <name> --hpc-replicas 1` once credentials are wired.
 *
 * Mirrors the orchestrator's split-upload approach: each piece ships as
 * b64 heredocs in 60 KiB chunks to stay clear of ARG_MAX.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { parseWorkloadResult } from '../sandbox/hpc/util/parse-stdout.js';
import { scoreMetric } from '../sandbox/hpc/scoring.js';
import { getSuite, getSuiteIds } from '../sandbox/hpc/registry.js';
import { getBundlePath } from '../sandbox/hpc/util/upload-bundle.js';
import { ensureHpcBundle } from './ensure-hpc-bundle.js';
import type { HpcSuite } from '../sandbox/hpc/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function getArg(flag: string): string | undefined {
  // pnpm forwards `--` literally, so strip it before scanning for flags.
  // Also handle both `--flag value` and `--flag=value` forms.
  const args = process.argv.slice(2).filter(a => a !== '--');
  for (const arg of args) {
    if (arg === flag) continue;
    if (arg.startsWith(flag + '=')) return arg.slice(flag.length + 1);
  }
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function listArg(flag: string): string[] {
  const v = getArg(flag);
  if (!v) return [];
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

function runOne(suiteId: string): boolean {
  const suite = getSuite(suiteId as any);
  const bundleCheck = ensureHpcBundle(suite.bundle);
  if (!bundleCheck.ready) {
    console.log(`    \u2014 skipped (${suite.bundle}): ${bundleCheck.reason}`);
    return true; // gap isn't a fail in dev mode
  }

  const bundlePath = suite.bundle === 'none' ? null : getBundlePath(suite.bundle as 'fixture-archive');

  console.log(`\n[hpc-smoke] \u25b6 ${suite.id}  (${suite.label})`);
  if (suite.bundle === 'fixture-archive') {
    const v = fs.readFileSync(
      path.join(ROOT, 'benchmarks', 'sandbox', 'hpc', 'fixtures', 'node-tooling', 'BENCH_VERSION.txt'),
      'utf8',
    ).trim();
    console.log(`    fixture: benchmarks/sandbox/hpc/fixtures/node-tooling v${v}`);
  }
  console.log(`    ceiling: ${suite.ceiling} ${suite.unit} (${suite.higherIsBetter ? '\u2191 better' : '\u2193 better'})`);

  const workdir = `/tmp/hpc-smoke-${process.pid}-${Date.now()}`;
  fs.mkdirSync(workdir, { recursive: true });
  const startedAt = Date.now();
  const result = runSmokeLocally(suite, workdir, bundlePath);
  spawnSync('rm', ['-rf', workdir]);
  const elapsedMs = Date.now() - startedAt;

  if (result.error) {
    console.error(`[hpc-smoke] \u2717 spawn failed: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`[hpc-smoke] \u2717 exit ${result.status}`);
    console.error(result.stderr || '(no stderr)');
    return false;
  }

  const parsed = parseWorkloadResult(result.stdout, suite.id);
  if (!parsed.ok) {
    console.error(`[hpc-smoke] \u2717 parse failed (reason: ${parsed.reason ?? 'unknown'})`);
    if ('error' in parsed && parsed.error) console.error(`    error: ${parsed.error}`);
    return false;
  }

  const score = scoreMetric(parsed.metric.value, suite);
  console.log(`    \u2713 ${parsed.metric.value.toLocaleString()} ${parsed.metric.unit} in ${elapsedMs} ms (score ${score.toFixed(1)}/100)`);
  return true;
}

/**
 * Mirror the orchestrator's split-upload approach for local testing.
 * Reads the workload script + bundle, writes /tmp/hpc/<name> in B64 chunks
 * via heredoc to a single bash script on disk, then runs `node <workload>.js`.
 */
function runSmokeLocally(
  suite: HpcSuite,
  workdir: string,
  bundlePath: string | null,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const WORKLOAD_DIR = path.resolve(__dirname, '..', 'sandbox', 'hpc', 'workload');
  const workloadPath = path.join(WORKLOAD_DIR, path.basename(suite.workloadPath));
  const stdoutPath = path.join(WORKLOAD_DIR, 'stdout.js');

  const scriptB64 = Buffer.from(fs.readFileSync(workloadPath, 'utf8'), 'utf8').toString('base64');
  const stdoutB64 = fs.existsSync(stdoutPath)
    ? Buffer.from(fs.readFileSync(stdoutPath, 'utf8'), 'utf8').toString('base64')
    : null;
  const bundleB64 = bundlePath ? fs.readFileSync(bundlePath).toString('base64') : null;

  const B64_CHUNK = 60 * 1024;
  function chunks(s: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < s.length; i += B64_CHUNK) out.push(s.slice(i, i + B64_CHUNK));
    return out;
  }

  const scriptName = path.basename(suite.workloadPath);
  const lines: string[] = [
    '#!/usr/bin/env bash',
    'set -e',
    'cd ' + workdir,
    'mkdir -p /tmp/hpc',
  ];

  function pushB64Parts(target: string, b64: string) {
    const cs = chunks(b64);
    lines.push(`: > /tmp/hpc/${target}.b64`);
    cs.forEach((c, idx) => {
      const marker = `__HPC_${target.replace(/\W/g, '_')}_${idx.toString(36)}_${Math.random().toString(36).slice(2, 8)}__`;
      lines.push(`cat >> /tmp/hpc/${target}.b64 <<'${marker}'`, c, marker);
    });
    lines.push(`base64 -d /tmp/hpc/${target}.b64 > /tmp/hpc/${target}`, `rm /tmp/hpc/${target}.b64`);
    if (target.endsWith('.js')) lines.push(`chmod +x /tmp/hpc/${target} || true`);
  }

  pushB64Parts(scriptName, scriptB64);
  if (stdoutB64 !== null) pushB64Parts('stdout.js', stdoutB64);
  if (bundleB64 !== null) {
    pushB64Parts('bundle.tar.gz', bundleB64);
    lines.push('mkdir -p /tmp/hpc/fixture', 'tar -xzf /tmp/hpc/bundle.tar.gz -C /tmp/hpc/fixture', 'rm /tmp/hpc/bundle.tar.gz');
  }

  lines.push(`HPC_FIXTURE_ROOT=/tmp/hpc/fixture node /tmp/hpc/${scriptName}`);
  const script = lines.join('\n');

  fs.writeFileSync(path.join(workdir, 'run.sh'), script, { mode: 0o755 });
  return spawnSync('bash', [path.join(workdir, 'run.sh')], {
    encoding: 'utf8',
    timeout: suite.timeoutMs,
  });
}

function main(): void {
  const explicit = listArg('--suite=').concat(listArg('--suite')).flatMap(s => [s]);
  const allSuites = explicit.length === 0 || explicit.includes('all');
  const target = allSuites ? getSuiteIds() : explicit;

  let pass = 0;
  let fail = 0;
  for (const id of target) {
    if (runOne(id)) pass++;
    else fail++;
  }
  console.log(`\n[hpc-smoke] ${pass} passed \u00b7 ${fail} failed \u00b7 ${target.length} total`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
