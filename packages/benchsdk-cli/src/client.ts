import { createBenchmarkClient, type BenchmarkClient, BenchmarkApiError } from '@benchsdk/api';
import {
  loadCredentials,
  saveCredentials,
  loadConfig,
  mergeConfig,
  type Credentials,
  type Config,
} from './config.js';
import { refreshAccessToken, AuthError } from './auth.js';
import { getApiBaseUrl, getAuthBaseUrl, getPlatformBaseUrl } from './platform.js';

export interface CliAuth {
  token?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  refreshExpiresAt?: number;
  apiKey?: string;
  orgSlug?: string;
  orgId?: string;
  baseUrl: string;
  apiBaseUrl: string;
  authBaseUrl: string;
  format?: 'json' | 'table';
}

function tokenFromEnvironment(): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env.BENCHMARKS_PLATFORM_TOKEN;
}

function apiKeyFromEnvironment(): string | undefined {
  if (typeof process === 'undefined') return undefined;
  return process.env.BENCHMARKS_PLATFORM_API_KEY ?? process.env.COMPUTESDK_API_KEY;
}

function isNonInteractive(): boolean {
  if (typeof process === 'undefined') return false;
  return !!process.env.CI || process.stdin.isTTY === false;
}

function computeTokenExpiry(expiresInSeconds: number): number {
  return Date.now() + expiresInSeconds * 1000;
}

function updateCredentialsWithTokenResponse(
  credentials: Credentials,
  response: { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number },
): Credentials {
  return {
    ...credentials,
    token: response.access_token,
    refreshToken: response.refresh_token,
    tokenExpiresAt: computeTokenExpiry(response.expires_in),
    refreshExpiresAt: computeTokenExpiry(response.refresh_expires_in),
  };
}

async function refreshIfNeeded(auth: CliAuth, credentials: Credentials): Promise<Credentials> {
  if (!auth.token || auth.apiKey) return credentials;

  const now = Date.now();
  const expiry = auth.tokenExpiresAt ?? 0;
  const refreshExpiry = auth.refreshExpiresAt ?? 0;

  // Refresh when the access token expires within 5 minutes or has already expired,
  // but only if we have a refresh token and it is still valid.
  if (now < expiry - 5 * 60 * 1000) {
    return credentials;
  }

  if (!auth.refreshToken || now >= refreshExpiry) {
    throw new AuthError(
      'Your session has expired. Run `bench auth login` or set BENCHMARKS_PLATFORM_API_KEY.',
    );
  }

  try {
    const response = await refreshAccessToken(auth.authBaseUrl, auth.refreshToken);
    const updated = updateCredentialsWithTokenResponse(credentials, response);
    await saveCredentials(updated);
    return updated;
  } catch {
    throw new AuthError(
      'Failed to refresh your session. Run `bench auth login` or set BENCHMARKS_PLATFORM_API_KEY.',
    );
  }
}

export function getAuthHeader(auth: CliAuth): string | undefined {
  const token = auth.token ?? auth.apiKey ?? apiKeyFromEnvironment();
  if (!token) return undefined;
  return `Bearer ${token}`;
}

export async function resolveAuth(override?: {
  baseUrl?: string;
  apiKey?: string;
  org?: string;
}): Promise<CliAuth> {
  const config = (await loadConfig()) ?? ({} as Config);
  const credentials = (await loadCredentials()) ?? ({} as Credentials);
  const mergedConfig = mergeConfig(config, {
    baseUrl: override?.baseUrl,
    org: override?.org,
  });

  const platformUrl = mergedConfig.baseUrl ?? credentials.baseUrl ?? getPlatformBaseUrl();
  const apiBaseUrl = getApiBaseUrl(platformUrl);
  const authBaseUrl = getAuthBaseUrl(platformUrl);
  const orgSlug = override?.org ?? credentials.orgSlug ?? config.org;
  const orgId = credentials.orgId;
  const format = config.format;

  let token = tokenFromEnvironment() ?? credentials.token;
  let apiKey = override?.apiKey;
  let refreshToken = credentials.refreshToken;
  let tokenExpiresAt = credentials.tokenExpiresAt;
  let refreshExpiresAt = credentials.refreshExpiresAt;

  if (apiKey) {
    token = undefined;
    refreshToken = undefined;
  } else if (apiKeyFromEnvironment()) {
    apiKey = apiKeyFromEnvironment();
    token = undefined;
    refreshToken = undefined;
  } else if (token && token !== credentials.token) {
    // Environment token does not refresh through the CLI.
    refreshToken = undefined;
    tokenExpiresAt = undefined;
  }

  let auth: CliAuth = {
    token,
    refreshToken,
    tokenExpiresAt,
    refreshExpiresAt,
    apiKey,
    orgSlug,
    orgId,
    baseUrl: platformUrl,
    apiBaseUrl,
    authBaseUrl,
    format,
  };

  if (auth.token && auth.refreshToken && !auth.apiKey) {
    const updated = await refreshIfNeeded(auth, credentials);
    auth = {
      ...auth,
      token: updated.token,
      refreshToken: updated.refreshToken,
      tokenExpiresAt: updated.tokenExpiresAt,
      refreshExpiresAt: updated.refreshExpiresAt,
    };
  }

  if (!auth.token && !auth.apiKey && !apiKeyFromEnvironment() && !tokenFromEnvironment()) {
    if (isNonInteractive()) {
      throw new AuthError(
        'No credentials found in non-interactive mode. Set BENCHMARKS_PLATFORM_API_KEY or BENCHMARKS_PLATFORM_TOKEN.',
      );
    }
  }

  return auth;
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
  if (!authorization) throw new AuthError('Not authenticated.');
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
  if (!authorization) throw new AuthError('Not authenticated.');
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
  if (!authorization) throw new AuthError('Not authenticated.');
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
  const result = JSON.parse(text) as {
    activeOrganizationId: string | null;
    organization: { id: string; name: string; slug: string } | null;
    accessToken?: string | null;
    expiresIn?: number;
  };

  if (result.accessToken) {
    auth.token = result.accessToken;
    auth.tokenExpiresAt = computeTokenExpiry(result.expiresIn ?? 3600);
  }

  return {
    activeOrganizationId: result.activeOrganizationId,
    organization: result.organization,
  };
}
