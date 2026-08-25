export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  refresh_expires_in: number;
  scope?: string;
}

export class DeviceFlowError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function requestDeviceCode(authBaseUrl: string, clientId = 'benchsdk-cli'): Promise<DeviceCodeResponse> {
  const response = await fetch(`${authBaseUrl}/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  const text = await response.text();
  if (!response.ok) {
    let description = `Device code request failed: ${response.status} ${response.statusText}`;
    try {
      const body = JSON.parse(text) as { error_description?: string };
      if (body.error_description) description = body.error_description;
    } catch {
      // ignore
    }
    throw new DeviceFlowError('server_error', description);
  }
  return JSON.parse(text) as DeviceCodeResponse;
}

export async function exchangeDeviceToken(
  authBaseUrl: string,
  deviceCode: string,
  clientId = 'benchsdk-cli',
): Promise<TokenResponse> {
  const response = await fetch(`${authBaseUrl}/cli/device-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: clientId,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    let body: { error?: string; error_description?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {
      // ignore
    }
    const code = body.error ?? 'server_error';
    if (
      code === 'authorization_pending' ||
      code === 'slow_down' ||
      code === 'expired_token' ||
      code === 'access_denied' ||
      code === 'invalid_grant'
    ) {
      throw new DeviceFlowError(code, body.error_description ?? `Device flow error: ${code}`);
    }
    throw new Error(body.error_description ?? `Device token exchange failed: ${response.status} ${response.statusText}`);
  }
  return JSON.parse(text) as TokenResponse;
}

export async function refreshAccessToken(
  authBaseUrl: string,
  refreshToken: string,
  clientId = 'benchsdk-cli',
): Promise<TokenResponse> {
  const response = await fetch(`${authBaseUrl}/cli/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    let body: { error?: string; error_description?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {
      // ignore
    }
    throw new AuthError(body.error_description ?? `Token refresh failed: ${response.status} ${response.statusText}`);
  }
  return JSON.parse(text) as TokenResponse;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollDeviceToken(
  authBaseUrl: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresInSeconds: number,
  clientId = 'benchsdk-cli',
): Promise<TokenResponse> {
  const start = Date.now();
  let interval = intervalSeconds * 1000;
  const expiresIn = expiresInSeconds * 1000;

  while (Date.now() - start < expiresIn) {
    await sleep(interval);

    try {
      const token = await exchangeDeviceToken(authBaseUrl, deviceCode, clientId);
      return token;
    } catch (err) {
      if (err instanceof DeviceFlowError) {
        if (err.code === 'authorization_pending') continue;
        if (err.code === 'slow_down') {
          interval += 5000;
          continue;
        }
      }
      throw err;
    }
  }

  throw new DeviceFlowError('expired_token', 'Device code expired before authorization completed.');
}
