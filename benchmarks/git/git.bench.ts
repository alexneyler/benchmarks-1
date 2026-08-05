/**
 * Git workflow benchmark. Measures shallow clone, commit+push, and pull over
 * HTTPS for git hosting providers by shelling out to `git`.
 * Declarative — exports `config` + `task`; `bench run` owns the entrypoint.
 *
 * Every participant requires both a writable `*_GIT_REPO_URL` env var and a
 * matching `*_TOKEN` env var; the runner skips providers without credentials.
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
import { fileURLToPath } from 'node:url';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import { withTimeout } from '../src/util/timeout.js';
import { formatError } from '../src/util/error.js';
import { providers } from './providers.js';
import { writeGitLegacyResults } from './legacy-results.js';
import type { GitProviderConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const execFileAsync = promisify(execFile);
const CLONE_TIMEOUT_MS = 60_000;
const COMMITTER_NAME = 'ComputeSDK Benchmark';
const COMMITTER_EMAIL = 'bench@example.com';

function resolveRepoConfig(config: GitProviderConfig): { repoUrl: string; writable: boolean } {
  const override = config.repoUrlEnvVar ? process.env[config.repoUrlEnvVar] : undefined;
  const repoUrl = override ? sanitizeRepoUrl(override) : sanitizeRepoUrl(config.url ?? '');
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
  onComplete: (outcome) =>
    writeGitLegacyResults(outcome.participants, path.resolve(__dirname, '../../results/git')),
});

export const task = defineTask<GitProviderConfig>(async (ctx) => {
  const { participant, step, measure, taskIndex } = ctx;
  const timeout = participant.timeout ?? CLONE_TIMEOUT_MS;

  const { repoUrl, writable } = resolveRepoConfig(participant);
  const token = participant.tokenEnvVar ? process.env[participant.tokenEnvVar] : undefined;
  const username = participant.tokenUsername ?? 'token';
  const useAuth = !!(token && writable && repoUrl);

  const branch = `${participant.name}-${taskIndex}-${Date.now()}`;
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bench-git-'));
  const workDir = path.join(tempDir, 'repo');
  const pullDir = path.join(tempDir, 'pull');
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
      const skippedData: Record<string, number | string | boolean> = {
        cloneMs,
        branch,
        commitSha: '',
        pushSkipped: true,
        pullSkipped: true,
      };
      measure(skippedData as any);
      return { data: skippedData as any };
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

    // Prepare a separate shallow clone so the pull actually fetches the new
    // branch from the remote instead of finding all objects already local.
    await fs.promises.mkdir(pullDir, { recursive: true });
    await runGit(['init'], pullDir);
    await runGit(['remote', 'add', 'origin', repoUrl], pullDir);
    await runGit(['fetch', '--depth', '1', 'origin', defaultBranch], pullDir);
    await runGit(['checkout', '-b', defaultBranch, 'FETCH_HEAD'], pullDir);

    const pullStart = performance.now();
    await step('pull', () =>
      withTimeout(
        runGit(['pull', '--ff-only', 'origin', branch], pullDir),
        timeout,
        'Git pull timed out',
      ),
    );
    pullMs = performance.now() - pullStart;

    const authData: Record<string, number | string> = { cloneMs, pushMs, pullMs, branch, commitSha };
    measure(authData as any);
    return { data: authData as any };
  } catch (err) {
    throw new TaskError(formatError(err), {
      code: 'GIT_WORKFLOW_ERROR',
      data: { branch, cloneMs, pushMs, pullMs },
    });
  } finally {
    if (pushSucceeded && useAuth) {
      await runGit(['push', 'origin', '--delete', branch], workDir, timeout).catch(() => {});
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});
