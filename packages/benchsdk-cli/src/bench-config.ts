/**
 * Declarative config for `npm run bench <config-file>.ts`, an alternative to
 * CLI-flag invocation. Covers the core sandbox modes: sequential, staggered,
 * burst/concurrent, sandbox-dax. Storage, snapshot-fork, browser, and
 * browser-throughput stay flag-only.
 */

export type ConfigBenchmarkMode = 'sequential' | 'staggered' | 'burst' | 'concurrent' | 'sandbox-dax';

export interface BenchmarkConfig {
  mode: ConfigBenchmarkMode;
  /** Participant names from the provider registry. Omit to run all registered participants (still env-gated at run time). */
  participants?: string[];
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
   * self-contained (config + code in one place). Not supported for mode
   * "sandbox-dax", which has its own fixed disk/CPU/pause-resume probes.
   */
  task?: (sandbox: any) => Promise<void>;
  /** Timeout for `task` in ms. Default: 30000. */
  taskTimeoutMs?: number;
}

const VALID_MODES: ConfigBenchmarkMode[] = ['sequential', 'staggered', 'burst', 'concurrent', 'sandbox-dax'];

/** Validates `config` at config-file evaluation time so mistakes surface immediately. */
export function defineBenchmark(config: BenchmarkConfig): BenchmarkConfig {
  if (!VALID_MODES.includes(config.mode)) {
    throw new Error(`Invalid mode "${config.mode}". Valid modes: ${VALID_MODES.join(', ')}`);
  }
  if (config.task && config.mode === 'sandbox-dax') {
    throw new Error('task is not supported for mode "sandbox-dax" (sandbox-dax runs its own fixed disk/CPU/pause-resume probes).');
  }
  return config;
}
