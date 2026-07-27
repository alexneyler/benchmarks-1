/**
 * Declarative config for `npm run bench <config-file>.ts`, an alternative to
 * the CLI-flag invocation in src/run.ts. Covers the core sandbox modes,
 * local JSON output only: sequential, staggered, burst/concurrent, sandbox-dax.
 * Storage, snapshot-fork, browser, and browser-throughput stay flag-only.
 * Platform reporting lives in src/benchmarks/*.bench.ts instead — see those
 * files for the self-contained, always-reports pattern.
 */
import type { SandboxTask } from './types.js';

export type ConfigBenchmarkMode = 'sequential' | 'staggered' | 'burst' | 'concurrent' | 'sandbox-dax';

export interface BenchmarkConfig {
  mode: ConfigBenchmarkMode;
  /** Provider names from src/sandbox/providers.ts. Omit to run all registered providers (still env-gated at run time). */
  providers?: string[];
  /** sequential + sandbox-dax only. Default: 100. */
  iterations?: number;
  /** staggered + burst/concurrent only. Default: 100. */
  concurrency?: number;
  /** staggered only. Default: 200. */
  staggerDelayMs?: number;
  /** Print the resolved plan and exit without creating any sandboxes or writing results. */
  dryRun?: boolean;
  /**
   * Custom workload to run inside each sandbox, making this config file fully
   * self-contained (config + code in one place) instead of relying on the
   * hardcoded `node -v` liveness check. Not supported for mode "sandbox-dax",
   * which has its own fixed disk/CPU/pause-resume probes.
   */
  task?: SandboxTask;
  /** Timeout for `task` in ms. Default: 30000. */
  taskTimeoutMs?: number;
}

const VALID_MODES: ConfigBenchmarkMode[] = ['sequential', 'staggered', 'burst', 'concurrent', 'sandbox-dax'];

/** Validates `config` at config-file evaluation time so mistakes surface immediately, pointing at the config file itself. */
export function defineBenchmark(config: BenchmarkConfig): BenchmarkConfig {
  if (!VALID_MODES.includes(config.mode)) {
    throw new Error(`Invalid mode "${config.mode}". Valid modes: ${VALID_MODES.join(', ')}`);
  }
  if (config.task && config.mode === 'sandbox-dax') {
    throw new Error('task is not supported for mode "sandbox-dax" (sandbox-dax runs its own fixed disk/CPU/pause-resume probes).');
  }
  return config;
}
