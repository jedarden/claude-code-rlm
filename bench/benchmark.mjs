#!/usr/bin/env node
/**
 * claude-code-rlm benchmark suite
 *
 * Measures non-LLM deterministic logic:
 *   Suite 1: Skip Detection Accuracy   (skip-cases.json)
 *   Suite 2: Parse Robustness          (parse-cases.json)
 *   Suite 3: Cache Performance         (file I/O throughput + TTL correctness)
 *   Suite 4: Throughput                (pure-JS skip detection ops/sec)
 *
 * Publicly reproducible — runs without claude CLI installed.
 *
 * Usage:
 *   node bench/benchmark.mjs
 *   node bench/benchmark.mjs --update-baseline
 *   node bench/benchmark.mjs --compare
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { tmpdir } from 'os';
import { createHash, randomBytes } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BENCH_DIR = __dirname;
const FIXTURES_DIR = join(BENCH_DIR, 'fixtures');
const RESULTS_DIR = join(BENCH_DIR, 'results');
const VERSION = '0.1.0';

const args = process.argv.slice(2);
const UPDATE_BASELINE = args.includes('--update-baseline');
const COMPARE = args.includes('--compare');

// ─── INLINED SKIP DETECTION (mirrors shouldSkipRLM in rlm-hook.mjs) ──────────
//
// These constants and the shouldSkip() function are faithful copies of the
// production logic so the benchmark exercises the real algorithm.

const MIN_INPUT_LENGTH = 20;

const SIMPLE_PATTERNS = [
  /^(ls|cd|pwd|cat|echo|git status|npm|yarn)\b/i,
  /^(yes|no|ok|thanks|y|n)$/i,
  /^\/\w+$/,  // Single-word slash commands like /help
];

const CODE_BLOCK_RE = /```[\s\S]*?```/g;

/**
 * shouldSkip — returns true when the RLM pipeline should be skipped.
 * Matches shouldSkipRLM() in rlm-hook.mjs (returns boolean, not {skip,reason}).
 */
function shouldSkip(input) {
  if (input.length < MIN_INPUT_LENGTH) return true;
  const trimmed = input.trim();
  for (const pattern of SIMPLE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  const blocks = [...input.matchAll(CODE_BLOCK_RE)];
  if (blocks.length > 1) {
    const codeLen = blocks.reduce((s, m) => s + m[0].length, 0);
    if (codeLen > input.length * 0.5) return true;
  }
  return false;
}

// ─── INLINED PARSE LOGIC (mirrors parseHaikuResponse in rlm-hook.mjs) ────────

const ERROR_SENTINEL_REASON = 'Could not parse response';

/**
 * parseResponse — extracts structured JSON from a Haiku text response.
 * Matches parseHaikuResponse() in rlm-hook.mjs.
 */
function parseResponse(text) {
  // 1. Direct JSON parse
  try {
    return JSON.parse(text.trim());
  } catch { /* fall through */ }

  // 2. JSON inside markdown code block (```json or ``` plain)
  const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1].trim());
    } catch { /* fall through */ }
  }

  // 3. Any JSON object embedded in the text
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch { /* give up */ }
  }

  return { skip_rlm: true, skip_reason: ERROR_SENTINEL_REASON };
}

/**
 * isErrorSentinel — true when parseResponse() could not extract any JSON.
 */
function isErrorSentinel(result) {
  return (
    result !== null &&
    typeof result === 'object' &&
    result.skip_rlm === true &&
    result.skip_reason === ERROR_SENTINEL_REASON
  );
}

// ─── FILE CACHE (mirrors cache behaviour in rlm-hook.mjs) ────────────────────
//
// The production cache uses mtime for TTL; this variant stores the expiry inline
// so TTL expiry tests are deterministic without touching filesystem timestamps.

class FileCache {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  _path(key) {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return join(this.dir, `${hash}.json`);
  }

  set(key, value, ttlMs = 60_000) {
    const entry = { value, expires: Date.now() + ttlMs };
    writeFileSync(this._path(key), JSON.stringify(entry));
  }

  get(key) {
    try {
      const raw = readFileSync(this._path(key), 'utf8');
      const entry = JSON.parse(raw);
      if (Date.now() > entry.expires) return null;  // TTL expired
      return entry.value;
    } catch {
      return null;  // Cache miss
    }
  }
}

// ─── SUITE 1: SKIP DETECTION ACCURACY ────────────────────────────────────────

function runSkipDetectionSuite() {
  const cases = JSON.parse(readFileSync(join(FIXTURES_DIR, 'skip-cases.json'), 'utf8'));

  let tp = 0, tn = 0, fp = 0, fn = 0;
  const byCategory = {};
  const failures = [];

  for (const c of cases) {
    const predicted = shouldSkip(c.input);
    const correct = predicted === c.expected_skip;

    if (!byCategory[c.category]) {
      byCategory[c.category] = { total: 0, correct: 0 };
    }
    byCategory[c.category].total++;
    if (correct) byCategory[c.category].correct++;

    if (predicted && c.expected_skip) tp++;
    else if (!predicted && !c.expected_skip) tn++;
    else if (predicted && !c.expected_skip) fp++;
    else fn++;

    if (!correct) {
      failures.push({
        id: c.id,
        input_preview: c.input.slice(0, 60),
        expected_skip: c.expected_skip,
        predicted_skip: predicted,
      });
    }
  }

  const total = cases.length;
  const correct = tp + tn;
  const accuracy = correct / total;
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 1.0;
  const recall    = (tp + fn) > 0 ? tp / (tp + fn) : 1.0;
  const f1 = (precision + recall) > 0 ? 2 * precision * recall / (precision + recall) : 0.0;

  const byCategoryResult = {};
  for (const [cat, data] of Object.entries(byCategory)) {
    byCategoryResult[cat] = {
      total: data.total,
      correct: data.correct,
      accuracy: +(data.correct / data.total).toFixed(4),
    };
  }

  return {
    total_cases: total,
    correct,
    accuracy: +accuracy.toFixed(4),
    precision: +precision.toFixed(4),
    recall: +recall.toFixed(4),
    f1: +f1.toFixed(4),
    tp, tn, fp, fn,
    by_category: byCategoryResult,
    failures,
  };
}

// ─── SUITE 2: PARSE ROBUSTNESS ────────────────────────────────────────────────

function runParseRobustnessSuite() {
  const cases = JSON.parse(readFileSync(join(FIXTURES_DIR, 'parse-cases.json'), 'utf8'));

  let totalCorrect = 0;
  const byFormat = {};
  const failures = [];

  for (const c of cases) {
    const result = parseResponse(c.input);
    const succeeded = !isErrorSentinel(result);
    const successCorrect = succeeded === c.expected_success;

    // If expected success, also verify the expected field value
    let fieldCorrect = true;
    if (c.expected_success && succeeded && c.expected_field) {
      const actual = result[c.expected_field];
      fieldCorrect = JSON.stringify(actual) === JSON.stringify(c.expected_value);
    }

    const fullyCorrect = successCorrect && fieldCorrect;

    if (!byFormat[c.format]) {
      byFormat[c.format] = { total: 0, correct: 0 };
    }
    byFormat[c.format].total++;
    if (fullyCorrect) byFormat[c.format].correct++;

    if (fullyCorrect) {
      totalCorrect++;
    } else {
      failures.push({
        id: c.id,
        format: c.format,
        expected_success: c.expected_success,
        actual_success: succeeded,
        field_correct: fieldCorrect,
        expected_field: c.expected_field,
        expected_value: c.expected_value,
        actual_value: succeeded && c.expected_field ? result[c.expected_field] : undefined,
      });
    }
  }

  const total = cases.length;
  const byFormatResult = {};
  for (const [fmt, data] of Object.entries(byFormat)) {
    byFormatResult[fmt] = {
      total: data.total,
      correct: data.correct,
      success_rate: +(data.correct / data.total).toFixed(4),
    };
  }

  return {
    total_cases: total,
    correct: totalCorrect,
    success_rate: +(totalCorrect / total).toFixed(4),
    by_format: byFormatResult,
    failures,
  };
}

// ─── SUITE 3: CACHE PERFORMANCE ───────────────────────────────────────────────

function runCachePerformanceSuite() {
  const cacheDir = join(tmpdir(), `rlm-bench-cache-${Date.now()}-${randomBytes(4).toString('hex')}`);
  const cache = new FileCache(cacheDir);

  const N = 1000;
  const keys   = Array.from({ length: N }, (_, i) => `bench-key-${i}-${randomBytes(8).toString('hex')}`);
  const values = keys.map((k, i) => ({ index: i, key: k, data: randomBytes(32).toString('hex') }));

  // --- Write throughput ---
  const writeStart = performance.now();
  for (let i = 0; i < N; i++) {
    cache.set(keys[i], values[i], 60_000);
  }
  const writeMs = performance.now() - writeStart;
  const writeOpsPerSec = Math.round(N / (writeMs / 1000));

  // --- Read throughput ---
  const readStart = performance.now();
  let readHits = 0;
  for (let i = 0; i < N; i++) {
    const v = cache.get(keys[i]);
    if (v !== null) readHits++;
  }
  const readMs = performance.now() - readStart;
  const readOpsPerSec = Math.round(N / (readMs / 1000));

  // --- TTL expiry correctness ---
  const expiredKeys = Array.from({ length: 10 }, (_, i) => `expired-${i}-${randomBytes(4).toString('hex')}`);
  for (const k of expiredKeys) {
    // Write with TTL already elapsed (expires in the past)
    const entry = { value: { data: 'stale' }, expires: Date.now() - 1000 };
    writeFileSync(cache._path(k), JSON.stringify(entry));
  }
  let expiredMisses = 0;
  for (const k of expiredKeys) {
    if (cache.get(k) === null) expiredMisses++;
  }
  const ttlExpiryCorrect = expiredMisses === expiredKeys.length;

  // --- Cleanup ---
  try {
    for (const f of readdirSync(cacheDir)) {
      unlinkSync(join(cacheDir, f));
    }
    import('fs').then(({ rmdirSync }) => { try { rmdirSync(cacheDir); } catch {} });
  } catch { /* best-effort cleanup */ }

  return {
    n_entries: N,
    write_ms: +writeMs.toFixed(2),
    read_ms: +readMs.toFixed(2),
    read_hits: readHits,
    write_ops_per_sec: writeOpsPerSec,
    read_ops_per_sec: readOpsPerSec,
    ttl_expiry_correct: ttlExpiryCorrect,
    ttl_expired_checked: expiredKeys.length,
    ttl_expired_null_returns: expiredMisses,
  };
}

// ─── SUITE 4: THROUGHPUT (pure-JS skip detection) ────────────────────────────

function runThroughputSuite() {
  // Representative inputs spanning all skip paths
  const inputs = [
    // Short — length check
    'ls', 'ok', 'yes', 'done', 'exit',
    // CLI commands — pattern match
    'ls -la /home/coding/projects',
    'git status --short -b',
    'npm install --save-dev',
    'yarn add express --dev',
    'cat /etc/nginx/nginx.conf',
    // Slash commands — pattern match
    '/help', '/clear', '/config', '/status', '/reset',
    // Complex queries — no skip (exercises full path)
    'How should I structure a React application with Redux for state management?',
    'Design a microservices architecture for real-time financial trading with low latency requirements.',
    'What are the best practices for securing a REST API using JWT tokens?',
    'Explain the tradeoffs between SQL and NoSQL for high-traffic e-commerce platforms.',
    'Help me implement OAuth 2.0 with PKCE flow for a mobile application.',
  ];

  const N = 10_000;
  const cycleLen = inputs.length;

  const start = performance.now();
  let skipCount = 0;
  for (let i = 0; i < N; i++) {
    if (shouldSkip(inputs[i % cycleLen])) skipCount++;
  }
  const elapsedMs = performance.now() - start;
  const opsPerSec = Math.round(N / (elapsedMs / 1000));

  return {
    iterations: N,
    elapsed_ms: +elapsedMs.toFixed(3),
    skip_detection_ops_per_sec: opsPerSec,
    skip_count: skipCount,
    no_skip_count: N - skipCount,
  };
}

// ─── THRESHOLDS ───────────────────────────────────────────────────────────────

const THRESHOLDS = {
  skip_accuracy:   { required: 0.95,  label: 'Skip Detection Accuracy ≥ 95%' },
  parse_success:   { required: 0.90,  label: 'Parse Success Rate ≥ 90%' },
  cache_write_ops: { required: 1_000, label: 'Cache Write ≥ 1 000 ops/sec' },
  throughput_ops:  { required: 10_000,label: 'Skip Throughput ≥ 10 000 ops/sec' },
};

// ─── HUMAN-READABLE TABLE ─────────────────────────────────────────────────────

function printTable(results) {
  const { suites, thresholds, summary } = results;

  const LINE = '─'.repeat(70);
  const DLINE = '═'.repeat(70);

  console.log('\n' + DLINE);
  console.log('  claude-code-rlm benchmark results');
  console.log('  ' + results.timestamp + '  node ' + results.node_version);
  console.log(DLINE);

  // Suite 1: Skip Detection
  const sd = suites.skip_detection;
  console.log('\nSuite 1: Skip Detection Accuracy');
  console.log(LINE);
  console.log(`  Cases: ${sd.total_cases}   Correct: ${sd.correct}   Failures: ${sd.total_cases - sd.correct}`);
  console.log(`  Accuracy : ${pct(sd.accuracy)}  Precision: ${pct(sd.precision)}  Recall: ${pct(sd.recall)}  F1: ${pct(sd.f1)}`);
  console.log('  Per category:');
  for (const [cat, data] of Object.entries(sd.by_category)) {
    const mark = data.accuracy === 1.0 ? '  OK' : '  WARN';
    console.log(`    ${cat.padEnd(16)} ${data.correct}/${data.total}  ${pct(data.accuracy)}${mark}`);
  }
  if (sd.failures.length > 0) {
    console.log('  Failures:');
    for (const f of sd.failures) {
      console.log(`    [${f.id}] expected_skip=${f.expected_skip}, got=${f.predicted_skip}  "${f.input_preview}"`);
    }
  }

  // Suite 2: Parse Robustness
  const pr = suites.parse_robustness;
  console.log('\nSuite 2: Parse Robustness');
  console.log(LINE);
  console.log(`  Cases: ${pr.total_cases}   Correct: ${pr.correct}   Failures: ${pr.total_cases - pr.correct}`);
  console.log(`  Overall success rate: ${pct(pr.success_rate)}`);
  console.log('  Per format:');
  for (const [fmt, data] of Object.entries(pr.by_format)) {
    const mark = data.success_rate === 1.0 ? '  OK' : (data.success_rate >= 0.5 ? '  WARN' : '  FAIL');
    console.log(`    ${fmt.padEnd(28)} ${data.correct}/${data.total}  ${pct(data.success_rate)}${mark}`);
  }
  if (pr.failures.length > 0) {
    console.log('  Failures:');
    for (const f of pr.failures) {
      console.log(`    [${f.id}] fmt=${f.format} success=${f.actual_success} field_ok=${f.field_correct}`);
    }
  }

  // Suite 3: Cache Performance
  const cp = suites.cache_performance;
  console.log('\nSuite 3: Cache Performance');
  console.log(LINE);
  console.log(`  Write: ${cp.write_ops_per_sec.toLocaleString()} ops/sec  (${cp.n_entries} entries, ${cp.write_ms}ms)`);
  console.log(`  Read:  ${cp.read_ops_per_sec.toLocaleString()} ops/sec  (${cp.read_hits}/${cp.n_entries} hits, ${cp.read_ms}ms)`);
  console.log(`  TTL expiry: ${cp.ttl_expiry_correct ? 'CORRECT' : 'BROKEN'}  (${cp.ttl_expired_null_returns}/${cp.ttl_expired_checked} expired entries returned null)`);

  // Suite 4: Throughput
  const tp = suites.throughput;
  console.log('\nSuite 4: Skip Detection Throughput');
  console.log(LINE);
  console.log(`  ${tp.skip_detection_ops_per_sec.toLocaleString()} ops/sec  (${tp.iterations.toLocaleString()} iterations in ${tp.elapsed_ms}ms)`);
  console.log(`  Skip: ${tp.skip_count.toLocaleString()}   No-skip: ${tp.no_skip_count.toLocaleString()}`);

  // Thresholds
  console.log('\n' + DLINE);
  console.log('  Threshold checks');
  console.log(DLINE);
  for (const [key, thr] of Object.entries(thresholds)) {
    const mark = thr.pass ? '  PASS' : '  FAIL';
    const actual = typeof thr.actual === 'number' && thr.actual > 100
      ? thr.actual.toLocaleString()
      : String(thr.actual);
    const req = typeof thr.required === 'number' && thr.required > 100
      ? thr.required.toLocaleString()
      : String(thr.required);
    console.log(`  ${THRESHOLDS[key].label.padEnd(40)} actual=${actual}  required=${req}${mark}`);
  }

  console.log('\n' + DLINE);
  console.log(`  Overall: ${summary}`);
  console.log(DLINE + '\n');
}

function pct(v) {
  return (v * 100).toFixed(1) + '%';
}

// ─── COMPARE TO BASELINE ──────────────────────────────────────────────────────

function compareToBaseline(current) {
  const baselinePath = join(RESULTS_DIR, 'baseline.json');
  if (!existsSync(baselinePath)) {
    console.warn('  No baseline.json found. Run with --update-baseline first.');
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const LINE = '─'.repeat(70);

  console.log('\nComparison to baseline (' + baseline.timestamp + ')');
  console.log(LINE);

  const metrics = [
    { label: 'Skip accuracy',         cur: current.suites.skip_detection.accuracy,             base: baseline.suites.skip_detection.accuracy,             format: 'pct' },
    { label: 'Skip precision',        cur: current.suites.skip_detection.precision,             base: baseline.suites.skip_detection.precision,            format: 'pct' },
    { label: 'Skip recall',           cur: current.suites.skip_detection.recall,                base: baseline.suites.skip_detection.recall,               format: 'pct' },
    { label: 'Skip F1',               cur: current.suites.skip_detection.f1,                    base: baseline.suites.skip_detection.f1,                   format: 'pct' },
    { label: 'Parse success rate',    cur: current.suites.parse_robustness.success_rate,        base: baseline.suites.parse_robustness.success_rate,       format: 'pct' },
    { label: 'Cache write ops/sec',   cur: current.suites.cache_performance.write_ops_per_sec,  base: baseline.suites.cache_performance.write_ops_per_sec, format: 'num' },
    { label: 'Cache read ops/sec',    cur: current.suites.cache_performance.read_ops_per_sec,   base: baseline.suites.cache_performance.read_ops_per_sec,  format: 'num' },
    { label: 'Throughput ops/sec',    cur: current.suites.throughput.skip_detection_ops_per_sec,base: baseline.suites.throughput.skip_detection_ops_per_sec,format: 'num' },
  ];

  for (const m of metrics) {
    const diff = m.cur - m.base;
    const pctChange = m.base !== 0 ? ((diff / m.base) * 100).toFixed(1) : 'N/A';
    const sign = diff >= 0 ? '+' : '';
    const arrow = diff > 0 ? 'UP' : diff < 0 ? 'DOWN' : '  ==';
    const curFmt  = m.format === 'pct' ? pct(m.cur)  : m.cur.toLocaleString();
    const baseFmt = m.format === 'pct' ? pct(m.base) : m.base.toLocaleString();
    console.log(
      `  ${m.label.padEnd(28)} baseline=${baseFmt.padEnd(10)} current=${curFmt.padEnd(10)} ${arrow} ${sign}${pctChange}%`
    );
  }
  console.log(LINE);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Running claude-code-rlm benchmark suites...\n');

  // Run all suites
  process.stdout.write('  Suite 1: Skip Detection...    ');
  const skipSuite = runSkipDetectionSuite();
  console.log('done');

  process.stdout.write('  Suite 2: Parse Robustness...  ');
  const parseSuite = runParseRobustnessSuite();
  console.log('done');

  process.stdout.write('  Suite 3: Cache Performance... ');
  const cacheSuite = runCachePerformanceSuite();
  console.log('done');

  process.stdout.write('  Suite 4: Throughput...        ');
  const throughputSuite = runThroughputSuite();
  console.log('done');

  // Evaluate thresholds
  const thresholds = {
    skip_accuracy: {
      required: THRESHOLDS.skip_accuracy.required,
      actual: skipSuite.accuracy,
      pass: skipSuite.accuracy >= THRESHOLDS.skip_accuracy.required,
    },
    parse_success: {
      required: THRESHOLDS.parse_success.required,
      actual: parseSuite.success_rate,
      pass: parseSuite.success_rate >= THRESHOLDS.parse_success.required,
    },
    cache_write_ops: {
      required: THRESHOLDS.cache_write_ops.required,
      actual: cacheSuite.write_ops_per_sec,
      pass: cacheSuite.write_ops_per_sec >= THRESHOLDS.cache_write_ops.required,
    },
    throughput_ops: {
      required: THRESHOLDS.throughput_ops.required,
      actual: throughputSuite.skip_detection_ops_per_sec,
      pass: throughputSuite.skip_detection_ops_per_sec >= THRESHOLDS.throughput_ops.required,
    },
  };

  // Cache TTL also must be correct for a PASS
  const allPass =
    Object.values(thresholds).every(t => t.pass) &&
    cacheSuite.ttl_expiry_correct;

  const timestamp = new Date().toISOString();

  const results = {
    version: VERSION,
    timestamp,
    node_version: process.version,
    platform: process.platform,
    suites: {
      skip_detection: skipSuite,
      parse_robustness: parseSuite,
      cache_performance: cacheSuite,
      throughput: throughputSuite,
    },
    summary: allPass ? 'PASS' : 'FAIL',
    thresholds,
  };

  // Print human-readable table
  printTable(results);

  // Optionally compare to baseline
  if (COMPARE) {
    compareToBaseline(results);
    console.log('');
  }

  // Save result file
  mkdirSync(RESULTS_DIR, { recursive: true });

  const filename = timestamp.replace(/:/g, '-') + '.json';
  const resultPath = join(RESULTS_DIR, filename);
  writeFileSync(resultPath, JSON.stringify(results, null, 2));
  console.log(`Results saved → bench/results/${filename}`);

  // Optionally update baseline
  if (UPDATE_BASELINE) {
    const baselinePath = join(RESULTS_DIR, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify(results, null, 2));
    console.log('Baseline updated → bench/results/baseline.json');
  }

  // Exit with non-zero code on failure so CI catches it
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
