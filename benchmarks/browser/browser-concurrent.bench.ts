/**
 * Browser concurrent sessions benchmark: each round creates N browser sessions
 * in parallel, waits for all to be alive + connected (barrier), runs a fixed
 * 10-action loop on every session simultaneously, then releases all.
 *
 * The custom `--concurrency-level` flag (parsed from argv, like storage's
 * `--file-size`) controls N — the number of sessions active at the same time.
 * The runner's `--iterations` controls how many barrier rounds execute.
 *
 * Results are organized by concurrency level, mirroring the storage
 * benchmark's per-file-size directories:
 *   results/browser-concurrent/c1/, c5/, c10/, c25/, c50/
 *
 *   bench run benchmarks/browser/browser-concurrent.bench.ts --concurrency-level 50 --iterations 1
 *   bench run benchmarks/browser/browser-concurrent.bench.ts --concurrency-level 1 --iterations 50
 *   bench run benchmarks/browser/browser-concurrent.bench.ts --provider browserbase --concurrency-level 25 --iterations 2
 */
import '../src/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { defineBenchmarkConfig, defineTask, TaskError } from '@benchsdk/runner';
import type { JsonValue } from '@benchsdk/client';
import { withTimeout } from '../src/util/timeout.js';
import { throughputProviders } from './throughput-providers.js';
import { writeConcurrentLegacyResults } from './concurrent-legacy-results.js';
import {
  ACTIONS_PER_LOOP,
  LOOPS_PER_SESSION,
  type ActionResult,
  type SessionResult,
  type ConcurrentProviderConfig,
} from './concurrent-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Custom CLI flag: --concurrency-level (runner ignores unknown flags) ──────
const args = process.argv.slice(2);
function getArgValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}
const concurrencyLevel = parseInt(getArgValue(args, '--concurrency-level') ?? '50', 10);
if (!Number.isFinite(concurrencyLevel) || concurrencyLevel < 1) {
  console.error(`Invalid --concurrency-level "${getArgValue(args, '--concurrency-level')}". Must be a positive integer.`);
  process.exit(1);
}

const concurrentTimeoutMs =
  throughputProviders.reduce((max, p) => Math.max(max, p.timeout ?? 120_000), 0) || 120_000;

export const config = defineBenchmarkConfig({
  benchmarkSlug: 'browser-concurrent-local',
  benchmarkName: 'Browser Concurrent (local)',
  benchmarkKind: 'browser',
  iterations: 1,
  concurrency: 1,
  participants: throughputProviders,
  onComplete: (outcome) =>
    writeConcurrentLegacyResults(outcome.participants, {
      resultsDir: path.resolve(__dirname, `../../results/browser-concurrent/c${concurrencyLevel}`),
      concurrencyLevel,
      timeoutMs: concurrentTimeoutMs,
    }),
});

// ── Wikipedia action loop (same as throughput benchmark, 1 loop = 10 actions) ─
const RANDOM_URL = 'https://en.wikipedia.org/wiki/Special:Random';
const FIRST_HEADING = '#firstHeading';
const ARTICLE_LINK_SELECTOR = '#mw-content-text a[href*="/wiki/"]';
const ACTION_TIMEOUT_MS = 30_000;

const NAV_URLS: string[] = parseNavUrls();

function parseNavUrls(): string[] {
  const raw = process.env.THROUGHPUT_URLS?.trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((u): u is string => typeof u === 'string' && u.length > 0);
    } catch {
      // fall through
    }
  }
  return raw.split(/\s+/).filter(u => u.length > 0);
}

function navUrlForRound(roundIndex: number): string {
  if (NAV_URLS.length > 0) return NAV_URLS[roundIndex % NAV_URLS.length];
  return RANDOM_URL;
}

function isArticleLink(href: string | null): boolean {
  if (!href) return false;
  const match = href.match(/\/wiki\/([^#]*)/);
  if (!match) return false;
  return !match[1].includes(':');
}

async function timeAction<T>(
  fn: () => Promise<T>,
): Promise<{ durationMs: number; success: boolean; error?: string; value?: T }> {
  const start = performance.now();
  try {
    const value = await withTimeout(fn(), ACTION_TIMEOUT_MS, 'Action timed out');
    return { durationMs: performance.now() - start, success: true, value };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { durationMs: performance.now() - start, success: false, error };
  }
}

/**
 * Run the 10-action loop on a single page. Identical to the throughput
 * benchmark's loop but with LOOPS_PER_SESSION=1 (one loop = 10 actions).
 */
async function runActionLoop(page: Page, results: ActionResult[], navigateUrl: string): Promise<void> {
  for (let loop = 0; loop < LOOPS_PER_SESSION; loop++) {
    const baseIdx = loop * ACTIONS_PER_LOOP;

    // 1. Navigate
    {
      const r = await timeAction(() =>
        page.goto(navigateUrl, { waitUntil: 'load' }) as Promise<unknown>,
      );
      results.push({ index: baseIdx + 1, type: 'navigate', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 2. Wait for #firstHeading
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 2, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 3. Screenshot
    {
      const r = await timeAction(() => page.screenshot());
      results.push({ index: baseIdx + 3, type: 'screenshot', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 4. Read text content of #firstHeading
    {
      const r = await timeAction(() => page.textContent(FIRST_HEADING));
      results.push({ index: baseIdx + 4, type: 'textContent', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 5. Click first article link
    let clickSucceeded = false;
    {
      const r = await timeAction(async () => {
        await page.waitForSelector(ARTICLE_LINK_SELECTOR, { timeout: 10_000 });
        const links = await page.$$(ARTICLE_LINK_SELECTOR);
        for (const link of links) {
          const href = await link.getAttribute('href');
          if (isArticleLink(href)) {
            await link.click();
            return;
          }
        }
        throw new Error('No article body link found on page');
      });
      clickSucceeded = r.success;
      results.push({ index: baseIdx + 5, type: 'click', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    if (!clickSucceeded) {
      for (const idx of [6, 7, 8, 9, 10]) {
        results.push({
          index: baseIdx + idx,
          type: idx <= 8 ? (idx === 6 || idx === 10 ? 'waitForSelector' : idx === 7 ? 'screenshot' : 'textContent') : 'goBack',
          durationMs: 0,
          success: false,
          error: 'skipped: click failed',
        });
      }
      continue;
    }

    // 6. Wait for #firstHeading on the new page
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 6, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 7. Screenshot the new page
    {
      const r = await timeAction(() => page.screenshot());
      results.push({ index: baseIdx + 7, type: 'screenshot', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 8. Read text content of #firstHeading on the new page
    {
      const r = await timeAction(() => page.textContent(FIRST_HEADING));
      results.push({ index: baseIdx + 8, type: 'textContent', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 9. Go back (waitUntil: 'commit' for bfcache compatibility)
    {
      const r = await timeAction(() => page.goBack({ waitUntil: 'commit' }) as Promise<unknown>);
      results.push({ index: baseIdx + 9, type: 'goBack', durationMs: r.durationMs, success: r.success, error: r.error });
    }

    // 10. Wait for #firstHeading on the previous page
    {
      const r = await timeAction(() => page.waitForSelector(FIRST_HEADING));
      results.push({ index: baseIdx + 10, type: 'waitForSelector', durationMs: r.durationMs, success: r.success, error: r.error });
    }
  }
}

// ── Provider cache (thread-safe lazy init) ───────────────────────────────────
const providerCache = new Map<string, any>();
const providerInitPromises = new Map<string, Promise<any>>();

async function getProvider(participant: ConcurrentProviderConfig): Promise<any> {
  const cached = providerCache.get(participant.name);
  if (cached) return cached;

  let initPromise = providerInitPromises.get(participant.name);
  if (!initPromise) {
    initPromise = Promise.resolve(participant.createBrowserProvider());
    providerInitPromises.set(participant.name, initPromise);
  }
  const provider = await initPromise;
  providerCache.set(participant.name, provider);
  return provider;
}

// ── Barrier-protocol task ────────────────────────────────────────────────────
export const task = defineTask<ConcurrentProviderConfig>(async (ctx) => {
  const { participant, taskIndex, step, measure } = ctx;
  const timeout = participant.timeout ?? 120_000;
  const sessionCreateOptions = participant.sessionCreateOptions ?? {};

  const provider = await getProvider(participant);
  const navigateUrl = navUrlForRound(taskIndex);

  const totalStart = performance.now();
  let createMs = 0;
  let connectMs = 0;
  let taskMs = 0;
  let releaseMs = 0;
  let sessionsAlive = 0;
  let aggregateActionsPerSecond = 0;
  const sessionResults: SessionResult[] = [];
  let roundError: string | undefined;

  // Declared outside try so the finally block can close them.
  let browsers: Browser[] = [];
  let aliveSessions: { sessionId: string; connectUrl: string }[] = [];

  try {
    // ── Phase 1: Create all N sessions in parallel ──────────────────────────
    const createStart = performance.now();
    const createResults = await step('create-all', () =>
      Promise.allSettled(
        Array.from({ length: concurrencyLevel }, () =>
          withTimeout(
            provider.session.create(sessionCreateOptions),
            timeout,
            'Session creation timed out',
          ),
        ),
      ),
    );
    createMs = performance.now() - createStart;

    aliveSessions = createResults
      .filter((r): r is PromiseFulfilledResult<{ sessionId: string; connectUrl: string }> => r.status === 'fulfilled')
      .map(r => r.value);

    const failedCreates = createResults.length - aliveSessions.length;

    // Record failed sessions
    for (let i = 0; i < failedCreates; i++) {
      sessionResults.push({
        sessionId: '',
        createMs: 0,
        connectMs: 0,
        taskMs: 0,
        actionsCompleted: 0,
        actionsPerSecond: 0,
        actions: [],
        error: 'Session creation failed',
      });
    }

    if (aliveSessions.length === 0) {
      throw new Error('All session creations failed');
    }

    // ── Phase 2: CDP-connect all sessions in parallel ───────────────────────
    const connectStart = performance.now();
    const connectResults = await step('connect-all', () =>
      Promise.allSettled(
        aliveSessions.map(s =>
          withTimeout(chromium.connectOverCDP(s.connectUrl), 30_000, 'CDP connection timed out'),
        ),
      ),
    );
    connectMs = performance.now() - connectStart;

    const pages: Page[] = [];
    const connectedSessionIds: string[] = [];

    for (let i = 0; i < connectResults.length; i++) {
      const result = connectResults[i];
      const session = aliveSessions[i];
      if (result.status === 'fulfilled') {
        const browser = result.value;
        browsers.push(browser);
        const [context] = browser.contexts();
        if (!context) throw new Error('No default browser context found');
        const [existingPage] = context.pages();
        const page = existingPage ?? (await context.newPage());
        pages.push(page);
        connectedSessionIds.push(session.sessionId);
      } else {
        sessionResults.push({
          sessionId: session.sessionId,
          createMs: 0,
          connectMs: 0,
          taskMs: 0,
          actionsCompleted: 0,
          actionsPerSecond: 0,
          actions: [],
          error: 'CDP connection failed',
        });
      }
    }

    sessionsAlive = pages.length;

    if (pages.length === 0) {
      throw new Error('All CDP connections failed');
    }

    // ─── BARRIER: all surviving sessions are alive + connected ──────────────

    // ── Phase 3: Run 10-action loop on all sessions simultaneously ──────────
    // runActionLoop pushes to a passed array, so we create one per page.
    const actionArrays: ActionResult[][] = pages.map(() => []);
    const actionStart = performance.now();
    const loopResults = await step('actions-all', () =>
      Promise.allSettled(
        pages.map((page, i) => runActionLoop(page, actionArrays[i], navigateUrl)),
      ),
    );
    taskMs = performance.now() - actionStart;

    // Collect per-session results
    let totalActionsCompleted = 0;
    for (let i = 0; i < loopResults.length; i++) {
      const result = loopResults[i];
      if (result.status === 'fulfilled') {
        const actions = actionArrays[i];
        const actionsCompleted = actions.filter(a => a.success).length;
        const sessionTaskMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
        const sessionAps = sessionTaskMs > 0 ? actionsCompleted / (sessionTaskMs / 1000) : 0;
        totalActionsCompleted += actionsCompleted;
        sessionResults.push({
          sessionId: connectedSessionIds[i],
          createMs: 0,
          connectMs: 0,
          taskMs: sessionTaskMs,
          actionsCompleted,
          actionsPerSecond: sessionAps,
          actions,
        });
      } else {
        sessionResults.push({
          sessionId: connectedSessionIds[i] ?? '',
          createMs: 0,
          connectMs: 0,
          taskMs: 0,
          actionsCompleted: 0,
          actionsPerSecond: 0,
          actions: [],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    aggregateActionsPerSecond = taskMs > 0 ? totalActionsCompleted / (taskMs / 1000) : 0;
    measure({ aggregateActionsPerSecond, sessionsAlive, sessionsAttempted: concurrencyLevel });

    // ── Phase 4: Release all sessions in parallel ────────────────────────────
    const releaseStart = performance.now();
    await step(
      'release-all',
      () =>
        Promise.allSettled(
          aliveSessions.map(s =>
            withTimeout(
              provider.session.destroy(s.sessionId),
              15_000,
              'Session destroy timed out',
            ).catch(() => {}),
          ),
        ),
      { reportConcurrency: false },
    );
    releaseMs = performance.now() - releaseStart;
  } catch (err) {
    roundError = err instanceof Error ? err.message : String(err);
  } finally {
    // Close all CDP browser connections
    await Promise.allSettled(browsers.map(b => b.close().catch(() => {})));
  }

  const totalMs = performance.now() - totalStart;

  const data = {
    concurrencyLevel,
    sessionsAttempted: concurrencyLevel,
    sessionsAlive,
    createMs,
    connectMs,
    taskMs,
    releaseMs,
    totalMs,
    aggregateActionsPerSecond,
    sessions: sessionResults as unknown as JsonValue,
    ...(roundError ? { errorMessage: roundError } : {}),
  };

  if (roundError) {
    throw new TaskError(roundError, { code: 'CONCURRENT_ERROR', data });
  }

  return { data };
});
