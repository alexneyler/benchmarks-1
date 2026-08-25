import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface Credentials {
  baseUrl?: string;
  token?: string;
  orgSlug?: string;
  orgId?: string;
  kind?: 'oauth' | 'api-key';
}

const CONFIG_DIR = join(homedir(), '.benchsdk');
const CREDENTIALS_PATH = join(CONFIG_DIR, 'credentials.json');

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(raw) as Credentials;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2));
}

export async function clearCredentials(): Promise<void> {
  try {
    await rm(CREDENTIALS_PATH);
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return;
    throw err;
  }
}
