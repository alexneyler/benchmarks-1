/**
 * Git workflow benchmark. Measures shallow clone, commit+push, and pull over
 * HTTPS for git hosting providers by shelling out to `git`.
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * The push/pull workflow runs only when BOTH the participant's token env var
 * AND the writable repo URL override are set. For the read-only public fixtures
 * (GitHub/GitLab/Bitbucket defaults), only the `clone` step is exercised.
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

function resolveRepoConfig(config: GitProviderConfig): { repoUrl: string; writable: boolean } {
  const override = config.repoUrlEnvVar ? process.env[config.repoUrlEnvVar] : undefined;
  const repoUrl = override ? sanitizeRepoUrl(override) : sanitizeRepoUrl(config.url);
  return { repoUrl, writable: !!override };
}

function sanitizeRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return repoUrl;
  }
}

function buildGitEnv(
  useAuth: boolean,
  username: string,
  token: string,
  askpassPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (useAuth && askpassPath) {
    env.GIT_ASKPASS = askpassPath;
    env.GIT_BENCH_USER = username;
    env.GIT_BENCH_PASS = token;
  }
  return env;
}

async function writeAskpassScript(askpassPath: string): Promise<void> {
  const script = `#!/bin/sh
case "$1" in
  *Password*) printf '%s\\n' "$GIT_BENCH_PASS" ;;
  *Username*) printf '%s\\n' "$GIT_BENCH_USER" ;;
  *) printf '%s\\n' "$GIT_BENCH_USER" ;;
esac
`;
  await fs.promises.writeFile(askpassPath, script, { mode: 0o755 });
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

  const { repoUrl, writable } = resolveRepoConfig(participant);
  const token = participant.tokenEnvVar ? process.env[participant.tokenEnvVar] : undefined;
  const username = participant.tokenUsername ?? 'token';
  const useAuth = !!(token && writable);

  const branch = `${participant.name}-${taskIndex}-${Date.now()}`;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bench-git-'));
  const workDir = path.join(tempDir, 'repo');
  const askpassPath = path.join(tempDir, 'askpass.sh');

  if (useAuth) {
    await writeAskpassScript(askpassPath);
  }

  const env = buildGitEnv(useAuth, username, token ?? '', askpassPath);
  function runGit(
    args: string[],
    cwd: string,
    execTimeout = timeout,
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, { cwd, env, timeout: execTimeout });
  }

  let cloneMs = 0;
  let pushMs = 0;
  let pullMs = 0;
  let pushSucceeded = false;

  try {
    const cloneStart = performance.now();
    await step('clone', () =>
      withTimeout(
        runGit(['clone', '--depth', '1', '--single-branch', repoUrl, workDir], process.cwd()),
        timeout,
        'Git clone timed out',
      ),
    );
    cloneMs = performance.now() - cloneStart;

    if (!useAuth) {
      measure({ cloneMs, repoUrl, branch, pushMs: 0, pullMs: 0, commitSha: '' });
      return { data: { cloneMs, pushMs: 0, pullMs: 0, repoUrl, branch, commitSha: '' } };
    }

    const defaultBranch = await runGit(['branch', '--show-current'], workDir)
      .then((r) => r.stdout.trim())
      .catch(() => participant.defaultBranch ?? 'main');

    // Prepare, commit, and push the test branch.
    await runGit(['checkout', '-b', branch], workDir);
    await fs.promises.writeFile(path.join(workDir, 'bench.txt'), `benchmark ${branch}\n`);
    await runGit(['add', 'bench.txt'], workDir);
    const commitResult = await runGit(
      ['-c', `user.name=${COMMITTER_NAME}`, '-c', `user.email=${COMMITTER_EMAIL}`, 'commit', '-m', `bench: ${branch}`],
      workDir,
    );
    const commitSha = commitResult.stdout.match(/\[.+?\s+([a-f0-9]+)\]/)?.[1] ?? '';

    const pushStart = performance.now();
    await step('push', () =>
      withTimeout(
        runGit(['push', '-u', 'origin', branch], workDir),
        timeout,
        'Git push timed out',
      ),
    );
    pushMs = performance.now() - pushStart;
    pushSucceeded = true;

    await runGit(['checkout', defaultBranch], workDir);

    const pullStart = performance.now();
    await step('pull', () =>
      withTimeout(
        runGit(['pull', '--ff-only', 'origin', branch], workDir),
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
    if (pushSucceeded && useAuth) {
      await runGit(['push', 'origin', '--delete', branch], workDir, timeout).catch(() => {});
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
