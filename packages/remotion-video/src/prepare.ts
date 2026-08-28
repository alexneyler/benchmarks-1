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
  'storage': 'Storage Benchmarks',
  'storage/1mb': 'Storage 1 MB Benchmarks',
  'storage/4mb': 'Storage 4 MB Benchmarks',
  'storage/10mb': 'Storage 10 MB Benchmarks',
  'storage/16mb': 'Storage 16 MB Benchmarks',
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

async function loadResultFile(benchmark: string): Promise<ResultFile> {
  const resultPath = getResultPath(benchmark);
  const raw = await fs.readFile(resultPath, 'utf-8');
  return JSON.parse(raw) as ResultFile;
}

async function loadCombinedStorageResults(): Promise<ResultFile> {
  const sizes = ['1mb', '4mb', '10mb', '16mb'];
  const files = await Promise.all(sizes.map((size) => loadResultFile(`storage/${size}`)));

  const byProvider = new Map<
    string,
    { provider: string; scores: number[]; successRates: number[] }
  >();

  let latestTimestamp = '';
  for (const file of files) {
    if (file.timestamp > latestTimestamp) latestTimestamp = file.timestamp;
    for (const r of file.results) {
      if (r.skipped) continue;
      if (!byProvider.has(r.provider)) {
        byProvider.set(r.provider, { provider: r.provider, scores: [], successRates: [] });
      }
      const entry = byProvider.get(r.provider)!;
      if (typeof r.compositeScore === 'number') entry.scores.push(r.compositeScore);
      if (typeof r.successRate === 'number') entry.successRates.push(r.successRate);
    }
  }

  const results: ResultEntry[] = [];
  for (const { provider, scores, successRates } of byProvider.values()) {
    const avgScore = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0;
    const avgSuccess = successRates.length > 0
      ? successRates.reduce((a, b) => a + b, 0) / successRates.length
      : 0;

    results.push({
      provider,
      compositeScore: avgScore,
      successRate: avgSuccess,
    });
  }

  return { timestamp: latestTimestamp, results };
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

// ---- Dax sanitization/ranking aligned with computesdk/dotcom ----

const DAX_PHASES_TOTAL = 7;

const DAX_SCRIPT_PHASE_NAMES = [
  'prepare',
  'cache_clear',
  'bun_download',
  'bun_unpack',
  'clone',
  'install',
  'typecheck',
];

type DaxPhaseKey =
  | 'totalMs'
  | 'prepareMs'
  | 'bunDownloadMs'
  | 'bunUnpackMs'
  | 'cloneMs'
  | 'installMs'
  | 'typecheckMs';

const DAX_PHASE_KEYS: DaxPhaseKey[] = [
  'totalMs',
  'prepareMs',
  'bunDownloadMs',
  'bunUnpackMs',
  'cloneMs',
  'installMs',
  'typecheckMs',
];

const DAX_METRIC_TO_SCRIPT_PHASE: Partial<Record<DaxPhaseKey, string>> = {
  prepareMs: 'prepare',
  bunDownloadMs: 'bun_download',
  bunUnpackMs: 'bun_unpack',
  cloneMs: 'clone',
  installMs: 'install',
  typecheckMs: 'typecheck',
};

const DAX_PHASE_ORDER: DaxPhaseKey[] = [
  'prepareMs',
  'bunDownloadMs',
  'bunUnpackMs',
  'cloneMs',
  'installMs',
  'typecheckMs',
];

type DaxIteration = Iteration & {
  [K in DaxPhaseKey]?: number | undefined;
};

function sentinelFailedPhase(it: DaxIteration | undefined): string | null {
  const err = it?.error;
  if (!err) return null;
  return DAX_SCRIPT_PHASE_NAMES.find((phase) => err.startsWith(`${phase}: `)) ?? null;
}

function medianDaxPhasesCompleted(iterations: DaxIteration[] | undefined): number {
  const values = (iterations ?? []).map((it) => {
    const raw = it.phasesCompleted ?? 0;
    return sentinelFailedPhase(it) ? Math.max(0, raw - 1) : raw;
  });
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function daxPhasesTotal(iterations: DaxIteration[] | undefined): number {
  return (
    (iterations ?? []).find((it) => it.phasesTotal != null)?.phasesTotal ?? DAX_PHASES_TOTAL
  );
}

function failedPhaseKey(it: DaxIteration | undefined): DaxPhaseKey | null {
  if (!it || !it.error) return null;
  if (sentinelFailedPhase(it)) return null;
  for (let i = DAX_PHASE_ORDER.length - 1; i >= 0; i--) {
    const key = DAX_PHASE_ORDER[i];
    if (it[key] != null) return key;
  }
  return null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function daxPhaseStats(
  iterations: DaxIteration[] | undefined,
  key: DaxPhaseKey,
): { median: number; p95: number; p99: number } {
  const scriptPhase = DAX_METRIC_TO_SCRIPT_PHASE[key];
  const valid = (iterations ?? [])
    .filter((it) => {
      const value = it[key];
      if (value == null) return false;
      if (key !== 'totalMs' && (value as number) > (it.totalMs ?? 0)) return false;
      if (scriptPhase && sentinelFailedPhase(it) === scriptPhase) return false;
      if (key !== 'totalMs' && failedPhaseKey(it) === key) return false;
      return true;
    })
    .map((it) => it[key] as number);
  if (valid.length === 0) return { median: 0, p95: 0, p99: 0 };
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median, p95: percentile(sorted, 95), p99: percentile(sorted, 99) };
}

function sanitizedDaxSummary(
  iterations: DaxIteration[] | undefined,
): Record<DaxPhaseKey, { median: number; p95: number; p99: number }> {
  const summary = {} as Record<DaxPhaseKey, { median: number; p95: number; p99: number }>;
  for (const key of DAX_PHASE_KEYS) {
    summary[key] = daxPhaseStats(iterations, key);
  }
  return summary;
}

interface TimeBasedMetrics {
  timeMs: number | null;
  complete: boolean;
  completionMetric: number;
  tiebreak: number;
}

function getTimeBasedMetrics(entry: ResultEntry): TimeBasedMetrics {
  if (BENCHMARK === 'sandbox-dax') {
    const iterations = entry.iterations as DaxIteration[] | undefined;
    const summary = sanitizedDaxSummary(iterations);
    const phasesCompleted = medianDaxPhasesCompleted(iterations);
    const phasesTotal = daxPhasesTotal(iterations);
    const timeMs = summary.totalMs.median;
    const complete = phasesCompleted >= phasesTotal && timeMs > 0;
    return {
      timeMs: complete ? timeMs : null,
      complete,
      completionMetric: phasesCompleted,
      tiebreak: entry.successRate ?? 0,
    };
  }

  const timeMs = getMedianTotalMs(entry);
  return {
    timeMs,
    complete: timeMs !== null,
    completionMetric: entry.successRate ?? 0,
    tiebreak: entry.successRate ?? 0,
  };
}

async function main() {
  const [resultsRaw, sponsors] = await Promise.all([
    BENCHMARK === 'storage'
      ? loadCombinedStorageResults()
      : loadResultFile(BENCHMARK),
    fetchSponsors(),
  ]);

  const parsedResults = resultsRaw.results.filter((entry) => !entry.skipped);
  const isTimeBased = TIME_BASED_BENCHMARKS.has(BENCHMARK);

  let baseProviders: Omit<Provider, 'rank'>[];

  if (isTimeBased) {
    const providerMetrics = parsedResults.map((entry) => ({
      entry,
      ...getTimeBasedMetrics(entry),
    }));

    const completeProviders = providerMetrics.filter(
      (p): p is typeof p & { timeMs: number } => p.complete && p.timeMs != null,
    );
    const incompleteProviders = providerMetrics.filter((p) => !p.complete);

    completeProviders.sort((a, b) => a.timeMs - b.timeMs);
    incompleteProviders.sort((a, b) => {
      const metricDiff = b.completionMetric - a.completionMetric;
      if (metricDiff !== 0) return metricDiff;
      const srDiff = b.tiebreak - a.tiebreak;
      if (srDiff !== 0) return srDiff;
      return a.entry.provider.localeCompare(b.entry.provider);
    });

    const allSorted = [...completeProviders, ...incompleteProviders];
    const timeValues = completeProviders.map((p) => p.timeMs);
    const minTime = timeValues.length > 0 ? Math.min(...timeValues) : 0;
    const maxTime = timeValues.length > 0 ? Math.max(...timeValues) : 0;

    baseProviders = allSorted.map(({ entry, timeMs, complete }) => ({
      provider: entry.provider,
      displayName: formatProviderName(entry.provider),
      score: complete ? normalizeTimeScore(timeMs as number, minTime, maxTime) : 0,
      displayValue: complete ? `${((timeMs as number) / 1000).toFixed(1)}s` : 'Failed',
      logoUrl: resolveProviderLogoUrl(entry.provider),
    }));
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
