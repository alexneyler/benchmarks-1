import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/runner';
import type { JsonObject } from '@benchsdk/client';
import { byTaskIndex } from '../src/util/records.js';
import { computeStats } from '../src/util/stats.js';
import type { GitBenchmarkResult, GitTimingResult } from './types.js';

function num(x: unknown): number {
  return typeof x === 'number' ? x : 0;
}

/** Map CLI participant records to legacy GitBenchmarkResult[]. */
export function recordsToGitResults(participants: ParticipantRecords[]): GitBenchmarkResult[] {
  return participants.map((participant) => {
    const iterations: GitTimingResult[] = byTaskIndex(participant.records).map((r) => {
      const d = (r.data ?? {}) as JsonObject;
      const base: GitTimingResult = {
        cloneMs: num(d.cloneMs),
        branch: typeof d.branch === 'string' ? d.branch : '',
        commitSha: typeof d.commitSha === 'string' ? d.commitSha : undefined,
      };
      if (d.pushSkipped) {
        base.pushSkipped = true;
      } else if (typeof d.pushMs === 'number') {
        base.pushMs = d.pushMs;
      }
      if (d.pullSkipped) {
        base.pullSkipped = true;
      } else if (typeof d.pullMs === 'number') {
        base.pullMs = d.pullMs;
      }
      return r.status === 'error' ? { ...base, error: r.errorCode ?? 'error' } : base;
    });

    const successful = iterations.filter((i) => !i.error);
    const successfulPush = successful.filter((i) => !i.pushSkipped && typeof i.pushMs === 'number');
    const successfulPull = successful.filter((i) => !i.pullSkipped && typeof i.pullMs === 'number');
    const summary = {
      cloneMs: computeStats(successful.map((i) => i.cloneMs)),
      pushMs: computeStats(successfulPush.map((i) => i.pushMs as number)),
      pullMs: computeStats(successfulPull.map((i) => i.pullMs as number)),
    };

    return {
      provider: participant.participant,
      mode: 'git' as const,
      iterations,
      summary,
      successRate: iterations.length ? successful.length / iterations.length : 0,
    };
  });
}

export async function writeGitResultsJson(results: GitBenchmarkResult[], outPath: string): Promise<void> {
  const fs = await import('node:fs');
  const os = await import('node:os');

  const clean = results.map((r) => ({
    provider: r.provider,
    mode: r.mode,
    iterations: r.iterations.map((i) => {
      const entry: Record<string, unknown> = {
        cloneMs: i.cloneMs,
        branch: i.branch,
      };
      if (i.commitSha !== undefined) entry.commitSha = i.commitSha;
      if (i.pushSkipped) {
        entry.pushSkipped = true;
      } else if (i.pushMs !== undefined) {
        entry.pushMs = i.pushMs;
      }
      if (i.pullSkipped) {
        entry.pullSkipped = true;
      } else if (i.pullMs !== undefined) {
        entry.pullMs = i.pullMs;
      }
      if (i.error !== undefined) entry.error = i.error;
      return entry;
    }),
    summary: r.summary,
    ...(r.successRate !== undefined ? { successRate: r.successRate } : {}),
    ...(r.compositeScore !== undefined ? { compositeScore: r.compositeScore } : {}),
    ...(r.skipped ? { skipped: r.skipped, skipReason: r.skipReason } : {}),
  }));

  const output = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
    },
    config: {
      iterations: results[0]?.iterations.length || 0,
    },
    results: clean,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Results written to ${outPath}`);
}

/**
 * Map records -> GitBenchmarkResult[], compute success rates, and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeGitLegacyResults(
  participants: ParticipantRecords[],
  resultsDir: string,
): Promise<void> {
  const results = recordsToGitResults(participants);

  mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(resultsDir, `${timestamp}.json`);
  await writeGitResultsJson(results, outPath);

  const latestPath = path.join(resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
