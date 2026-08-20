import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const RESULTS_PATH = path.resolve(PKG_ROOT, '../../results/burst_tti/latest.json');
const DATA_PATH = path.resolve(PKG_ROOT, 'src/data.json');

const LOGOS_PAGE_URL = 'https://www.computesdk.com/benchmarks/sandboxes/';
const SITE_ORIGIN = 'https://www.computesdk.com';
const LOGO_MAP_KEY = 'providerLogosDark';

interface Iteration {
  ttiMs: number;
  error?: string;
}

interface ResultEntry {
  provider: string;
  iterations: Iteration[];
  summary: { ttiMs: { median: number; p95: number; p99: number } };
  skipped?: boolean;
}

interface ResultFile {
  timestamp: string;
  results: ResultEntry[];
}

interface Provider {
  rank: number;
  provider: string;
  displayName: string;
  score: number;
  logoUrl: string | null;
}

const GATEWAY_PROVIDERS = ['render'];

function formatProviderName(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === 'e2b') return 'E2B';
  if (lower === 'opencomputer') return 'OpenComputer';
  const name = raw.charAt(0).toUpperCase() + raw.slice(1);
  return GATEWAY_PROVIDERS.includes(lower) ? `${name}*` : name;
}

function scoreMetric(valueMs: number): number {
  return Math.max(0, 100 * (1 - valueMs / 10_000));
}

function computeCompositeScore(entry: ResultEntry): number {
  if (entry.skipped || entry.iterations.length === 0) return 0;
  const successful = entry.iterations.filter((i) => !i.error).length;
  const successRate = successful / entry.iterations.length;
  if (successRate === 0) return 0;

  const { median, p95, p99 } = entry.summary.ttiMs;
  const timingScore =
    0.6 * scoreMetric(median) +
    0.25 * scoreMetric(p95) +
    0.15 * scoreMetric(p99);

  return Math.round(timingScore * successRate * 100) / 100;
}

async function fetchLogoMap(): Promise<Record<string, string>> {
  const response = await fetch(LOGOS_PAGE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${LOGOS_PAGE_URL}: ${response.status}`);
  }
  const html = await response.text();
  const decoded = html.replace(/&quot;/g, '"');

  const match = decoded.match(new RegExp(`${LOGO_MAP_KEY}":\\[0,({[^}]*})\\]`));
  if (!match) {
    throw new Error(`Could not find ${LOGO_MAP_KEY} map on page`);
  }

  const objectStr = match[1];
  const jsonStr = objectStr.replace(/:\[0,"([^"]*)"\]/g, ':"$1"');
  const map = JSON.parse(jsonStr) as Record<string, string>;

  for (const [key, url] of Object.entries(map)) {
    if (typeof url === 'string' && url.startsWith('/')) {
      map[key] = `${SITE_ORIGIN}${url}`;
    }
  }

  return map;
}

async function main() {
  const [resultsRaw, logoMap] = await Promise.all([
    fs.readFile(RESULTS_PATH, 'utf-8').then(JSON.parse) as Promise<ResultFile>,
    fetchLogoMap(),
  ]);

  const providers: Provider[] = resultsRaw.results
    .map((entry) => ({
      provider: entry.provider,
      displayName: formatProviderName(entry.provider),
      score: computeCompositeScore(entry),
      logoUrl: logoMap[entry.provider] ?? null,
    }))
    .sort((a, b) => b.score - a.score)
    .map((p, index) => ({ ...p, rank: index + 1 }));

  const data = {
    title: 'Sandbox Benchmark Composite Scores',
    subtitle: 'Burst concurrency leaderboard',
    updatedAt: resultsRaw.timestamp,
    providers,
  };

  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`Wrote ${DATA_PATH} with ${providers.length} providers`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
