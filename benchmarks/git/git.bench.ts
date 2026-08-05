/**
 * Git workflow benchmark. Measures shallow clone, commit+push, and pull over
 * HTTPS for git hosting providers using isomorphic-git as the harness.
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * The push/pull workflow runs only when the participant's token env var is set.
 * For the read-only public fixtures (GitHub/GitLab/Bitbucket defaults), only the
 * `clone` step is exercised unless `*_GIT_REPO_URL` and `*_TOKEN` are provided.
 *
 *   bench run benchmarks/git/git.bench.ts
 *   bench run benchmarks/git/git.bench.ts --provider tensorlake --iterations 5
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
const COMMITTER = { name: 'ComputeSDK Benchmark', email: 'bench@example.com' };

function resolveRepoUrl(config: GitProviderConfig): string {
  if (config.repoUrlEnvVar) {
    const override = process.env[config.repoUrlEnvVar];
    if (override) return override;
  }
  return config.url;
}

function buildAuth(config: GitProviderConfig): AuthCallback | undefined {
  if (!config.tokenEnvVar) return undefined;
  const token = process.env[config.tokenEnvVar];
  if (!token) return undefined;
  const username = config.tokenUsername ?? 'token';
  return () => ({ username, password: token });
}

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'git-workflow-local',
  benchmarkName: 'Git workflow (local)',
  benchmarkKind: 'git',
  iterations: 3,
  concurrency: 1,
  participants: providers,
});

export const task = defineTask<GitProviderConfig>(async (ctx) => {
  const { participant, step, measure, taskIndex } = ctx;
  const timeout = participant.timeout ?? CLONE_TIMEOUT_MS;

  const repoUrl = resolveRepoUrl(participant);
  const onAuth = buildAuth(participant);
  const branch = `${participant.name}-${taskIndex}-${Date.now()}`;

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bench-git-'));
  const workDir = path.join(tempDir, 'repo');

  let cloneMs = 0;
  let pushMs = 0;
  let pullMs = 0;

  try {
    const cloneStart = performance.now();
    await step('clone', () =>
      withTimeout(
        git.clone({
          fs: fs as unknown as import('isomorphic-git').FsClient,
          http,
          dir: workDir,
          url: repoUrl,
          singleBranch: true,
          depth: 1,
          onAuth,
        }),
        timeout,
        'Git clone timed out',
      ),
    );
    cloneMs = performance.now() - cloneStart;

    // Without auth we can only benchmark clone; skip the write path.
    if (!onAuth) {
      measure({ cloneMs, repoUrl, branch, pushSkipped: true, pullSkipped: true, commitSha: '' });
      return { data: { cloneMs, pushMs: 0, pullMs: 0, repoUrl, branch, commitSha: '' } };
    }

    const defaultBranch =
      (await git.currentBranch({ fs, dir: workDir, fullname: false })) ??
      participant.defaultBranch ??
      'main';

    await git.branch({ fs, dir: workDir, ref: branch, checkout: true });
    await fs.promises.writeFile(
      path.join(workDir, 'bench.txt'),
      `benchmark ${branch}\n`,
    );
    await git.add({ fs, dir: workDir, filepath: 'bench.txt' });
    const commitSha = await git.commit({
      fs,
      dir: workDir,
      message: `bench: ${branch}`,
      author: COMMITTER,
      committer: COMMITTER,
    });

    const pushStart = performance.now();
    await step('push', () =>
      withTimeout(
        git.push({
          fs: fs as unknown as import('isomorphic-git').FsClient,
          http,
          dir: workDir,
          remote: 'origin',
          ref: branch,
          remoteRef: branch,
          onAuth,
        }),
        timeout,
        'Git push timed out',
      ),
    );
    pushMs = performance.now() - pushStart;

    await git.checkout({ fs, dir: workDir, ref: defaultBranch });

    const pullStart = performance.now();
    await step('pull', () =>
      withTimeout(
        git.pull({
          fs: fs as unknown as import('isomorphic-git').FsClient,
          http,
          dir: workDir,
          ref: defaultBranch,
          remoteRef: branch,
          singleBranch: true,
          fastForwardOnly: true,
          onAuth,
          author: COMMITTER,
          committer: COMMITTER,
        }),
        timeout,
        'Git pull timed out',
      ),
    );
    pullMs = performance.now() - pullStart;

    measure({ cloneMs, pushMs, pullMs, repoUrl, branch, commitSha });
    return { data: { cloneMs, pushMs, pullMs, repoUrl, branch, commitSha } };
  } catch (err) {
    throw new TaskError(formatError(err), {
      code: 'GIT_WORKFLOW_ERROR',
      data: { repoUrl, branch, cloneMs, pushMs, pullMs },
    });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
