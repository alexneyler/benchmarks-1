/**
 * Declarative config for `npm run bench <config-file>.ts`, an alternative to
 * the CLI-flag invocation in src/run.ts. Covers the core sandbox modes that
 * already support --report: sequential, staggered, burst/concurrent, dax.
 * Storage, snapshot-fork, browser, and browser-throughput stay flag-only.
 */

export type ConfigBenchmarkMode = 'sequential' | 'staggered' | 'burst' | 'concurrent' | 'dax';

export interface BenchmarkReportConfig {
  benchmarkSlug: string;
  /** Org slug for the printed dashboard link. Default: BENCHMARKS_PLATFORM_ORG_SLUG env, then 'computesdk'. */
  orgSlug?: string;
  /** Platform base URL (without /api/v1). Default: BENCHMARKS_PLATFORM_URL env, then http://localhost:3000. */
  baseUrl?: string;
  // apiKey is intentionally not configurable here — it's always sourced from
  // COMPUTESDK_ADMIN_API_KEY / COMPUTESDK_API_KEY env vars (matches the
  // flag-based path, which never sets it either), so a committed config file
  // can't accidentally embed a secret.
}

export interface BenchmarkConfig {
  mode: ConfigBenchmarkMode;
  /** Provider names from src/sandbox/providers.ts. Omit to run all registered providers (still env-gated at run time). */
  providers?: string[];
  /** sequential + dax only. Default: 100. */
  iterations?: number;
  /** staggered + burst/concurrent only. Default: 100. */
  concurrency?: number;
  /** staggered only. Default: 200. */
  staggerDelayMs?: number;
  /** Stream this run to a benchmarks-platform instance instead of only writing local JSON. */
  report?: BenchmarkReportConfig;
  /** Print the resolved plan and exit without creating any sandboxes or writing results. */
  dryRun?: boolean;
}

const VALID_MODES: ConfigBenchmarkMode[] = ['sequential', 'staggered', 'burst', 'concurrent', 'dax'];

/** Validates `config` at config-file evaluation time so mistakes surface immediately, pointing at the config file itself. */
export function defineBenchmark(config: BenchmarkConfig): BenchmarkConfig {
  if (!VALID_MODES.includes(config.mode)) {
    throw new Error(`Invalid mode "${config.mode}". Valid modes: ${VALID_MODES.join(', ')}`);
  }
  if (config.report && config.mode === 'staggered') {
    throw new Error('report is not supported for mode "staggered" (matches the --report flag\'s mode restriction).');
  }
  if (config.report && (config.mode === 'burst' || config.mode === 'concurrent') && config.concurrency === undefined) {
    throw new Error(
      'report + mode "burst"/"concurrent" requires an explicit `concurrency` value (no implicit default of 100) ' +
      'to avoid accidentally launching 100 concurrent sandboxes per provider.',
    );
  }
  return config;
}
