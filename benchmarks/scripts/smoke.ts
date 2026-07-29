/**
 * Generic smoke harness. Runs a benchmark's workload locally (no ComputeSDK,
 * no cloud sandbox) and asserts it emits a parseable WorkloadResult JSON line.
 *
 * Usage: tsx benchmarks/scripts/smoke.ts --suite=cpu-node --dir=benchmarks/sandbox/cpu-node
 *        tsx benchmarks/scripts/smoke.ts --suite=all
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const ALL_SUITES = [
  'cpu-node', 'memory', 'system', 'disk',
  'network-localhost', 'network-wan', 'pgbench',
  'realworld', 'latency', 'dns', 'download',
];

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2).filter(a => a !== '--');
  for (const arg of args) {
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

async function runOne(suiteId: string): Promise<boolean> {
  const dir = getArg('--dir') || path.join('benchmarks', 'sandbox', suiteId);
  const dirAbs = path.resolve(ROOT, dir);

  // Dynamically import the benchmark's types and scoring
  const { SUITE_CONFIG } = await import(path.join(dirAbs, 'types.ts'));
  const { scoreMetric } = await import(path.join(dirAbs, 'scoring.ts'));
  const { parseWorkloadResult } = await import(path.join(dirAbs, 'util', 'parse-stdout.ts'));
  const { ensureBundleForRun } = await import(path.join(__dirname, 'ensure-bundle.ts'));

  const bundleCheck = ensureBundleForRun(SUITE_CONFIG.bundle);
  if (!bundleCheck.ok) {
    console.log(`    — skipped (${SUITE_CONFIG.bundle}): ${bundleCheck.reason}`);
    return true;
  }

  let bundlePath: string | null = null;
  if (SUITE_CONFIG.bundle !== 'none') {
    const { getBundlePath } = await import(path.join(dirAbs, 'util', 'upload-bundle.ts'));
    bundlePath = getBundlePath(SUITE_CONFIG.bundle);
  }

  console.log(`\n[smoke] ▶ ${suiteId}  (${SUITE_CONFIG.label})`);
  if (SUITE_CONFIG.bundle === 'fixture-archive') {
    const fixturePath = path.join(dirAbs, 'fixtures', 'node-tooling', 'BENCH_VERSION.txt');
    if (fs.existsSync(fixturePath)) {
      const v = fs.readFileSync(fixturePath, 'utf8').trim();
      console.log(`    fixture: ${dir}/fixtures/node-tooling v${v}`);
    }
  }
  console.log(`    ceiling: ${SUITE_CONFIG.ceiling} ${SUITE_CONFIG.unit} (${SUITE_CONFIG.higherIsBetter ? '↑ better' : '↓ better'})`);

  const workdir = `/tmp/bench-smoke-${process.pid}-${Date.now()}`;
  fs.mkdirSync(workdir, { recursive: true });
  const startedAt = Date.now();
  const result = runSmokeLocally(SUITE_CONFIG, dirAbs, workdir, bundlePath);
  spawnSync('rm', ['-rf', workdir]);
  const elapsedMs = Date.now() - startedAt;

  if (result.error) {
    console.error(`[smoke] ✗ spawn failed: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`[smoke] ✗ exit ${result.status}`);
    console.error(result.stderr || '(no stderr)');
    return false;
  }

  const parsed = parseWorkloadResult(result.stdout, suiteId);
  if (!parsed.ok) {
    console.error(`[smoke] ✗ parse failed (reason: ${parsed.reason ?? 'unknown'})`);
    if ('error' in parsed && parsed.error) console.error(`    error: ${parsed.error}`);
    return false;
  }

  const score = scoreMetric(parsed.metric.value, SUITE_CONFIG);
  console.log(`    ✓ ${parsed.metric.value.toLocaleString()} ${parsed.metric.unit} in ${elapsedMs} ms (score ${score.toFixed(1)}/100)`);
  return true;
}

function runSmokeLocally(
  suite: any,
  dirAbs: string,
  workdir: string,
  bundlePath: string | null,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const WORKLOAD_DIR = path.join(dirAbs, 'workload');
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
    'mkdir -p /tmp/bench',
  ];

  function pushB64Parts(target: string, b64: string) {
    const cs = chunks(b64);
    lines.push(`: > /tmp/bench/${target}.b64`);
    cs.forEach((c, idx) => {
      const marker = `__BENCH_${target.replace(/\W/g, '_')}_${idx.toString(36)}_${Math.random().toString(36).slice(2, 8)}__`;
      lines.push(`cat >> /tmp/bench/${target}.b64 <<'${marker}'`, c, marker);
    });
    lines.push(`base64 -d /tmp/bench/${target}.b64 > /tmp/bench/${target}`, `rm /tmp/bench/${target}.b64`);
    if (target.endsWith('.js')) lines.push(`chmod +x /tmp/bench/${target} || true`);
  }

  pushB64Parts(scriptName, scriptB64);
  if (stdoutB64 !== null) pushB64Parts('stdout.js', stdoutB64);
  if (bundleB64 !== null) {
    pushB64Parts('bundle.tar.gz', bundleB64);
    lines.push('mkdir -p /tmp/bench/fixture', 'tar -xzf /tmp/bench/bundle.tar.gz -C /tmp/bench/fixture', 'rm /tmp/bench/bundle.tar.gz');
  }

  lines.push(`BENCH_FIXTURE_ROOT=/tmp/bench/fixture node /tmp/bench/${scriptName}`);
  const script = lines.join('\n');

  fs.writeFileSync(path.join(workdir, 'run.sh'), script, { mode: 0o755 });
  return spawnSync('bash', [path.join(workdir, 'run.sh')], {
    encoding: 'utf8',
    timeout: suite.timeoutMs,
  });
}

async function main(): Promise<void> {
  const explicit = listArg('--suite=').concat(listArg('--suite'));
  const allSuites = explicit.length === 0 || explicit.includes('all');
  const target = allSuites ? ALL_SUITES : explicit;

  let pass = 0;
  let fail = 0;
  for (const id of target) {
    if (await runOne(id)) pass++;
    else fail++;
  }
  console.log(`\n[smoke] ${pass} passed · ${fail} failed · ${target.length} total`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
