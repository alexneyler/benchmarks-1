import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  capitalize,
  normalizeProvider,
  providerLogoUrl,
  type LogoFormat,
  type LogoVariant,
} from './logo';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.resolve(PKG_ROOT, 'src/data.json');

const SITE_ORIGIN = 'https://www.computesdk.com';
const SPONSORS_PAGE_URL = `${SITE_ORIGIN}/partners/`;

const RESULTS_DIR = path.resolve(PKG_ROOT, '../../results');

function getValidatedBenchmark(raw: string | undefined): string {
  const benchmark = (raw ?? 'burst_tti').trim();
  if (
    !/^[a-zA-Z0-9_\-/]+$/.test(benchmark) ||
    benchmark.includes('..') ||
    benchmark.startsWith('/') ||
    benchmark.endsWith('/')
  ) {
    throw new Error(`Invalid benchmark name: ${benchmark}`);
  }
  return benchmark;
}

const BENCHMARK = getValidatedBenchmark(process.argv[2] ?? process.env.BENCHMARK);
const BENCHMARK_TITLE = process.env.BENCHMARK_TITLE;

const LOGO_VARIANT: LogoVariant = 'logo-dark';
const LOGO_FORMAT: LogoFormat = 'normalized';

// Benchmarks that should be ranked by time (lower totalMs = better/faster bar).
const TIME_BASED_BENCHMARKS = new Set(['sandbox-dax']);

const BENCHMARK_TITLES: Record<string, string> = {
  'burst_tti': 'Burst TTI Benchmarks',
  'sequential_tti': 'Sequential TTI Benchmarks',
  'staggered_tti': 'Staggered TTI Benchmarks',
  'sandbox-dax': 'Dax Benchmarks',
  'browser': 'Browser Benchmarks',
  'browser-throughput': 'Browser Throughput Benchmarks',
  'storage/1mb': 'Storage Benchmarks',
  'storage/4mb': 'Storage Benchmarks',
  'storage/10mb': 'Storage Benchmarks',
  'storage/16mb': 'Storage Benchmarks',
  'snapshot-fork/small': 'Snapshot Fork Benchmarks',
  'ai-gateway-latency/anthropic': 'AI Gateway (Anthropic) Benchmarks',
  'ai-gateway-latency/openai': 'AI Gateway (OpenAI) Benchmarks',
  'ai-gateway-latency/gemini': 'AI Gateway (Gemini) Benchmarks',
  'ai-gateway-latency/kimi': 'AI Gateway (Kimi) Benchmarks',
};

interface Iteration {
  phasesCompleted?: number;
  phasesTotal?: number;
  totalMs?: number;
  error?: string;
  [key: string]: unknown;
}

interface ResultEntry {
  provider: string;
  compositeScore?: number | null;
  successRate?: number | null;
  skipped?: boolean;
  iterations?: Iteration[];
  summary?: Record<string, unknown>;
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
  displayValue?: string | number;
  logoUrl: string | null;
}

interface Sponsor {
  name: string;
  logoUrl: string;
}

interface LeaderboardData {
  title: string;
  updatedAt: string;
  providers: Provider[];
  sponsors: Sponsor[];
  valueLabel?: string;
}

function humanizeBenchmark(raw: string): string {
  const parts = raw.split(/[/]/).pop() ?? raw;
  const words = parts.split(/[-_]/).map((word) =>
    word === 'ai'
      ? 'AI'
      : word === 'tti'
      ? 'TTI'
      : word.charAt(0).toUpperCase() + word.slice(1),
  );
  return `${words.join(' ')} Benchmarks`;
}

function getBenchmarkTitle(benchmark: string, override?: string): string {
  if (override) return override;
  return BENCHMARK_TITLES[benchmark] ?? humanizeBenchmark(benchmark);
}

function getResultPath(benchmark: string): string {
  const resultPath = path.resolve(RESULTS_DIR, benchmark, 'latest.json');
  const normalizedResult = path.normalize(resultPath) + path.sep;
  const normalizedBase = path.normalize(RESULTS_DIR) + path.sep;
  if (!normalizedResult.startsWith(normalizedBase)) {
    throw new Error(`Invalid benchmark name: ${benchmark}`);
  }
  return resultPath;
}

function computeScore(entry: ResultEntry): number {
  if (typeof entry.compositeScore === 'number' && !Number.isNaN(entry.compositeScore)) {
    return entry.compositeScore;
  }

  const iterations = entry.iterations;
  if (Array.isArray(iterations) && iterations.length > 0) {
    const values = iterations
      .map((it) => (typeof it.phasesCompleted === 'number' ? it.phasesCompleted : 0))
      .sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    const median =
      values.length % 2 !== 0
        ? values[mid]
        : (values[mid - 1] + values[mid]) / 2;

    const total =
      iterations.find((it) => typeof it.phasesTotal === 'number' && it.phasesTotal > 0)
        ?.phasesTotal ?? 7;

    return Math.max(0, Math.min(100, (median / total) * 100));
  }

  return 0;
}

function getMedianTotalMs(entry: ResultEntry): number | null {
  if (entry.successRate !== 1) return null;

  const summary = entry.summary as { totalMs?: { median?: number } } | undefined;
  const summaryMedian = summary?.totalMs?.median;
  if (typeof summaryMedian === 'number' && !Number.isNaN(summaryMedian) && summaryMedian > 0) {
    return summaryMedian;
  }

  const iterations = entry.iterations;
  if (Array.isArray(iterations) && iterations.length > 0) {
    const totals = iterations
      .map((it) => (typeof it.totalMs === 'number' ? it.totalMs : NaN))
      .filter((v) => !Number.isNaN(v) && v > 0)
      .sort((a, b) => a - b);
    if (totals.length === 0) return null;
    const mid = Math.floor(totals.length / 2);
    return totals.length % 2 !== 0
      ? totals[mid]
      : (totals[mid - 1] + totals[mid]) / 2;
  }

  return null;
}

function normalizeTimeScore(timeMs: number, minTime: number, maxTime: number): number {
  if (maxTime <= minTime) return 100;
  return Math.max(0, Math.min(100, ((maxTime - timeMs) / (maxTime - minTime)) * 100));
}

function resolveProviderLogoUrl(provider: string): string | null {
  const normalized = normalizeProvider(provider);
  const url = providerLogoUrl(normalized, LOGO_VARIANT, LOGO_FORMAT);
  if (!url) return null;
  return url.startsWith('/') ? `${SITE_ORIGIN}${url}` : url;
}

function formatProviderName(provider: string): string {
  return capitalize(normalizeProvider(provider));
}

async function fetchSponsors(): Promise<Sponsor[]> {
  const response = await fetch(SPONSORS_PAGE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${SPONSORS_PAGE_URL}: ${response.status}`);
  }
  const html = await response.text();
  const decoded = html.replace(/&quot;/g, '"');

  const seen = new Set<string>();
  const sponsors: Sponsor[] = [];

  const imgTags =
    decoded.match(
      /<img[^>]*src="[^"]*logos\.computesdk\.com[^"]*dark[^"]*"[^>]*>/g,
    ) ?? [];

  for (const tag of imgTags) {
    const srcMatch = tag.match(/src="([^"]*)"/);
    const altMatch = tag.match(/alt="([^"]*)"/);
    if (!srcMatch) continue;
    const src = srcMatch[1].startsWith('/')
      ? `${SITE_ORIGIN}${srcMatch[1]}`
      : srcMatch[1];
    if (seen.has(src)) continue;
    seen.add(src);
    sponsors.push({
      name: altMatch?.[1] ?? '',
      logoUrl: src,
    });
  }

  return sponsors;
}

async function main() {
  const resultPath = getResultPath(BENCHMARK);
  const [resultsRaw, sponsors] = await Promise.all([
    fs.readFile(resultPath, 'utf-8').then(JSON.parse) as Promise<ResultFile>,
    fetchSponsors(),
  ]);

  const parsedResults = resultsRaw.results.filter((entry) => !entry.skipped);
  const isTimeBased = TIME_BASED_BENCHMARKS.has(BENCHMARK);

  let baseProviders: Omit<Provider, 'rank'>[];

  if (isTimeBased) {
    const providersWithTime: { entry: ResultEntry; timeMs: number }[] = [];
    const providersWithoutTime: ResultEntry[] = [];

    for (const entry of parsedResults) {
      const timeMs = getMedianTotalMs(entry);
      if (timeMs !== null) {
        providersWithTime.push({ entry, timeMs });
      } else {
        providersWithoutTime.push(entry);
      }
    }

    const timeValues = providersWithTime.map((p) => p.timeMs);
    const minTime = timeValues.length > 0 ? Math.min(...timeValues) : 0;
    const maxTime = timeValues.length > 0 ? Math.max(...timeValues) : 0;

    baseProviders = [
      ...providersWithTime.map(({ entry, timeMs }) => ({
        provider: entry.provider,
        displayName: formatProviderName(entry.provider),
        score: normalizeTimeScore(timeMs, minTime, maxTime),
        displayValue: `${(timeMs / 1000).toFixed(1)}s`,
        logoUrl: resolveProviderLogoUrl(entry.provider),
      })),
      ...providersWithoutTime.map((entry) => ({
        provider: entry.provider,
        displayName: formatProviderName(entry.provider),
        score: 0,
        displayValue: '—',
        logoUrl: resolveProviderLogoUrl(entry.provider),
      })),
    ];
  } else {
    baseProviders = parsedResults.map((entry) => ({
      provider: entry.provider,
      displayName: formatProviderName(entry.provider),
      score: computeScore(entry),
      logoUrl: resolveProviderLogoUrl(entry.provider),
    }));
  }

  const providers: Provider[] = baseProviders
    .sort((a, b) => b.score - a.score)
    .map((provider, index) => ({ ...provider, rank: index + 1 }));

  const data: LeaderboardData = {
    title: getBenchmarkTitle(BENCHMARK, BENCHMARK_TITLE),
    updatedAt: resultsRaw.timestamp,
    providers,
    sponsors,
    valueLabel: isTimeBased ? 'Total Time (s)' : undefined,
  };

  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(
    `Wrote ${DATA_PATH} for ${BENCHMARK} with ${providers.length} providers and ${sponsors.length} sponsors`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
