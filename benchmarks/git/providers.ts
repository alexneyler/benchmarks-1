import type { GitProviderConfig } from './types.js';

/**
 * Git hosting provider benchmark configurations.
 *
 * Each participant points at a small public repo and uses isomorphic-git over
 * HTTPS. Tokens are optional: when `tokenEnvVar` is set and present, it is
 * passed via `onAuth`; otherwise the clone is anonymous.
 */
export const providers: GitProviderConfig[] = [
  {
    name: 'github',
    requiredEnvVars: [],
    url: 'https://github.com/octocat/Spoon-Knife.git',
    tokenEnvVar: 'GITHUB_TOKEN',
    tokenUsername: 'token',
  },
  {
    name: 'gitlab',
    requiredEnvVars: [],
    url: 'https://gitlab.com/gitlab-org/gitlab-test.git',
    tokenEnvVar: 'GITLAB_TOKEN',
    tokenUsername: 'oauth2',
  },
  {
    name: 'bitbucket',
    requiredEnvVars: [],
    url: 'https://bitbucket.org/atlassian/hello-world.git',
    tokenEnvVar: 'BITBUCKET_TOKEN',
    tokenUsername: 'x-token-auth',
  },
  //
  // add git providers above
];
