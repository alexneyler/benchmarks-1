/**
 * Git workflow benchmark. Measures shallow clone, commit+push, and pull over
 * HTTPS for git hosting providers by shelling out to `git`.
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import type { GitProviderConfig } from './types.js';

const execFileAsync = promisify(execFile);
const CLONE_TIMEOUT_MS = 60_000;
const COMMITTER_NAME = 'ComputeSDK Benchmark';
const COMMITTER_EMAIL = 'bench@example.com';

function resolveRepoUrl(config: GitProviderConfig): string {
  if (config.repoUrlEnvVar) {
    const override = process.env[config.repoUrlEnvVar];
    if (override) return override;
  }
  return config.url;
}

function authRepoUrl(repoUrl: string, username: string, token: string): string {
  const url = new URL(repoUrl);
  url.username = encodeURIComponent(username);
  url.password = encodeURIComponent(token);
  return url.toString();
}

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
}

function runGit(
  args: string[],
  cwd: string,
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, { cwd, env: gitEnv(), timeout });
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
  const token = participant.tokenEnvVar ? process.env[participant.tokenEnvVar] : undefined;
  const username = participant.tokenUsername ?? 'token';
  const cloneUrl = token ? authRepoUrl(repoUrl, username, token) : repoUrl;

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
        runGit(['clone', '--depth', '1', '--single-branch', cloneUrl, workDir], process.cwd(), timeout),
        timeout,
        'Git clone timed out',
      ),
    );
    cloneMs = performance.now() - cloneStart;

    if (!token) {
      measure({ cloneMs, repoUrl, branch, pushSkipped: true, pullSkipped: true, commitSha: '' });
      return { data: { cloneMs, pushMs: 0, pullMs: 0, repoUrl, branch, commitSha: '' } };
    }

    const defaultBranch = await runGit(['branch', '--show-current'], workDir, timeout)
      .then((r) => r.stdout.trim())
      .catch(() => participant.defaultBranch ?? 'main');

    // Prepare, commit, and push the test branch.
    await runGit(['checkout', '-b', branch], workDir, timeout);
    await fs.promises.writeFile(path.join(workDir, 'bench.txt'), `benchmark ${branch}\n`);
    await runGit(['add', 'bench.txt'], workDir, timeout);
    const commitResult = await runGit(
      ['-c', `user.name=${COMMITTER_NAME}`, '-c', `user.email=${COMMITTER_EMAIL}`, 'commit', '-m', `bench: ${branch}`],
      workDir,
      timeout,
    );
    const commitSha = commitResult.stdout.match(/\[.+?\s+([a-f0-9]+)\]/)?.[1] ?? '';

    const pushStart = performance.now();
    await step('push', () =>
      withTimeout(
        runGit(['push', '-u', 'origin', branch], workDir, timeout),
        timeout,
        'Git push timed out',
      ),
    );
    pushMs = performance.now() - pushStart;

    await runGit(['checkout', defaultBranch], workDir, timeout);

    const pullStart = performance.now();
    await step('pull', () =>
      withTimeout(
        runGit(['pull', '--ff-only', 'origin', branch], workDir, timeout),
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
