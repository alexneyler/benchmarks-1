import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HpcSuite } from '../types.js';
import { getFixtureVersion } from './upload-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKLOAD_DIR = path.resolve(__dirname, '..', 'workload');

/**
 * Construct the unified shell command that:
 *   1. base64-decodes the workload script into /tmp/hpc/<suite>.js
 *   2. if a bundle is provided, base64-decodes the tar.gz to /tmp/hpc/bundle.tar.gz
 *      and extracts to /tmp/hpc/fixture/
 *   3. exports HPC_FIXTURE_ROOT (+VERSION) and HPC_BUNDLE_VERSION env vars
 *   4. runs `node /tmp/hpc/<suite>.js`
 *
 * The script reads via `base64 -d` heredocs; if `base64` is missing (rare),
 * the runner surfaces a parse error and the workload is marked gap=error.
 *
 * Returns the literal shell command plus fixture version metadata so the
 * orchestrator can pass it to the scoring meta fields.
 */
export function buildWorkloadShellCmd(opts: {
  suite: HpcSuite;
  bundlePath: string | null;
}): { command: string; fixtureVersion: string | undefined } {
  const workloadPath = path.join(WORKLOAD_DIR, path.basename(opts.suite.workloadPath));
  if (!fs.existsSync(workloadPath)) {
    throw new Error(`Workload script missing on disk: ${workloadPath}`);
  }
  const workloadJs = fs.readFileSync(workloadPath, 'utf8');
  const workloadB64 = Buffer.from(workloadJs, 'utf8').toString('base64');

  let bundleB64: string | null = null;
  if (opts.bundlePath) {
    if (!fs.existsSync(opts.bundlePath)) {
      throw new Error(`Bundle file missing: ${opts.bundlePath}. Run \`pnpm run build:hpc-bundles\`.`);
    }
    bundleB64 = fs.readFileSync(opts.bundlePath).toString('base64');
  }

  const fixtureVersion = opts.suite.bundle === 'fixture-archive' ? getFixtureVersion() : undefined;

  // Compose a single shell command. Each `cat > /tmp/hpc/<file> <<'__EOF__'`
  // heredoc uses a non-default marker to avoid any collision with the script's
  // own heredocs (the script never emits `__HPC_*__` markers).
  const mk = (label: string) => `__HPC_UPLOAD_${label}_${Math.random().toString(36).slice(2, 10)}__`;
  // Chunk size for long uploads to stay clear of ARG_MAX (~256 KiB on most
  // Linux). 64 KiB is small enough that even the largest bundles fit in a
  // handful of heredocs.
  const B64_CHUNK = 64 * 1024;

  const targetName = path.basename(opts.suite.workloadPath);
  const scriptMarker = mk('SCRIPT');
  const stdoutHelperPath = path.join(WORKLOAD_DIR, 'stdout.js');
  const stdoutB64 = fs.existsSync(stdoutHelperPath)
    ? Buffer.from(fs.readFileSync(stdoutHelperPath, 'utf8'), 'utf8').toString('base64')
    : null;
  const stdoutMarker = mk('STDOUT');

  const cmd: string[] = [
    'set -e',
    'mkdir -p /tmp/hpc',
  ];

  function appendB64Chunks(targetPathInSandbox: string, b64Content: string, label: string) {
    const chunks = chunkString(b64Content, B64_CHUNK);
    cmd.push(`: > /tmp/hpc/${targetPathInSandbox}.b64`);
    for (let i = 0; i < chunks.length; i++) {
      const marker = mk(`${label}_${i}`);
      cmd.push(
        `cat >> /tmp/hpc/${targetPathInSandbox}.b64 <<'${marker}'`,
        chunks[i],
        marker,
      );
    }
    cmd.push(`base64 -d /tmp/hpc/${targetPathInSandbox}.b64 > /tmp/hpc/${targetPathInSandbox}`);
    cmd.push(`rm /tmp/hpc/${targetPathInSandbox}.b64`);
  }

  appendB64Chunks(targetName, workloadB64, 'SCRIPT');
  cmd.push(`chmod +x /tmp/hpc/${targetName} || true`);

  if (stdoutB64 !== null) {
    appendB64Chunks('stdout.js', stdoutB64, 'STDOUT');
  }

  if (bundleB64) {
    appendB64Chunks('bundle.tar.gz', bundleB64, 'BUNDLE');
    cmd.push(
      `mkdir -p /tmp/hpc/fixture`,
      `tar -xzf /tmp/hpc/bundle.tar.gz -C /tmp/hpc/fixture`,
      `rm /tmp/hpc/bundle.tar.gz`,
    );
  }

  cmd.push(`node /tmp/hpc/${targetName}`);

  return { command: cmd.join('\n'), fixtureVersion };
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
