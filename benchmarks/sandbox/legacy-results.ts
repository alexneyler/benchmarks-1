import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import type { ParticipantRecords } from '@benchsdk/cli';
import { computeStats } from '../src/util/stats.js';
import { computeCompositeScores } from './scoring.js';
import { writeResultsJson } from './table.js';
import type { BenchmarkResult, BenchmarkMode } from './types.js';

/** Map CLI participant records to legacy sandbox BenchmarkResult[] (TTI domain). */
export function recordsToSandboxResults(
  participants: ParticipantRecords[],
  mode?: BenchmarkMode,
): BenchmarkResult[] {
  return participants.map((participant) => {
    const iterations = participant.records.map((r) => {
      const ttiMs = typeof r.data?.ttiMs === 'number' ? r.data.ttiMs : 0;
      return r.status === 'error'
        ? { ttiMs, error: r.errorCode ?? 'error' }
        : { ttiMs };
    });
    const successful = iterations.filter((i) => !i.error);
    const summary = {
      ttiMs:
        successful.length > 0
          ? computeStats(successful.map((i) => i.ttiMs))
          : { median: 0, p95: 0, p99: 0 },
    };
    return {
      provider: participant.participant,
      iterations,
      summary,
      ...(mode ? { mode } : {}),
    };
  });
}

/**
 * Map records -> BenchmarkResult[], compute composite scores, and write both
 * `<YYYY-MM-DD>.json` and `latest.json` into resultsDir.
 * TEMPORARY BRIDGE until the platform read API exposes per-iteration data.
 */
export async function writeSandboxLegacyResults(
  participants: ParticipantRecords[],
  opts: { resultsDir: string; mode?: BenchmarkMode },
): Promise<void> {
  const results = recordsToSandboxResults(participants, opts.mode);
  computeCompositeScores(results);

  mkdirSync(opts.resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(opts.resultsDir, `${timestamp}.json`);
  await writeResultsJson(results, outPath);

  const latestPath = path.join(opts.resultsDir, 'latest.json');
  copyFileSync(outPath, latestPath);
  console.log(`Copied latest: ${latestPath}`);
}
