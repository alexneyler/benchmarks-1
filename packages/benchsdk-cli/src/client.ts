import { createBenchmarkClient, type BenchmarkClient, BenchmarkApiError } from '@benchsdk/api';
import { loadCredentials, type Credentials } from './config.js';
import { getApiBaseUrl, getAuthBaseUrl, getPlatformBaseUrl } from './platform.js';

export interface CliAuth {
  token?: string;
  apiKey?: string;
  orgSlug?: string;
  orgId?: string;
  baseUrl: string;
  apiBaseUrl: string;
  authBaseUrl: string;
}

function tokenFromEnvironment(): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env.BENCHMARKS_PLATFORM_TOKEN;
}

export function getAuthHeader(auth: CliAuth): string | undefined {
  const token = auth.token ?? auth.apiKey ?? process.env.BENCHMARKS_PLATFORM_API_KEY ?? process.env.COMPUTESDK_API_KEY;
  if (!token) return undefined;
  return `Bearer ${token}`;
}

export async function resolveAuth(override?: {
  baseUrl?: string;
  apiKey?: string;
  org?: string;
}): Promise<CliAuth> {
  const credentials = (await loadCredentials()) ?? ({} as Credentials);
  const platformUrl = override?.baseUrl ?? credentials.baseUrl ?? getPlatformBaseUrl();
  const apiBaseUrl = getApiBaseUrl(platformUrl);
  const authBaseUrl = getAuthBaseUrl(platformUrl);
  const token = override?.apiKey ? undefined : (credentials.token ?? tokenFromEnvironment());
  const apiKey = override?.apiKey;
  const orgSlug = override?.org ?? credentials.orgSlug;
  const orgId = credentials.orgId;

  if (!token && !apiKey && !process.env.BENCHMARKS_PLATFORM_API_KEY && !process.env.COMPUTESDK_API_KEY) {
    throw new Error('Not authenticated. Run `bench auth login` or set BENCHMARKS_PLATFORM_API_KEY.');
  }

  return { token, apiKey, orgSlug, orgId, baseUrl: platformUrl, apiBaseUrl, authBaseUrl };
}

export async function createApiClient(override?: { baseUrl?: string; apiKey?: string; org?: string }): Promise<{
  api: BenchmarkClient;
  auth: CliAuth;
}> {
  const auth = await resolveAuth(override);
  const api = createBenchmarkClient({
    baseUrl: auth.apiBaseUrl,
    token: auth.token,
    apiKey: auth.apiKey,
    orgSlug: auth.orgSlug,
    orgId: auth.orgId,
  });
  return { api, auth };
}

export async function getMe(auth: CliAuth): Promise<{
  user: { id: string; name?: string | null; email?: string | null };
  activeOrganizationId: string | null;
  organizations: { id: string; name: string; slug: string }[];
}> {
  const authorization = getAuthHeader(auth);
  if (!authorization) throw new Error('Not authenticated.');
  const response = await fetch(`${auth.apiBaseUrl}/me`, {
    headers: { Authorization: authorization },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new BenchmarkApiError(`Me request failed: ${response.status} ${response.statusText}`, response.status, text);
  }
  return JSON.parse(text) as {
    user: { id: string; name?: string | null; email?: string | null };
    activeOrganizationId: string | null;
    organizations: { id: string; name: string; slug: string }[];
  };
}

export async function listOrganizations(auth: CliAuth): Promise<{ id: string; name: string; slug: string }[]> {
  const authorization = getAuthHeader(auth);
  if (!authorization) throw new Error('Not authenticated.');
  const response = await fetch(`${auth.apiBaseUrl}/organizations`, {
    headers: { Authorization: authorization },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new BenchmarkApiError(
      `Organizations request failed: ${response.status} ${response.statusText}`,
      response.status,
      text,
    );
  }
  const data = JSON.parse(text) as { items: { id: string; name: string; slug: string }[] };
  return data.items ?? [];
}

export async function setActiveOrganization(
  auth: CliAuth,
  slug: string,
): Promise<{ activeOrganizationId: string | null; organization: { id: string; name: string; slug: string } | null }> {
  const authorization = getAuthHeader(auth);
  if (!authorization) throw new Error('Not authenticated.');
  const response = await fetch(`${auth.apiBaseUrl}/organizations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorization,
    },
    body: JSON.stringify({ slug }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new BenchmarkApiError(
      `Set active organization failed: ${response.status} ${response.statusText}`,
      response.status,
      text,
    );
  }
  return JSON.parse(text) as {
    activeOrganizationId: string | null;
    organization: { id: string; name: string; slug: string } | null;
  };
}
