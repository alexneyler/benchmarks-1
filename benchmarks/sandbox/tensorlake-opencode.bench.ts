import '../src/env.js';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { providers } from './providers.js';
import type { ProviderConfig } from './types.js';

const DEFAULT_MODEL = 'opencode/gpt-5-nano';
const DEFAULT_PROMPT = 'Reply with the exact text "tensorlake-ok".';
const DEFAULT_EXPECTED = 'tensorlake-ok';

const CREATE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 60_000;
const CONFIG_TIMEOUT_MS = 10_000;
const DESTROY_TIMEOUT_MS = 30_000;

const model = process.env.OPENCODE_MODEL?.trim() || DEFAULT_MODEL;
const prompt = process.env.OPENCODE_PROMPT?.trim() || DEFAULT_PROMPT;
const expected = process.env.OPENCODE_EXPECTED?.trim() || DEFAULT_EXPECTED;
const opencodeTimeoutMs = parseInt(process.env.OPENCODE_TIMEOUT_MS || '180000', 10);
const sandboxTimeoutMs = parseInt(process.env.OPENCODE_SANDBOX_TIMEOUT_MS || '600000', 10);

interface RunResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

const opencodeConfig = JSON.stringify(
  {
    model,
    permission: {
      read: 'allow',
      edit: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      bash: 'allow',
      task: 'allow',
      external_directory: 'allow',
      todowrite: 'allow',
      question: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      lsp: 'allow',
      doom_loop: 'allow',
      skill: 'allow',
    },
  },
  null,
  2,
);

const promptB64 = Buffer.from(prompt).toString('base64');
const configB64 = Buffer.from(opencodeConfig).toString('base64');

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
        weights: { median: 0.50, p95: 0.30, p99: 0.20 },
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
          timeout: sandboxTimeoutMs,
        }),
        participant.timeout ?? CREATE_TIMEOUT_MS,
        'Sandbox creation timed out',
      ),
    );

    await step('install', async () => {
      const result = (await sandbox.runCommand('curl -fsSL https://opencode.ai/install | bash', {
        timeout: INSTALL_TIMEOUT_MS,
      })) as RunResult;
      if (result.exitCode !== 0) {
        throw new TaskError(
          `OpenCode install failed (exit ${result.exitCode}): ${result.stderr || result.stdout || ''}`.trim(),
        );
      }
    });

    await step('configure', async () => {
      const result = (await sandbox.runCommand(
        `mkdir -p ~/.config/opencode && echo '${configB64}' | base64 -d > ~/.config/opencode/opencode.json`,
        { timeout: CONFIG_TIMEOUT_MS },
      )) as RunResult;
      if (result.exitCode !== 0) {
        throw new TaskError(
          `OpenCode config failed (exit ${result.exitCode}): ${result.stderr || result.stdout || ''}`.trim(),
        );
      }
    });

    const promptPath = `/tmp/opencode-prompt-${ctx.taskIndex}`;
    const runCmd = `set +e
echo '${promptB64}' | base64 -d > ${promptPath}
export PATH="$HOME/.opencode/bin:$PATH"
cat ${promptPath} | opencode run --auto
OPENCODE_EXIT=$?
rm -f ${promptPath}
exit $OPENCODE_EXIT`;

    const output = (await step('run', async () =>
      sandbox.runCommand(runCmd, { timeout: opencodeTimeoutMs }),
    )) as RunResult;

    if (output.exitCode !== 0) {
      throw new TaskError(
        `OpenCode run failed (exit ${output.exitCode}): ${output.stderr || output.stdout || ''}`.trim(),
      );
    }

    const stdout = output.stdout || '';
    if (!stdout.includes(expected)) {
      throw new TaskError(
        `OpenCode output did not include "${expected}": ${stdout}`.trim(),
      );
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
      ).catch((err) => console.warn(`[cleanup] destroy failed: ${String(err)}`));
    }
  }
});
