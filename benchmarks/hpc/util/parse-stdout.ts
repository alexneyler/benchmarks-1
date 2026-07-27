import type { HpcSuiteId, WorkloadResult } from '../types.js';

const SUITE_VALUES: ReadonlySet<HpcSuiteId> = new Set([
  'cpu-node',
  'memory',
  'system',
  'disk',
  'network-localhost',
  'network-wan',
  'pgbench',
  'realworld',
  'latency',
  'dns',
  'download',
]);

/**
 * Read the last JSON line of stdout. Returns a fake `gap` WorkloadResult if
 * no line parses — never throws. The error path is surfaced to logs only.
 *
 * Defensive parsing: many ComputeSDK runtimes wrap the output and may add
 * a CR/LF-normalized line, so we trim trailing \r on each candidate.
 */
export function parseWorkloadResult(stdout: string, expectedSuite: HpcSuiteId): WorkloadResult {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as WorkloadResult;
      if (!parsed || typeof parsed !== 'object') continue;
      if (typeof parsed.suite !== 'string' || !SUITE_VALUES.has(parsed.suite as HpcSuiteId)) continue;
      return parsed;
    } catch {
      // Not JSON — fall through to the next line; the last non-empty line is the contract.
      continue;
    }
  }

  return {
    ok: false,
    suite: expectedSuite,
    reason: 'unexpected',
    error: 'no parseable WorkloadResult JSON line found in stdout',
    meta: {},
  };
}
