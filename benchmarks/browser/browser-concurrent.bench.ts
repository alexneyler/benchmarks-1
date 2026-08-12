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
 *   bench run benchmarks/browser/browser-concurrent.bench.ts --concurrency-level 50 --iterations 3
 *   bench run benchmarks/browser/browser-concurrent.bench.ts --concurrency-level 1 --iterations 10
 *   bench run benchmarks/browser/browser-concurrent.bench.ts --provider browserbase --concurrency-level 25 --iterations 3
 *
 * Levels must be run against a provider one at a time. Running them
 * concurrently puts every level's sessions on the same provider account
 * simultaneously, which destroys the comparison the benchmark is making.
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
  ACTIONS_PER_SESSION,
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

/**
 * Pick the article for one session.
 *
 * Indexing by session rather than by round keeps the page mix comparable
 * across concurrency levels. Sharing a single URL per round would let a c50
 * round hit one CDN-warmed article with 50 sessions while a c1 round pays
 * cold-fetch cost on a different article every time, so page weight and cache
 * state would vary with the dimension under test.
 */
function navUrlForSession(roundIndex: number, sessionIndex: number): string {
  if (NAV_URLS.length === 0) return RANDOM_URL;
  return NAV_URLS[(roundIndex * concurrencyLevel + sessionIndex) % NAV_URLS.length];
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
    return { durationMs: performance.now() - start, success: false, error: errorMessage(err) };
  }
}

/**
 * Run the 10-action loop on a single page. Identical to the throughput
 * benchmark's loop but with LOOPS_PER_SESSION=1 (one loop = 10 actions).
 */
/** A session the provider actually handed back, with its own create latency. */
interface CreatedSession {
  sessionId: string;
  connectUrl: string;
  createMs: number;
}

/**
 * Not every provider SDK rejects with an Error: notte throws a plain object,
 * which `String()` flattens to "[object Object]" and discards the reason a
 * session was refused — the one thing a capacity failure needs to report.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const record = err as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      // Circular or non-serializable; fall through to String().
    }
  }
  return String(err);
}

/**
 * Distinct failure reasons with their counts. A capacity collapse is often
 * mixed — kernel refused sessions for both a concurrency cap and a rate limit
 * in the same round — so reporting only the first reason mis-attributes it.
 */
function reasonCounts(errors: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const error of errors) {
    const key = error.slice(0, 200);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

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
  const { participant, taskIndex, step, measure, log } = ctx;
  const timeout = participant.timeout ?? 120_000;
  const sessionCreateOptions = participant.sessionCreateOptions ?? {};

  const provider = await getProvider(participant);

  const totalStart = performance.now();
  let createMs = 0;
  let connectMs = 0;
  let taskMs = 0;
  let releaseMs = 0;
  let sessionsAlive = 0;
  let aggregateActionsPerSecond = 0;
  let createTimedOut = false;
  const sessionResults: SessionResult[] = [];
  let roundError: string | undefined;
  let harnessFailure = false;

  // Declared outside try so the finally block can close them.
  let browsers: Browser[] = [];
  let aliveSessions: CreatedSession[] = [];

  // Every session id the provider hands back, whether or not the round goes on
  // to use it. The finally block destroys all of them: releasing only the
  // sessions that reached the action phase leaks the rest, and leaked sessions
  // hold provider quota until their idle timeout, which corrupts later rounds.
  const createdSessionIds = new Set<string>();
  let cleanupComplete = false;

  const destroySession = (sessionId: string) =>
    withTimeout(
      Promise.resolve(provider.session.destroy(sessionId)),
      15_000,
      'Session destroy timed out',
    ).catch(() => {});

  /**
   * Start one session, recording its id as soon as the provider reports it.
   * A create that resolves after its timeout still produces a live session, so
   * it is destroyed on arrival once cleanup has already run.
   */
  const createTrackedSession = (): Promise<CreatedSession> => {
    const started = performance.now();
    const underlying = Promise.resolve(
      provider.session.create(sessionCreateOptions),
    ) as Promise<{ sessionId: string; connectUrl: string }>;

    void underlying.then(
      (session) => {
        if (!session?.sessionId) return;
        createdSessionIds.add(session.sessionId);
        if (cleanupComplete) void destroySession(session.sessionId);
      },
      () => {},
    );

    return withTimeout(underlying, timeout, 'Session creation timed out').then(session => ({
      ...session,
      createMs: performance.now() - started,
    }));
  };

  try {
    // ── Phase 1: Create all N sessions in parallel ──────────────────────────
    const createStart = performance.now();
    const createResults = await step('create-all', () =>
      Promise.allSettled(Array.from({ length: concurrencyLevel }, () => createTrackedSession())),
    );
    createMs = performance.now() - createStart;

    aliveSessions = [];
    const createErrors: string[] = [];
    for (const result of createResults) {
      if (result.status === 'fulfilled') {
        aliveSessions.push(result.value);
        continue;
      }
      // Keep the provider's own message: it is the only way to tell a quota
      // rejection from a rate limit, an auth failure, or a timeout.
      const reason = errorMessage(result.reason);
      createErrors.push(reason);
      if (/timed out/i.test(reason)) createTimedOut = true;
      sessionResults.push({
        sessionId: '',
        createMs: 0,
        connectMs: 0,
        taskMs: 0,
        actionsCompleted: 0,
        actionsPerSecond: 0,
        actions: [],
        error: reason,
      });
    }

    log(
      `c${concurrencyLevel} round ${taskIndex} create-all: ${aliveSessions.length}/${concurrencyLevel} created in ${Math.round(createMs)}ms`,
      {
        concurrencyLevel,
        created: aliveSessions.length,
        refused: createErrors.length,
        createMs: Math.round(createMs),
        ...(createErrors.length > 0 ? { reasons: reasonCounts(createErrors) } : {}),
      },
    );

    if (aliveSessions.length === 0) {
      // A provider refusing every session is a result, not a harness fault.
      // Throwing would lose this round's per-session errors, because the
      // client records only an error message and drops the task's data.
      roundError = 'All session creations failed';
    }

    // ── Phase 2: CDP-connect all sessions in parallel ───────────────────────
    const pages: Page[] = [];
    const connectedSessions: CreatedSession[] = [];
    const connectedConnectMs: number[] = [];
    const connectErrors: string[] = [];

    if (aliveSessions.length > 0) {
      const connectStart = performance.now();
      const connectResults = await step('connect-all', () =>
        Promise.allSettled(
          aliveSessions.map(async (s) => {
            const started = performance.now();
            const browser = await withTimeout(
              chromium.connectOverCDP(s.connectUrl),
              30_000,
              'CDP connection timed out',
            );
            return { browser, connectMs: performance.now() - started };
          }),
        ),
      );
      connectMs = performance.now() - connectStart;

      for (let i = 0; i < connectResults.length; i++) {
        const result = connectResults[i];
        const session = aliveSessions[i];

        if (result.status === 'rejected') {
          connectErrors.push(errorMessage(result.reason));
          sessionResults.push({
            sessionId: session.sessionId,
            createMs: session.createMs,
            connectMs: 0,
            taskMs: 0,
            actionsCompleted: 0,
            actionsPerSecond: 0,
            actions: [],
            error: errorMessage(result.reason),
          });
          continue;
        }

        const { browser, connectMs: sessionConnectMs } = result.value;
        browsers.push(browser);
        const [context] = browser.contexts();
        const page = context ? context.pages()[0] ?? (await context.newPage()) : undefined;

        if (!page) {
          connectErrors.push('No default browser context found');
          sessionResults.push({
            sessionId: session.sessionId,
            createMs: session.createMs,
            connectMs: sessionConnectMs,
            taskMs: 0,
            actionsCompleted: 0,
            actionsPerSecond: 0,
            actions: [],
            error: 'No default browser context found',
          });
          continue;
        }

        pages.push(page);
        connectedSessions.push(session);
        connectedConnectMs.push(sessionConnectMs);
      }

      sessionsAlive = pages.length;
      log(
        `c${concurrencyLevel} round ${taskIndex} connect-all: ${pages.length}/${aliveSessions.length} connected in ${Math.round(connectMs)}ms`,
        {
          concurrencyLevel,
          connected: pages.length,
          failed: connectErrors.length,
          connectMs: Math.round(connectMs),
          ...(connectErrors.length > 0 ? { reasons: reasonCounts(connectErrors) } : {}),
        },
      );
      if (pages.length === 0) roundError ??= 'All CDP connections failed';
    }

    // ─── BARRIER: all surviving sessions are alive + connected ──────────────

    // ── Phase 3: Run 10-action loop on all sessions simultaneously ──────────
    if (pages.length > 0) {
      // runActionLoop pushes to a passed array, so we create one per page.
      const actionArrays: ActionResult[][] = pages.map(() => []);
      const actionStart = performance.now();
      const loopResults = await step('actions-all', () =>
        Promise.allSettled(
          pages.map((page, i) =>
            runActionLoop(page, actionArrays[i], navUrlForSession(taskIndex, i)),
          ),
        ),
      );
      taskMs = performance.now() - actionStart;

      let totalActionsCompleted = 0;
      for (let i = 0; i < loopResults.length; i++) {
        const result = loopResults[i];
        const session = connectedSessions[i];
        // Actions completed before a mid-loop throw are still measurements.
        const actions = actionArrays[i];
        const actionsCompleted = actions.filter(a => a.success).length;
        const sessionTaskMs = actions.reduce((sum, a) => sum + a.durationMs, 0);
        totalActionsCompleted += actionsCompleted;
        sessionResults.push({
          sessionId: session?.sessionId ?? '',
          createMs: session?.createMs ?? 0,
          connectMs: connectedConnectMs[i] ?? 0,
          taskMs: sessionTaskMs,
          actionsCompleted,
          actionsPerSecond: sessionTaskMs > 0 ? actionsCompleted / (sessionTaskMs / 1000) : 0,
          actions,
          ...(result.status === 'rejected' ? { error: errorMessage(result.reason) } : {}),
        });
      }

      aggregateActionsPerSecond = taskMs > 0 ? totalActionsCompleted / (taskMs / 1000) : 0;
    }

    measure({ aggregateActionsPerSecond, sessionsAlive, sessionsAttempted: concurrencyLevel });
  } catch (err) {
    roundError = errorMessage(err);
    harnessFailure = true;
  } finally {
    // Close all CDP browser connections
    await Promise.allSettled(browsers.map(b => b.close().catch(() => {})));

    // ── Phase 4: Release every session the provider created ─────────────────
    // Runs in `finally` so a round that fails after creating sessions still
    // releases them instead of holding provider quota until idle timeout.
    const releaseStart = performance.now();
    const releaseAll = () => Promise.allSettled([...createdSessionIds].map(destroySession));
    if (harnessFailure) {
      await releaseAll();
    } else {
      await step('release-all', releaseAll, { reportConcurrency: false });
    }
    releaseMs = performance.now() - releaseStart;
    cleanupComplete = true;
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
    ...(createTimedOut ? { createTimedOut } : {}),
    ...(sessionsAlive === 0 ? { roundFailed: true } : {}),
    ...(roundError ? { errorMessage: roundError } : {}),
  };

  // Logged before the throw below so a harness failure still reports what the
  // round achieved, not just that it died.
  const actionsCompleted = sessionResults.reduce((sum, s) => sum + s.actionsCompleted, 0);
  log(
    `c${concurrencyLevel} round ${taskIndex} complete: ${sessionsAlive}/${concurrencyLevel} sessions, ` +
      `${actionsCompleted}/${concurrencyLevel * ACTIONS_PER_SESSION} actions in ${Math.round(totalMs)}ms`,
    {
      concurrencyLevel,
      sessionsAlive,
      actionsCompleted,
      aggregateActionsPerSecond: Math.round(aggregateActionsPerSecond * 100) / 100,
      createMs: Math.round(createMs),
      connectMs: Math.round(connectMs),
      taskMs: Math.round(taskMs),
      releaseMs: Math.round(releaseMs),
      totalMs: Math.round(totalMs),
      ...(roundError ? { roundError } : {}),
    },
  );

  // Only unexpected exceptions throw. A provider refusing sessions is data the
  // benchmark exists to collect, and throwing would discard it: the client
  // records an error message and drops the task's data payload entirely.
  if (harnessFailure) {
    throw new TaskError(roundError ?? 'Round failed', { code: 'CONCURRENT_ERROR', data });
  }

  return { data };
});
