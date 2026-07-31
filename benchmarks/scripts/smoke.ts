/**
 * Smoke harness for a standalone benchmark suite. Runs the workload locally
 * (no ComputeSDK, no cloud sandbox) and asserts it emits a parseable
 * WorkloadResult JSON line.
 *
 * Generalized across suites — pass `--suite=<id>`. Supports any suite with
 * the cpu-node-style contract:
 *   - src: benchmarks/sandbox/<suite>.ts exporting SUITE_CONFIG + parseWorkloadResult + scoreMetric
 *   - workload: benchmarks/scripts/<suite>-workload.js (CommonJS, stdlib-only)
 *   - stdout helper: benchmarks/scripts/<suite>-stdout.js (optional; the
 *     workload's `require('./stdout.js')` resolves to whatever file we
 *     copy into the workdir as `stdout.js`)
 *
 * Usage: tsx benchmarks/scripts/smoke.ts --suite=cpu-node
 *        tsx benchmarks/scripts/smoke.ts --suite=memory
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

interface SmokeSuite {
  id: string;
  label: string;
  unit: string;
  higherIsBetter: boolean;
  ceiling: number;
  workloadPath: string;
  timeoutMs: number;
  parseWorkloadResult: (stdout: string) => any;
  scoreMetric: (value: number, suite: any) => number;
}

/**
 * Dynamic loader — import the suite module by name so each invocation reads
 * its own SUITE_CONFIG without cross-suite compile-time coupling.
 */
async function loadSuite(suiteId: string): Promise<SmokeSuite> {
  // Map <suite> → benchmarks/sandbox/<suite>.js (resolved to <suite>.ts by tsx)
  const mod = await import(path.join(ROOT, 'benchmarks', 'sandbox', `${suiteId}.ts`));
  const cfg = mod.SUITE_CONFIG;
  return {
    id: cfg.id,
    label: cfg.label,
    unit: cfg.unit,
    higherIsBetter: cfg.higherIsBetter,
    ceiling: cfg.ceiling,
    workloadPath: cfg.workloadPath,
    timeoutMs: cfg.timeoutMs,
    parseWorkloadResult: mod.parseWorkloadResult,
    scoreMetric: mod.scoreMetric,
  };
}

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2).filter(a => a !== '--');
  for (const arg of args) {
    if (arg.startsWith(flag + '=')) return arg.slice(flag.length + 1);
  }
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const suiteId = getArg('--suite');
  if (!suiteId) {
    console.error('Usage: tsx benchmarks/scripts/smoke.ts --suite=<id>');
    console.error('  e.g. --suite=cpu-node, --suite=memory');
    process.exit(2);
  }

  const suite = await loadSuite(suiteId);
  const scriptsDir = path.join(ROOT, 'benchmarks', 'scripts');
  const workloadPath = path.join(scriptsDir, suite.workloadPath);
  const stdoutPath = path.join(scriptsDir, `${suiteId}-stdout.js`);

  console.log(`\n[smoke] ▶ ${suite.id}  (${suite.label})`);
  console.log(`    ceiling: ${suite.ceiling} ${suite.unit} (${suite.higherIsBetter ? '↑ better' : '↓ better'})`);

  // Write the workload + stdout helper to a temp dir and run with node.
  // Mirrors what the in-sandbox runCommand heredoc does at /tmp/bench/.
  const workdir = `/tmp/bench-smoke-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.join(workdir, 'bench'), { recursive: true });

  fs.copyFileSync(workloadPath, path.join(workdir, 'bench', suite.workloadPath));
  if (fs.existsSync(stdoutPath)) {
    fs.copyFileSync(stdoutPath, path.join(workdir, 'bench', 'stdout.js'));
  }

  const startedAt = Date.now();
  const result = spawnSync('node', [path.join(workdir, 'bench', suite.workloadPath)], {
    cwd: path.join(workdir, 'bench'),
    encoding: 'utf8',
    timeout: suite.timeoutMs,
    env: { ...process.env, BENCH_SUITE: suite.id },
  });
  spawnSync('rm', ['-rf', workdir]);
  const elapsedMs = Date.now() - startedAt;

  if (result.error) {
    console.error(`[smoke] ✗ spawn failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[smoke] ✗ exit ${result.status}`);
    console.error(result.stderr || '(no stderr)');
    process.exit(1);
  }

  const parsed = suite.parseWorkloadResult(result.stdout);
  if (!parsed.ok) {
    console.error(`[smoke] ✗ parse failed (reason: ${parsed.reason ?? 'unknown'})`);
    if ('error' in parsed && parsed.error) console.error(`    error: ${parsed.error}`);
    process.exit(1);
  }

  const score = suite.scoreMetric(parsed.metric.value, suite);
  console.log(`    ✓ ${parsed.metric.value.toLocaleString()} ${parsed.metric.unit} in ${elapsedMs} ms (score ${score.toFixed(1)}/100)`);
  console.log(`\n[smoke] 1 passed · 0 failed · 1 total`);
  process.exit(0);
}

main();
