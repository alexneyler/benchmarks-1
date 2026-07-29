import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SuiteConfig } from './types.js';
import { getFixtureVersion } from './upload-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKLOAD_DIR = path.resolve(__dirname, '..', 'workload');

/**
 * Construct the unified shell command that writes scripts via heredocs
 * and executes node. Used by the legacy code path (build-shell-cmd).
 * The active code path uses buildSingleCommand in benchmark.ts directly.
 */
export function buildWorkloadShellCmd(opts: {
  suite: SuiteConfig;
  bundlePath: string | null;
}): { command: string; fixtureVersion: string | undefined } {
  const workloadPath = path.join(WORKLOAD_DIR, path.basename(opts.suite.workloadPath));
  if (!fs.existsSync(workloadPath)) {
    throw new Error('Workload script missing on disk: ' + workloadPath);
  }
  const workloadJs = fs.readFileSync(workloadPath, 'utf8');
  const workloadB64 = Buffer.from(workloadJs, 'utf8').toString('base64');

  let bundleB64: string | null = null;
  if (opts.bundlePath) {
    if (!fs.existsSync(opts.bundlePath)) {
      throw new Error('Bundle file missing: ' + opts.bundlePath + '. Run \`pnpm run build:bundles\`.');
    }
    bundleB64 = fs.readFileSync(opts.bundlePath).toString('base64');
  }

  const fixtureVersion = opts.suite.bundle === 'fixture-archive' ? getFixtureVersion() : undefined;

  const mk = (label: string) => '__BENCH_UPLOAD_' + label + '_' + Math.random().toString(36).slice(2, 10) + '__';
  const B64_CHUNK = 128 * 1024;

  const targetName = path.basename(opts.suite.workloadPath);
  const stdoutHelperPath = path.join(WORKLOAD_DIR, 'stdout.js');
  const stdoutB64 = fs.existsSync(stdoutHelperPath)
    ? Buffer.from(fs.readFileSync(stdoutHelperPath, 'utf8'), 'utf8').toString('base64')
    : null;

  const cmd: string[] = ['set -e', 'mkdir -p /tmp/bench'];

  function appendB64Chunks(targetPathInSandbox: string, b64Content: string, label: string) {
    const chunks = chunkString(b64Content, B64_CHUNK);
    cmd.push(': > /tmp/bench/' + targetPathInSandbox + '.b64');
    for (let i = 0; i < chunks.length; i++) {
      const marker = mk(label + '_' + i);
      cmd.push('cat >> /tmp/bench/' + targetPathInSandbox + '.b64 <<\'' + marker + '\'', chunks[i], marker);
    }
    cmd.push('base64 -d /tmp/bench/' + targetPathInSandbox + '.b64 > /tmp/bench/' + targetPathInSandbox);
    cmd.push('rm /tmp/bench/' + targetPathInSandbox + '.b64');
  }

  appendB64Chunks(targetName, workloadB64, 'SCRIPT');
  cmd.push('chmod +x /tmp/bench/' + targetName + ' || true');

  if (stdoutB64 !== null) {
    appendB64Chunks('stdout.js', stdoutB64, 'STDOUT');
  }

  if (bundleB64) {
    appendB64Chunks('bundle.tar.gz', bundleB64, 'BUNDLE');
    cmd.push('mkdir -p /tmp/bench/fixture', 'tar -xzf /tmp/bench/bundle.tar.gz -C /tmp/bench/fixture || { echo "BUNDLE_EXTRACT_FAILED"; exit 1; }', 'rm /tmp/bench/bundle.tar.gz');
  }

  cmd.push('BENCH_FIXTURE_ROOT=/tmp/bench/fixture' + (fixtureVersion ? ' BENCH_FIXTURE_VERSION=' + fixtureVersion : '') + ' BENCH_SUITE=' + opts.suite.id + ' node /tmp/bench/' + targetName);

  return { command: cmd.join('\n'), fixtureVersion };
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
