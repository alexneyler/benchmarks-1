/**
 * Render HPC suite SVGs from each per-suite results/hpc_<suite>/latest.json
 * files written by pnpm run bench:hpc:<suite>.
 *
 * Two output shapes:
 *
 *   1. Per-suite SVG (hpc_<suite>.svg) -- a horizontal bar chart with
 *      one bar per provider, color = composite-score bucket (90+, 75+,
 *      50+, <50 -> green/green/amber/orange/grey). Bar labels show
 *      composite score and replicate counts.
 *
 *   2. Leaderboard grid (hpc_all.svg) -- a provider x suite matrix.
 *      Each cell is the composite score colored by bucket; a column on
 *      the right lists mean-of-suites per provider.
 *
 * Both shapes are intentionally pure SVG (no external libs); they render
 * identically on GitHub and the bench-hpc Artifact step.
 *
 * Implementation note: this file tries very hard to avoid template
 * strings inside multi-arg `parts.push(...)` calls because the TS-to-JS
 * transform that tsx uses (esbuild 0.28) has a parser quirk where a
 * backtick inside `push(...)` after a closing comma on the previous
 * line is sometimes mis-tokenized. Concatenation is verbose but
 * indubitably parses.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSuiteIds, getSuite } from './registry.js';
import type { HpcBenchmarkResult } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS_DIR = path.join(ROOT, 'results');
const OUT_DIR = ROOT; // SVGs check in at repo root, mirroring existing *_tti.svg

function readLatest(suiteId: string): HpcBenchmarkResult[] | null {
  const suiteDirSuffix = suiteId.replace(/-/g, '_');
  const resultsSuiteDir = 'hpc_' + suiteDirSuffix;
  const dir = path.join(RESULTS_DIR, resultsSuiteDir);
  const f = path.join(dir, 'latest.json');
  if (!fs.existsSync(f)) return null;
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (Array.isArray(data?.results)) return data.results;
  return null;
}

function color(score: number): string {
  if (score >= 90) return '#16a34a';
  if (score >= 75) return '#22c55e';
  if (score >= 50) return '#eab308';
  if (score > 0) return '#f97316';
  return '#9ca3af';
}

function escapeXml(s: string): string {
  return s.replace(/[&<>'"]/g, function (c) {
    const map: Record<string, string> = {
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;',
    };
    return map[c] || c;
  });
}

/**
 * Build a horizontal bar chart SVG for one suite, listing every
 * non-skipped provider as a row. Returns the SVG string; the caller
 * writes the file.
 */
export function generateSuiteSvg(suiteId: string): string {
  const suite = getSuite(suiteId as any);
  const results = (readLatest(suiteId) ?? []).filter(function (r) { return !r.skipped; });
  const visible = results.slice().sort(function (a, b) { return b.compositeScore - a.compositeScore; });
  const expected = results.length;

  const W = 760;
  const ROW = 30;
  const HEADER_H = 64;
  const FOOTER_H = 32;
  const H = HEADER_H + Math.max(1, visible.length) * ROW + FOOTER_H;

  const parts: string[] = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" font-family="system-ui,sans-serif">');
  parts.push('<rect width="100%" height="100%" fill="#f8fafc"/>');
  parts.push('<text x="20" y="28" font-size="16" font-weight="600" fill="#0f172a">HPC suite: ' + escapeXml(suiteId) + '</text>');
  parts.push('<text x="20" y="48" font-size="12" fill="#475569">replicates: ' + expected + '  method: throughput-after-boot (median, 2-sigma trim)</text>');

  if (visible.length === 0) {
    parts.push('<text x="20" y="' + (HEADER_H + 24) + '" font-size="13" fill="#475569">');
    parts.push('no results yet -- run  pnpm run bench:hpc:' + suiteId.replace(/-/g, '_') + '  first.');
    parts.push('</text>');
    parts.push('</svg>');
    return parts.join('\n');
  }

  const labelX = 20;
  const barX = 220;
  const barW = 440;
  for (let i = 0; i < visible.length; i++) {
    const y = HEADER_H + 8 + i * ROW;
    const r = visible[i];
    const w = Math.max(2, (r.compositeScore / 100) * barW);
    const sublabel = 'n=' + r.summary.n + ' ' + suite.unit + ' ceiling=' + suite.ceiling;
    parts.push('<text x="' + labelX + '" y="' + (y + 4) + '" font-size="13" fill="#1e293b">' + escapeXml(r.provider) + '</text>');
    parts.push('<rect x="' + barX + '" y="' + (y - 10) + '" width="' + barW + '" height="14" fill="#e2e8f0"/>');
    parts.push('<rect x="' + barX + '" y="' + (y - 10) + '" width="' + w + '" height="14" fill="' + color(r.compositeScore) + '"/>');
    parts.push('<text x="' + (barX + barW + 8) + '" y="' + (y + 4) + '" font-size="13" fill="#0f172a">' + r.compositeScore.toFixed(1) + '</text>');
    parts.push('<text x="' + labelX + '" y="' + (y + 18) + '" font-size="11" fill="#64748b">' + escapeXml(sublabel) + '</text>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * Build the cross-provider x cross-suite leaderboard grid. Layout:
 * rows = providers, columns = suites (ordered per registry's
 * getSuiteIds()). Each cell shows the composite score in a small box
 * colored by the same bucket palette as the per-suite charts. A
 * "mean" column on the right averages across suites that have data
 * (missing scores are skipped, not counted as zero).
 */
export function generateLeaderboardSvg(): string {
  const suiteIds = getSuiteIds();

  // Build provider -> suite -> result index.
  const cells = new Map<string, Map<string, HpcBenchmarkResult>>();
  const providers = new Set<string>();
  for (const suiteId of suiteIds) {
    const results = (readLatest(suiteId) ?? []).filter(function (r) { return !r.skipped; });
    for (const r of results) {
      providers.add(r.provider);
      if (!cells.has(r.provider)) cells.set(r.provider, new Map());
      cells.get(r.provider)!.set(suiteId, r);
    }
  }

  const provList = Array.from(providers).sort();
  if (provList.length === 0) {
    const empty: string[] = [];
    empty.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 96" font-family="system-ui,sans-serif">');
    empty.push('<rect width="100%" height="100%" fill="#f8fafc"/>');
    empty.push('<text x="20" y="44" font-size="14" fill="#475569">HPC leaderboard -- no per-suite results yet</text>');
    empty.push('</svg>');
    return empty.join('\n');
  }

  const cellW = 96;
  const cellH = 32;
  const leftLabelW = 160;
  const meanLabelW = 88;
  const headerH = 40;
  const topLabelH = 80;
  const rowH = cellH;
  const W = leftLabelW + suiteIds.length * cellW + meanLabelW + 20;
  const H = headerH + topLabelH + provList.length * rowH + 24;

  const parts: string[] = [];
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" font-family="system-ui,sans-serif">');
  parts.push('<rect width="100%" height="100%" fill="#f8fafc"/>');
  parts.push('<text x="20" y="22" font-size="16" font-weight="600" fill="#0f172a">HPC leaderboard -- throughput-after-boot composite</text>');
  parts.push('<text x="20" y="40" font-size="12" fill="#475569">nightly aggregate across ' + suiteIds.length + ' suites, ' + provList.length + ' provider' + (provList.length === 1 ? '' : 's') + '</text>');

  // Header row -- suite IDs rotated 30 degrees.
  parts.push('<g transform="translate(' + leftLabelW + ', ' + (headerH + topLabelH - 6) + ')">');
  parts.push('<text font-size="12" fill="#0f172a">suite</text>');
  parts.push('</g>');
  for (let i = 0; i < suiteIds.length; i++) {
    const x = leftLabelW + i * cellW + cellW / 2;
    const y = headerH + topLabelH - 6;
    parts.push('<text x="' + x + '" y="' + y + '" font-size="11" fill="#1e293b" text-anchor="start" transform="rotate(-30 ' + x + ' ' + y + ')">' + escapeXml(suiteIds[i]) + '</text>');
  }
  parts.push('<text x="' + (leftLabelW + suiteIds.length * cellW + 12) + '" y="' + (headerH + topLabelH - 6) + '" font-size="11" fill="#1e293b">mean</text>');

  // Body rows
  for (let p = 0; p < provList.length; p++) {
    const y = headerH + topLabelH + p * rowH;
    parts.push('<text x="16" y="' + (y + cellH / 2 + 4) + '" font-size="13" fill="#0f172a">' + escapeXml(provList[p]) + '</text>');

    let suiteTotal = 0;
    let suiteCount = 0;
    for (let i = 0; i < suiteIds.length; i++) {
      const x = leftLabelW + i * cellW;
      const r = cells.get(provList[p])?.get(suiteIds[i]);
      if (r) {
        suiteTotal += r.compositeScore;
        suiteCount++;
        parts.push('<rect x="' + x + '" y="' + y + '" width="' + (cellW - 4) + '" height="' + (cellH - 4) + '" fill="' + color(r.compositeScore) + '" rx="3"/>');
        parts.push('<text x="' + (x + (cellW - 4) / 2) + '" y="' + (y + (cellH - 4) / 2 + 4) + '" font-size="12" fill="#fff" text-anchor="middle">' + r.compositeScore.toFixed(0) + '</text>');
      } else {
        parts.push('<rect x="' + x + '" y="' + y + '" width="' + (cellW - 4) + '" height="' + (cellH - 4) + '" fill="#f1f5f9" rx="3"/>');
        parts.push('<text x="' + (x + (cellW - 4) / 2) + '" y="' + (y + (cellH - 4) / 2 + 4) + '" font-size="11" fill="#94a3b8" text-anchor="middle">.</text>');
      }
    }

    const mean = suiteCount > 0 ? suiteTotal / suiteCount : 0;
    const meanX = leftLabelW + suiteIds.length * cellW + 4;
    parts.push('<text x="' + (meanX + meanLabelW / 2) + '" y="' + (y + cellH / 2 + 4) + '" font-size="13" fill="#0f172a" text-anchor="middle">' + (mean > 0 ? mean.toFixed(1) : '--') + '</text>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function writeOne(name: string, contents: string): void {
  const target = path.join(OUT_DIR, name);
  fs.writeFileSync(target, contents);
  console.log('Wrote ' + name + ' (' + contents.length + ' bytes)');
}

function main(): void {
  const args = process.argv.slice(2);
  const onlySuite = args.find(function (a) { return a.startsWith('--suite='); })?.split('=')[1];
  const suiteIds = onlySuite ? [onlySuite] : getSuiteIds();

  for (const id of suiteIds) {
    const svg = generateSuiteSvg(id);
    const fileName = 'hpc_' + id.replace(/-/g, '_') + '.svg';
    writeOne(fileName, svg);
  }

  // Always (re-)generate the leaderboard alongside per-suite charts
  // unless the caller pinned a single suite.
  if (!onlySuite) {
    const svg = generateLeaderboardSvg();
    writeOne('hpc_all.svg', svg);
  }
}

if (process.argv[1] && process.argv[1].endsWith('generate-svg.ts')) {
  main();
}
