import type { GitProviderConfig } from './types.js';

/**
 * Git hosting provider benchmark configurations.
 *
 * Each participant points at an HTTPS repo. The `url` field provides a
 * read-only default (where a public fixture exists); set the matching
 * `*_GIT_REPO_URL` env var to a writable repo and the matching token env var
 * to enable the push/pull workflow. Tensorlake is gated by required env vars
 * because it has no public fixture.
 */
export const providers: GitProviderConfig[] = [
  {
    name: 'github',
    requiredEnvVars: [],
    url: 'https://github.com/octocat/Spoon-Knife.git',
    repoUrlEnvVar: 'GITHUB_GIT_REPO_URL',
    tokenEnvVar: 'GITHUB_TOKEN',
    tokenUsername: 'token',
  },
  {
    name: 'gitlab',
    requiredEnvVars: [],
    url: 'https://gitlab.com/gitlab-org/gitlab-test.git',
    repoUrlEnvVar: 'GITLAB_GIT_REPO_URL',
    tokenEnvVar: 'GITLAB_TOKEN',
    tokenUsername: 'oauth2',
  },
  {
    name: 'bitbucket',
    requiredEnvVars: [],
    url: 'https://bitbucket.org/atlassian/hello-world.git',
    repoUrlEnvVar: 'BITBUCKET_GIT_REPO_URL',
    tokenEnvVar: 'BITBUCKET_TOKEN',
    tokenUsername: 'x-token-auth',
  },
  {
    name: 'tensorlake',
    requiredEnvVars: ['TENSORLAKE_GIT_REPO_URL', 'TENSORLAKE_API_KEY'],
    url: process.env.TENSORLAKE_GIT_REPO_URL ?? '',
    repoUrlEnvVar: 'TENSORLAKE_GIT_REPO_URL',
    tokenEnvVar: 'TENSORLAKE_API_KEY',
    tokenUsername: 't',
  },
  //
  // add git providers above
];
