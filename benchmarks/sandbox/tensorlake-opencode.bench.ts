import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';

const MODEL = 'opencode/gpt-5-nano';
const PROMPT = 'Reply with the exact text "tensorlake-ok".';
const EXPECTED = 'tensorlake-ok';

const CREATE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 180_000;
const DESTROY_TIMEOUT_MS = 30_000;
const SANDBOX_TIMEOUT_MS = 600_000;

const HOME_DIR = '/tmp/opencode-home';
const INSTALL_DIR = `${HOME_DIR}/.opencode/bin`;
const INSTALL_SCRIPT = '/tmp/opencode-install.sh';

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
          timeout: SANDBOX_TIMEOUT_MS,
        }),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'Sandbox creation timed out',
      ),
    );

    await step('install', async () => {
      const result = await sandbox.runCommand(
        `curl -fsSL https://opencode.ai/install -o ${INSTALL_SCRIPT} && HOME=${HOME_DIR} bash ${INSTALL_SCRIPT} --no-modify-path`,
        { timeout: INSTALL_TIMEOUT_MS },
      );
      if (result.exitCode !== 0) {
        throw new TaskError(`OpenCode install failed (exit ${result.exitCode})`);
      }
    });

    const output = await step('run', async () =>
      sandbox.runCommand(
        `export HOME=${HOME_DIR} && export PATH="${INSTALL_DIR}:$PATH" && opencode run --auto --model ${MODEL} '${PROMPT}'`,
        { timeout: RUN_TIMEOUT_MS },
      ),
    );

    if (output.exitCode !== 0) {
      throw new TaskError(`OpenCode run failed (exit ${output.exitCode})`);
    }

    const stdout = output.stdout || '';
    if (!stdout.includes(EXPECTED)) {
      throw new TaskError(`OpenCode output did not include "${EXPECTED}": ${stdout}`.trim());
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
            participant.destroyTimeoutMs ?? DESTROY_TIMEOUT_MS,
            'Destroy timeout',
          ),
        { reportConcurrency: false },
      ).catch((err: unknown) => console.warn(`[cleanup] destroy failed: ${String(err)}`));
    }
  }
});
