import type { BaseParticipant } from '@benchsdk/client';

export interface GitProviderConfig extends BaseParticipant {
  /** Optional fallback HTTPS URL of the repo to clone. */
  url?: string;
  /** Env var that overrides `url` for the read/write repo. */
  repoUrlEnvVar?: string;
  /** Optional env var holding an HTTPS auth token for push/pull. */
  tokenEnvVar?: string;
  /** Username supplied to `git` via GIT_ASKPASS when a token is set. */
  tokenUsername?: string;
  /** Default branch to pull back into after pushing a test branch. */
  defaultBranch?: string;
  /** Per-operation timeout in ms (default: 60000). */
  timeout?: number;
}

export interface GitTimingResult {
  /** Time to shallow clone the repo in ms. */
  cloneMs: number;
  /** Time to commit and push the test branch in ms, when measured. */
  pushMs?: number;
  /** Time to pull the test branch in ms, when measured. */
  pullMs?: number;
  /** True when push was skipped (no writable repo/token). */
  pushSkipped?: boolean;
  /** True when pull was skipped (no writable repo/token). */
  pullSkipped?: boolean;
  /** Test branch that was pushed/pulled. */
  branch: string;
  /** Commit SHA produced by the benchmark push, when available. */
  commitSha?: string;
  /** Error message if this iteration failed. */
  error?: string;
}

export interface GitStats {
  cloneMs: { median: number; p95: number; p99: number };
  pushMs: { median: number; p95: number; p99: number };
  pullMs: { median: number; p95: number; p99: number };
}

export interface GitBenchmarkResult {
  provider: string;
  mode: 'git';
  iterations: GitTimingResult[];
  summary: GitStats;
  /** Composite weighted score (0-100, higher = better). Computed post-benchmark. */
  compositeScore?: number;
  /** Success rate as a fraction (0 to 1). Computed post-benchmark. */
  successRate?: number;
  skipped?: boolean;
  skipReason?: string;
}
