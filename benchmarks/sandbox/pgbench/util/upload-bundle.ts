import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BundleKind } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BUNDLES_DIR = path.join(ROOT, 'dist', 'bundles');
const MANIFEST_PATH = path.join(BUNDLES_DIR, 'manifest.json');

interface BundleEntry {
  kind: string;
  hash: string;
  path: string;
  bytes: number;
  version?: string;
}

type Manifest = Record<string, BundleEntry>;

let cached: Manifest | null = null;

function readManifest(): Manifest {
  if (cached) return cached;
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(
      'Bundle manifest missing at ' + MANIFEST_PATH + '. ' +
      'Run \`pnpm run build:bundles\` first.',
    );
  }
  cached = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  return cached;
}

export function getBundlePath(kind: 'pglite'): string {
  const entry = readManifest()[kind];
  if (!entry) throw new Error('No "' + kind + '" entry in bundle manifest');
  return path.join(BUNDLES_DIR, entry.path);
}

export function getFixtureVersion(): string {
  const entry = readManifest()['fixture-archive'];
  return entry?.version ?? '0.0.0';
}

