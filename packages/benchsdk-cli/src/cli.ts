import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BenchmarkApiError } from '@benchsdk/api';
import { requestDeviceCode, pollDeviceToken } from './auth.js';
import { loadCredentials, saveCredentials, clearCredentials } from './config.js';
import { createApiClient, getMe, listOrganizations, setActiveOrganization } from './client.js';
import { printData, type OutputOptions } from './output.js';
import { getPlatformBaseUrl } from './platform.js';

const USAGE = `Usage: csdk-bench [options] <command>

Commands:
  auth login                         Authenticate with OAuth device flow
  auth logout                        Remove saved credentials
  auth status                        Show current user and active organization
  org list                           List organizations
  org use <slug>                     Set active organization
  benchmarks list                    List benchmarks
  runs list <benchmark-slug> [--limit N]
  runs show <benchmark-slug> <runId>
  results <benchmark-slug> [--run <id>] [--format json|table]
  artifacts list <benchmark-slug> <runId> [--worker <id>]
  export <benchmark-slug> [--run <id>] [--out <dir>]

Options:
  --base-url <url>                   Platform root URL (default: https://platform.computesdk.com)
  --api-key <key>                    Use an API key instead of OAuth
  --org <slug>                       Organization slug for this command
  --json                             Output JSON (also --format json on results)
  --help                             Show this help
`;

interface GlobalOptions {
  'base-url'?: string;
  'api-key'?: string;
  org?: string;
  json?: boolean;
  help?: boolean;
}

interface ParsedOptions {
  values: GlobalOptions;
  positionals: string[];
}

function parseGlobalArgs(argv: string[]): ParsedOptions {
  const values: GlobalOptions = {};
  const positionals: string[] = [];
  const stringGlobals = new Set(['base-url', 'api-key', 'org']);
  const booleanGlobals = new Set(['json', 'help']);

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      i += 1;
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const namePart = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    const valuePart = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
    const key = namePart.slice(2);

    if (stringGlobals.has(key)) {
      const rawValue = valuePart !== undefined ? valuePart : argv[i + 1];
      if (rawValue === undefined) throw new Error(`Option --${key} requires a value`);
      (values as Record<string, string>)[key] = rawValue;
      i += valuePart !== undefined ? 1 : 2;
    } else if (booleanGlobals.has(key)) {
      if (valuePart !== undefined) {
        (values as Record<string, boolean>)[key] = valuePart === 'true' || valuePart === '1';
        i += 1;
      } else {
        (values as Record<string, boolean>)[key] = true;
        i += 1;
      }
    } else {
      // Unknown option: leave it for the subcommand parser.
      positionals.push(arg);
      i += 1;
    }
  }

  return { values, positionals };
}

const subcommandOptionSchema = {
  limit: { type: 'number' as const },
  run: { type: 'string' as const },
  format: { type: 'string' as const },
  worker: { type: 'string' as const },
  out: { type: 'string' as const },
};

function parseSubcommandOptions(args: string[]): { options: Record<string, string | number>; positionals: string[] } {
  const options: Record<string, string | number> = {};
  const positionals: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      i += 1;
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const namePart = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    const valuePart = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
    const key = namePart.slice(2);
    const schema = subcommandOptionSchema[key as keyof typeof subcommandOptionSchema];
    if (!schema) throw new Error(`Unknown option: ${arg}`);

    let rawValue: string;
    if (valuePart !== undefined) {
      rawValue = valuePart;
      i += 1;
    } else if (i + 1 < args.length) {
      rawValue = args[i + 1];
      i += 2;
    } else {
      throw new Error(`Option --${key} requires a value`);
    }

    if (schema.type === 'number') {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) throw new Error(`Option --${key} must be a number`);
      options[key] = n;
    } else {
      options[key] = rawValue;
    }
  }
  return { options, positionals };
}

async function printErrorAndExit(err: unknown): Promise<never> {
  if (err instanceof BenchmarkApiError) {
    console.error(`API error: ${err.message}`);
    if (err.body) console.error(err.body);
  } else if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error('Unexpected error:', err);
  }
  process.exit(1);
}

async function handleAuthLogin(overrides: { baseUrl?: string }): Promise<void> {
  const baseUrl = getPlatformBaseUrl(overrides.baseUrl);
  const authBaseUrl = `${baseUrl}/api/auth`;
  const { device_code, user_code, verification_uri_complete, verification_uri, expires_in, interval } =
    await requestDeviceCode(authBaseUrl);

  console.log(`To sign in, visit:`);
  console.log(verification_uri_complete ?? verification_uri);
  console.log(`User code: ${user_code}`);

  const { access_token } = await pollDeviceToken(authBaseUrl, device_code, interval, expires_in);
  await saveCredentials({ baseUrl, token: access_token, kind: 'oauth' });

  console.log('Authenticated.');

  const { api, auth } = await createApiClient({ baseUrl });
  try {
    const me = await getMe(auth);
    if (!me.activeOrganizationId && me.organizations.length === 1) {
      const org = me.organizations[0];
      await setActiveOrganization(auth, org.slug);
      await saveCredentials({ baseUrl, token: access_token, kind: 'oauth', orgSlug: org.slug, orgId: org.id });
      console.log(`Set active organization to ${org.slug}`);
    }
  } catch {
    // organization auto-select is best-effort
  }
}

async function handleAuthLogout(): Promise<void> {
  await clearCredentials();
  console.log('Logged out.');
}

async function handleAuthStatus(
  overrides: { baseUrl?: string; apiKey?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { auth } = await createApiClient(overrides);
  const me = await getMe(auth);
  const activeOrg = me.organizations.find((o) => o.id === me.activeOrganizationId);
  printData(
    {
      user: me.user,
      activeOrganization: activeOrg ?? null,
      organizations: me.organizations,
    },
    outputOptions,
  );
}

async function handleOrgList(
  overrides: { baseUrl?: string; apiKey?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { auth } = await createApiClient(overrides);
  const organizations = await listOrganizations(auth);
  printData(organizations, outputOptions);
}

async function handleOrgUse(slug: string, overrides: { baseUrl?: string; apiKey?: string }): Promise<void> {
  const credentials = (await loadCredentials()) ?? {};
  const { auth } = await createApiClient(overrides);
  const result = await setActiveOrganization(auth, slug);
  if (!result.organization) {
    throw new Error(`Could not set active organization to ${slug}`);
  }
  await saveCredentials({
    ...credentials,
    baseUrl: auth.baseUrl,
    orgSlug: result.organization.slug,
    orgId: result.organization.id,
  });
  console.log(`Active organization set to ${result.organization.slug} (${result.organization.id})`);
}

async function handleBenchmarksList(
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const benchmarks = await api.listBenchmarks();
  printData(benchmarks, outputOptions);
}

async function handleRunsList(
  benchmarkSlug: string,
  limit: number | undefined,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const runs = await api.listRuns(benchmarkSlug);
  printData(limit ? runs.slice(0, limit) : runs, outputOptions);
}

async function handleRunsShow(
  benchmarkSlug: string,
  runId: string,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const run = await api.getRun(benchmarkSlug, runId);
  printData(run, outputOptions);
}

async function handleResults(
  benchmarkSlug: string,
  options: { run?: string; format?: string },
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const results = options.run
    ? await api.getRunResults(benchmarkSlug, options.run as string)
    : await api.getBenchmarkResults(benchmarkSlug);
  printData(results, { json: outputOptions.json || options.format === 'json' });
}

async function handleArtifactsList(
  benchmarkSlug: string,
  runId: string,
  workerId: string | undefined,
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
  outputOptions: OutputOptions = {},
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const artifacts = workerId
    ? await api.listWorkerArtifacts(benchmarkSlug, runId, workerId)
    : await api.listRunArtifacts(benchmarkSlug, runId);
  printData(artifacts, outputOptions);
}

async function handleExport(
  benchmarkSlug: string,
  options: { run?: string; out?: string },
  overrides: { baseUrl?: string; apiKey?: string; org?: string },
): Promise<void> {
  const { api } = await createApiClient(overrides);
  const outDir = options.out ?? '.';
  await mkdir(outDir, { recursive: true });

  if (options.run) {
    const runId = options.run as string;
    const [run, results] = await Promise.all([api.getRun(benchmarkSlug, runId), api.getRunResults(benchmarkSlug, runId)]);
    const payload = { benchmarkSlug, runId, run, results };
    const path = join(outDir, `${benchmarkSlug}-${runId}.json`);
    await writeFile(path, JSON.stringify(payload, null, 2));
    console.log(`Exported to ${path}`);
  } else {
    const results = await api.getBenchmarkResults(benchmarkSlug);
    const path = join(outDir, `${benchmarkSlug}.json`);
    await writeFile(path, JSON.stringify(results, null, 2));
    console.log(`Exported to ${path}`);
  }
}

export async function run(argv: string[]): Promise<void> {
  let { values, positionals } = parseGlobalArgs(argv);
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const [command, ...rest] = positionals;
  const overrides = {
    baseUrl: values['base-url'],
    apiKey: values['api-key'],
    org: values.org,
  };
  const outputOptions: OutputOptions = { json: !!values.json };

  try {
    switch (command) {
      case 'auth': {
        const [sub, ...subRest] = rest;
        const { positionals: subPositionals } = parseSubcommandOptions(subRest);
        if (sub === 'login') {
          await handleAuthLogin(overrides);
        } else if (sub === 'logout') {
          await handleAuthLogout();
        } else if (sub === 'status') {
          await handleAuthStatus(overrides, outputOptions);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'org': {
        const [sub, ...subRest] = rest;
        const { positionals: subPositionals } = parseSubcommandOptions(subRest);
        if (sub === 'list') {
          await handleOrgList(overrides, outputOptions);
        } else if (sub === 'use') {
          const slug = subPositionals[0];
          if (!slug) throw new Error('Organization slug required: csdk-bench org use <slug>');
          await handleOrgUse(slug, overrides);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'benchmarks': {
        const [sub, ...subRest] = rest;
        if (sub === 'list') {
          await handleBenchmarksList(overrides, outputOptions);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'runs': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest);
        const [sub, slug, runId] = subPositionals;
        if (sub === 'list') {
          if (!slug) throw new Error('Benchmark slug required: csdk-bench runs list <benchmark-slug>');
          await handleRunsList(slug, options.limit as number | undefined, overrides, outputOptions);
        } else if (sub === 'show') {
          if (!slug || !runId) throw new Error('Usage: csdk-bench runs show <benchmark-slug> <runId>');
          await handleRunsShow(slug, runId, overrides, outputOptions);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'results': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest);
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: csdk-bench results <benchmark-slug>');
        await handleResults(slug, options, overrides, outputOptions);
        break;
      }
      case 'artifacts': {
        const [sub, ...subRest] = rest;
        const { options, positionals: subPositionals } = parseSubcommandOptions(subRest);
        if (sub === 'list') {
          const [slug, runId] = subPositionals;
          if (!slug || !runId) throw new Error('Usage: csdk-bench artifacts list <benchmark-slug> <runId>');
          await handleArtifactsList(slug, runId, options.worker as string | undefined, overrides, outputOptions);
        } else {
          throw new Error(USAGE);
        }
        break;
      }
      case 'export': {
        const { options, positionals: subPositionals } = parseSubcommandOptions(rest);
        const [slug] = subPositionals;
        if (!slug) throw new Error('Benchmark slug required: csdk-bench export <benchmark-slug>');
        await handleExport(slug, options, overrides);
        break;
      }
      default:
        throw new Error(USAGE);
    }
    process.exit(0);
  } catch (err) {
    await printErrorAndExit(err);
  }
}

export { parseGlobalArgs, parseSubcommandOptions };

