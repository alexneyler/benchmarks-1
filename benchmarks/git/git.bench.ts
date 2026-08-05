/**
 * Git clone benchmark. Measures shallow clone latency over HTTPS for git
 * hosting providers using isomorphic-git as the harness. Declarative —
 * exports `config` + `task`; `bench run` owns the entrypoint.
 *
 *   bench run benchmarks/git/git.bench.ts
 *   bench run benchmarks/git/git.bench.ts --provider github,gitlab --iterations 5
 */
import '../src/env.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { AuthCallback } from 'isomorphic-git';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { GitProviderConfig } from './types.js';

const CLONE_TIMEOUT_MS = 60_000;

function buildAuth(config: GitProviderConfig): AuthCallback | undefined {
  if (!config.tokenEnvVar) return undefined;
  const token = process.env[config.tokenEnvVar];
  if (!token) return undefined;
  const username = config.tokenUsername ?? 'token';
  return () => ({ username, password: token });
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'git-clone-local',
  benchmarkName: 'Git clone (local)',
  benchmarkKind: 'git',
  iterations: 3,
  concurrency: 1,
  participants: providers,
});

export const task = defineTask<GitProviderConfig>(async (ctx) => {
  const { participant, step, measure } = ctx;
  const timeout = participant.timeout ?? CLONE_TIMEOUT_MS;

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bench-git-'));
  const cloneDir = path.join(tempDir, 'repo');

  try {
    const start = performance.now();
    await step('clone', () =>
      withTimeout(
        git.clone({
          fs: fs as unknown as import('isomorphic-git').FsClient,
          http,
          dir: cloneDir,
          url: participant.url,
          singleBranch: true,
          depth: 1,
          onAuth: buildAuth(participant),
        }),
        timeout,
        'Git clone timed out',
      ),
    );
    const cloneMs = performance.now() - start;

    measure({ cloneMs, repoUrl: participant.url });
    return { data: { cloneMs, repoUrl: participant.url } };
  } catch (err) {
    throw new TaskError(formatError(err), {
      code: 'GIT_CLONE_ERROR',
      data: { repoUrl: participant.url, cloneMs: 0 },
    });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
