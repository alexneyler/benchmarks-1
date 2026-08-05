import type { BaseParticipant } from '@benchsdk/client';

export interface GitProviderConfig extends BaseParticipant {
  /** HTTPS URL of a public repository to clone. */
  url: string;
  /** Optional environment variable holding an HTTPS auth token. */
  tokenEnvVar?: string;
  /** Username passed to isomorphic-git's onAuth callback when a token is set. */
  tokenUsername?: string;
  /** Per-provider timeout for the clone step in ms (default: 60000). */
  timeout?: number;
}

export interface GitTimingResult {
  /** Time to shallow clone the repo in ms. */
  cloneMs: number;
  /** Repository URL cloned. */
  repoUrl: string;
  /** Error message if this iteration failed. */
  error?: string;
}

export interface GitStats {
  cloneMs: { median: number; p95: number; p99: number };
}

export interface GitBenchmarkResult {
  provider: string;
  mode: 'git';
  repoUrl: string;
  iterations: GitTimingResult[];
  summary: GitStats;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
