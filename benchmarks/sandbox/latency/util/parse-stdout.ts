import type { SuiteId, WorkloadResult } from './types.js';

const SUITE_VALUE: SuiteId = 'latency';

/**
 * Read the last JSON line of stdout. Returns a fake gap WorkloadResult if
 * no line parses — never throws.
 */
export function parseWorkloadResult(stdout: string, expectedSuite: SuiteId): WorkloadResult {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as WorkloadResult;
      if (!parsed || typeof parsed !== 'object') continue;
      if (typeof parsed.suite !== 'string' || parsed.suite !== SUITE_VALUE) continue;
      return parsed;
    } catch {
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
