import type { BaseParticipant } from '@benchsdk/client';

/**
 * Minimal sandbox shape used by the example benchmarks.
 *
 * A real provider returns a provider SDK instance with async methods that talk
 * to a cloud API. The examples keep everything local by returning an object
 * with the same `runCommand` / `destroy` shape so the benchmark task code does
 * not need to know it is running against a mock.
 */
export interface NoopSandbox {
  /** Simulated command execution. Returns an exit code and optional stderr. */
  runCommand(command: string): Promise<{ exitCode: number; stderr?: string }>;
  /** Simulated teardown. */
  destroy(): Promise<void>;
}

/**
 * A participant that the runner can schedule.
 *
 * `BaseParticipant` only requires `name` and `requiredEnvVars`. The runner
 * filters participants by checking `requiredEnvVars`; if the array is empty the
 * participant is always available. We extend `BaseParticipant` with the
 * `createCompute` factory so the task implementation can call it.
 */
export interface NoopParticipant extends BaseParticipant {
  /** Returns a compute adapter whose `sandbox.create()` produces a `NoopSandbox`. */
  createCompute(): { sandbox: { create(): Promise<NoopSandbox> } };
}

/** A tiny promise-based sleep helper used to simulate network latency. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Factory for a mock provider.
 *
 * Each call creates a new participant object with its own `latencyMs`. The
 * sandbox returned by `createCompute` waits roughly `latencyMs` plus a random
 * jitter before returning, so different providers report different TTI numbers
 * in the dashboard and console output.
 */
export function createNoopParticipant(name: string, latencyMs = 100): NoopParticipant {
  return {
    // `name` is used as the participant slug in API paths, dashboard URLs, and
    // the `--provider` CLI filter.
    name,
    // Empty array means this participant never gets skipped for missing env
    // vars, so the examples run without credentials.
    requiredEnvVars: [],
    createCompute: () => ({
      sandbox: {
        create: async () => ({
          runCommand: async (command: string) => {
            // Add a small, variable delay so each provider reports distinct timing.
            await sleep(latencyMs + Math.floor(Math.random() * latencyMs));
            return { exitCode: 0, stderr: '' };
          },
          destroy: async () => {
            // Tiny cleanup delay so the destroy step has non-zero latency.
            await sleep(10);
          },
        }),
      },
    }),
  };
}

/** Three mock providers with increasing base latency for clear differentiation. */
export const exampleProviders: NoopParticipant[] = [
  createNoopParticipant('alpha', 100),
  createNoopParticipant('beta', 200),
  createNoopParticipant('gamma', 300),
];
