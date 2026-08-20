import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'tensorlake-opencode-reliability',
  benchmarkName: 'Tensorlake OpenCode Reliability',
  iterations: 3,
  concurrency: 1,
  staggerDelayMs: 60_000,
  participants: providers,
  defaultProviders: ['tensorlake'],
  onScore: (lowerIsBetter) => ({
    metrics: [
      lowerIsBetter('totalMs', {
        unit: 'ms',
        ceiling: 240_000,
        weights: { median: 1, p95: 0, p99: 0 },
      }),
    ],
  }),
});

export const task = defineTask<ProviderConfig>(async (ctx) => {
  const { participant, step, measure } = ctx;
  const compute = participant.createCompute();

  let sandbox: any;
  const start = performance.now();

  try {
    sandbox = await step('create', () =>
      withTimeout(
        compute.sandbox.create({
          ...participant.sandboxOptions,
          timeout: 600_000,
        }),
        participant.timeout ?? 120_000,
        'Sandbox creation timed out',
      ),
    );

    await step('install', async () => {
      const result = await sandbox.runCommand(
        'curl -fsSL https://opencode.ai/install -o /tmp/opencode-install.sh && HOME=/tmp/opencode-home bash /tmp/opencode-install.sh --no-modify-path',
        { timeout: 60_000 },
      );
      if (result.exitCode !== 0) {
        throw new TaskError(`OpenCode install failed (exit ${result.exitCode})`);
      }
    });

    const output = await step('run', async () =>
      sandbox.runCommand(
        `export HOME=/tmp/opencode-home && export PATH="/tmp/opencode-home/.opencode/bin:$PATH" && opencode run --auto --model opencode/gpt-5-nano 'Reply with the exact text "tensorlake-ok".'`,
        { timeout: 180_000 },
      ),
    );

    if (output.exitCode !== 0) {
      throw new TaskError(`OpenCode run failed (exit ${output.exitCode})`);
    }

    const stdout = output.stdout || '';
    if (!stdout.includes('tensorlake-ok')) {
      throw new TaskError(`OpenCode output did not include "tensorlake-ok": ${stdout}`.trim());
    }

    measure({ totalMs: performance.now() - start });
  } catch (err) {
    measure({ totalMs: performance.now() - start });
    throw err;
  } finally {
    if (sandbox) {
      await step(
        'destroy',
        () =>
          withTimeout(
            sandbox.destroy(),
            participant.destroyTimeoutMs ?? 30_000,
            'Destroy timeout',
          ),
        { reportConcurrency: false },
      ).catch((err: unknown) => console.warn(`[cleanup] destroy failed: ${String(err)}`));
    }
  }
});
