#!/usr/bin/env node
/**
 * claude-code-rlm — metrics log parser & aggregator (Phase 5, Unit 2)
 *
 * Reads the JSONL metrics log written by rlm-hook.mjs (`appendMetric`) and
 * aggregates it into per-UTC-day stats: total events, hit rate, skip rate
 * (+ per-reason breakdown), error rate, and latency P50/P95/P99.
 *
 * Dependency-free — Node built-ins only.
 *
 * The pure functions (`parseLog`, `aggregate`, `percentile`, `summarize`) take
 * data in and return data out — no FS, no clock — so they're unit-testable on
 * inline records. `readLog` is the only FS touch; the CLI entry is guarded by
 * `import.meta.url` so importing this module has NO side effects.
 *
 * Usage:
 *   node bench/parse-log.mjs                 # default log, human summary
 *   node bench/parse-log.mjs <path>          # explicit log path
 *   node bench/parse-log.mjs --json          # emit aggregate as JSON
 *   RLM_METRICS_FILE=/path node bench/parse-log.mjs
 *
 * Event taxonomy (from Unit 1): skip, cache_hit (source: sha|semantic),
 * context_reuse, haiku_skip, complete, error. The canonical hit flag is the
 * boolean `cache_hit` field (true for cache_hit + context_reuse), NOT the event
 * name — hit rate is computed off the boolean.
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

// ---------------------------------------------------------------------------
// Pure aggregation core (no FS, no clock — directly importable for tests)
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile over a list of numbers.
 *
 * @param {number[]} values  raw (unsorted ok; non-finite entries are dropped)
 * @param {number}   p       percentile in [0, 100]
 * @returns {number|null}    the value at the nearest rank, or null for empty input
 *
 * Convention: nearest-rank on the ascending-sorted array. For N values and
 * percentile p, rank = ceil((p/100) * N) (clamped to [1, N]); the result is the
 * value at index rank-1. Empty input → null (documented; the dashboard renders
 * null as "—").
 */
export function percentile(values, p) {
  const xs = (Array.isArray(values) ? values : [])
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = Math.ceil((p / 100) * xs.length);
  const idx = Math.min(Math.max(rank, 1), xs.length) - 1;
  return xs[idx];
}

/**
 * Summarize a flat list of metric records into a single stat block.
 * Used for both per-day buckets and the overall rollup.
 *
 * @param {object[]} records
 * @returns {object} { total, hits, hit_rate, skips, skip_rate, skip_reasons,
 *                     errors, error_rate, events, modes, latency }
 */
export function summarize(records) {
  const list = Array.isArray(records) ? records : [];
  const total = list.length;
  let hits = 0;
  let skips = 0;
  let errors = 0;
  const skip_reasons = {};
  const events = {};
  const modes = {};
  const latencies = [];

  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    if (r.cache_hit === true) hits++;
    if (r.event === 'skip') {
      skips++;
      const reason = r.reason != null ? String(r.reason) : 'unknown';
      skip_reasons[reason] = (skip_reasons[reason] || 0) + 1;
    }
    if (r.event === 'error') errors++;
    if (r.event != null) {
      const e = String(r.event);
      events[e] = (events[e] || 0) + 1;
    }
    if (r.mode != null) {
      const m = String(r.mode);
      modes[m] = (modes[m] || 0) + 1;
    }
    if (typeof r.latency_ms === 'number' && Number.isFinite(r.latency_ms)) {
      latencies.push(r.latency_ms);
    }
  }

  return {
    total,
    hits,
    hit_rate: total ? hits / total : 0,
    skips,
    skip_rate: total ? skips / total : 0,
    skip_reasons,
    errors,
    error_rate: total ? errors / total : 0,
    events,
    modes,
    latency: {
      count: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      min: latencies.length ? Math.min(...latencies) : null,
      max: latencies.length ? Math.max(...latencies) : null,
    },
  };
}

/**
 * Aggregate metric records per UTC day plus an overall rollup.
 *
 * Records are bucketed by `new Date(ts).toISOString().slice(0, 10)`. Records
 * without a finite numeric `ts` cannot be bucketed and are DROPPED from both the
 * per-day buckets and the overall rollup (the hook always stamps `ts` at write
 * time, so a missing/invalid ts means a corrupt line — already filtered by
 * parseLog for unparseable lines, but a structurally-valid line could still lack
 * ts). Non-object entries are ignored.
 *
 * @param {object[]} records
 * @returns {{ days: object[], overall: object }}
 *          days: stat blocks (each prefixed with `day`), sorted ascending by day.
 *          overall: a single rollup over every bucketed record, with day: 'all'.
 */
export function aggregate(records) {
  const list = Array.isArray(records) ? records : [];
  const byDay = new Map();
  const valid = [];

  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const ts = r.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue;
    let dayKey;
    try {
      dayKey = new Date(ts).toISOString().slice(0, 10);
    } catch {
      continue;
    }
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(r);
    valid.push(r);
  }

  const days = [...byDay.keys()]
    .sort()
    .map((day) => ({ day, ...summarize(byDay.get(day)) }));

  return { days, overall: { day: 'all', ...summarize(valid) } };
}

/**
 * Parse JSONL text into an array of metric records.
 * Blank lines are skipped; unparseable lines are skipped (never throws).
 * Only object roots are kept (arrays/scalars dropped).
 *
 * @param {string} text
 * @returns {object[]}
 */
export function parseLog(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) records.push(rec);
    } catch {
      // skip unparseable line — a corrupt entry must not abort the whole parse
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// FS + CLI (side-effecting; only the CLI entry runs on direct invocation)
// ---------------------------------------------------------------------------

/** Expand a leading `~` to the user's home directory. */
function expandTilde(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Default metrics log path — mirrors rlm-hook.mjs CONFIG.metricsFile. */
export function defaultLogPath() {
  return (
    expandTilde(process.env.RLM_METRICS_FILE) ||
    join(homedir(), '.local', 'share', 'rlm-hook', 'metrics.jsonl')
  );
}

/** Read a log file, returning '' if it is missing/unreadable (never throws). */
export async function readLog(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

function pct(n) {
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`;
}

function num(n) {
  return n == null ? '—' : String(n);
}

function renderHuman(agg, logPath) {
  const lines = [];
  lines.push(`RLM metrics — ${logPath}`);
  lines.push('='.repeat(60));
  const o = agg.overall;
  lines.push(
    `Overall: ${o.total} events | hit ${pct(o.hit_rate)} | skip ${pct(
      o.skip_rate
    )} | err ${pct(o.error_rate)} | p50 ${num(o.latency.p50)}ms p95 ${num(
      o.latency.p95
    )}ms p99 ${num(o.latency.p99)}ms`
  );
  lines.push('');
  lines.push(
    `${'day'.padEnd(12)}${'evts'.padStart(6)}${'hit%'.padStart(8)}${'skip%'.padStart(
      8
    )}${'err%'.padStart(8)}${'p50'.padStart(8)}${'p95'.padStart(8)}${'p99'.padStart(8)}`
  );
  for (const d of agg.days) {
    lines.push(
      `${d.day.padEnd(12)}${String(d.total).padStart(6)}${pct(d.hit_rate).padStart(
        8
      )}${pct(d.skip_rate).padStart(8)}${pct(d.error_rate).padStart(8)}${num(
        d.latency.p50
      ).padStart(8)}${num(d.latency.p95).padStart(8)}${num(d.latency.p99).padStart(8)}`
    );
  }
  return lines.join('\n');
}

async function main(argv) {
  const args = argv.slice(2);
  const wantJson = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const logPath = positional[0] ? expandTilde(positional[0]) : defaultLogPath();

  const text = await readLog(logPath);
  const records = parseLog(text);
  const agg = aggregate(records);

  if (wantJson) {
    console.log(JSON.stringify(agg, null, 2));
  } else {
    console.log(renderHuman(agg, logPath));
  }
}

// Run only when invoked directly (not on import) — keeps tests side-effect-free.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv);
}
