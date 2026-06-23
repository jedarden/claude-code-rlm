#!/usr/bin/env node
/**
 * claude-code-rlm — metrics dashboard (Phase 5, Unit 3)
 *
 * Renders the aggregated metrics from `parse-log.mjs` into a single static HTML
 * page: an overall summary header (hit / skip / error % + latency p50/p95/p99),
 * a per-UTC-day table, a skip-reasons breakdown, and event/mode tallies.
 *
 * Dependency-free — Node built-ins only (`http`, `fs/promises` via parse-log,
 * `url`). The data layer is single-sourced: aggregation lives in `parse-log.mjs`
 * and is imported here, never re-implemented.
 *
 * `renderHTML(agg)` is a PURE string function (no FS, no clock, no server), so
 * the unit tests can assert on the markup with zero side effects. The CLI entry
 * — file write and `--serve` — is guarded by `import.meta.url` so importing this
 * module binds no socket and writes no file.
 *
 * Usage:
 *   node bench/dashboard.mjs                  # render to bench/results/dashboard.html
 *   node bench/dashboard.mjs <log>            # explicit log path
 *   node bench/dashboard.mjs --out <path>     # explicit output HTML path
 *   node bench/dashboard.mjs --serve          # serve live on http://localhost:9876
 *   node bench/dashboard.mjs --serve --port N # serve on a custom port
 */

import { createServer } from 'http';
import { writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { aggregate, parseLog, readLog, defaultLogPath } from './parse-log.mjs';

// ---------------------------------------------------------------------------
// Pure HTML render (no FS, no clock — directly importable for tests)
// ---------------------------------------------------------------------------

/** Escape text for safe interpolation into HTML. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format a rate (0..1) as a percentage; null/undefined → em dash. */
function pct(n) {
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`;
}

/** Format a number; null/undefined → em dash. */
function num(n) {
  return n == null ? '—' : String(n);
}

/** Render a `{key: count}` map as table rows, or an empty-state row. */
function mapRows(map, emptyLabel) {
  const entries = Object.entries(map && typeof map === 'object' ? map : {});
  if (entries.length === 0) {
    return `<tr><td class="muted" colspan="2">${esc(emptyLabel)}</td></tr>`;
  }
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`)
    .join('');
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  margin: 0; padding: 2rem; background: #0f1115; color: #e6e6e6;
}
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 2rem 0 .5rem; color: #9aa4b2; text-transform: uppercase; letter-spacing: .05em; }
.sub { color: #6b7280; margin: 0 0 1.5rem; font-size: .85rem; }
.cards { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
.card {
  background: #181b22; border: 1px solid #262b35; border-radius: 8px;
  padding: 1rem 1.25rem; min-width: 8rem;
}
.card .label { color: #6b7280; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; }
.card .value { font-size: 1.5rem; font-weight: 600; margin-top: .25rem; }
table { border-collapse: collapse; width: 100%; max-width: 64rem; margin-bottom: 1rem; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #262b35; }
th { color: #9aa4b2; font-weight: 600; font-size: .8rem; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
.muted { color: #6b7280; }
.grids { display: flex; flex-wrap: wrap; gap: 2rem; }
.grids > div { flex: 1; min-width: 16rem; }
footer { margin-top: 2rem; color: #6b7280; font-size: .8rem; }
`.trim();

/**
 * Render the aggregate shape from `aggregate()` into a complete HTML document.
 *
 * @param {{days: object[], overall: object}} agg
 * @param {{logPath?: string}} [opts]
 * @returns {string} a full standalone HTML page
 *
 * Defensive: tolerates a missing/partial `agg` (empty page, no throw). All
 * interpolated text is escaped; null latencies render as an em dash.
 */
export function renderHTML(agg, opts = {}) {
  const overall = (agg && agg.overall) || {};
  const days = Array.isArray(agg && agg.days) ? agg.days : [];
  const oLat = overall.latency || {};
  const logPath = opts.logPath || '';

  const cards = [
    ['Events', num(overall.total ?? 0)],
    ['Hit rate', pct(overall.hit_rate)],
    ['Skip rate', pct(overall.skip_rate)],
    ['Error rate', pct(overall.error_rate)],
    ['p50', `${num(oLat.p50)}${oLat.p50 == null ? '' : 'ms'}`],
    ['p95', `${num(oLat.p95)}${oLat.p95 == null ? '' : 'ms'}`],
    ['p99', `${num(oLat.p99)}${oLat.p99 == null ? '' : 'ms'}`],
  ]
    .map(
      ([label, value]) =>
        `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(
          value
        )}</div></div>`
    )
    .join('');

  const dayRows =
    days.length === 0
      ? `<tr><td class="muted" colspan="8">No metrics recorded yet.</td></tr>`
      : days
          .map((d) => {
            const lat = d.latency || {};
            return `<tr>
  <td>${esc(d.day)}</td>
  <td class="n">${esc(d.total ?? 0)}</td>
  <td class="n">${esc(pct(d.hit_rate))}</td>
  <td class="n">${esc(pct(d.skip_rate))}</td>
  <td class="n">${esc(pct(d.error_rate))}</td>
  <td class="n">${esc(num(lat.p50))}</td>
  <td class="n">${esc(num(lat.p95))}</td>
  <td class="n">${esc(num(lat.p99))}</td>
</tr>`;
          })
          .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-code-rlm — metrics</title>
<style>${STYLE}</style>
</head>
<body>
<h1>claude-code-rlm — metrics dashboard</h1>
<p class="sub">${logPath ? `Source: ${esc(logPath)}` : 'Aggregated hook metrics'}</p>

<h2>Overall</h2>
<div class="cards">${cards}</div>

<h2>By day</h2>
<table>
<thead>
<tr>
  <th>Day</th><th class="n">Events</th><th class="n">Hit%</th><th class="n">Skip%</th>
  <th class="n">Err%</th><th class="n">p50</th><th class="n">p95</th><th class="n">p99</th>
</tr>
</thead>
<tbody>${dayRows}</tbody>
</table>

<div class="grids">
<div>
<h2>Skip reasons</h2>
<table>
<thead><tr><th>Reason</th><th class="n">Count</th></tr></thead>
<tbody>${mapRows(overall.skip_reasons, 'No skips recorded.')}</tbody>
</table>
</div>
<div>
<h2>Events</h2>
<table>
<thead><tr><th>Event</th><th class="n">Count</th></tr></thead>
<tbody>${mapRows(overall.events, 'No events recorded.')}</tbody>
</table>
</div>
<div>
<h2>Modes</h2>
<table>
<thead><tr><th>Mode</th><th class="n">Count</th></tr></thead>
<tbody>${mapRows(overall.modes, 'No modes recorded.')}</tbody>
</table>
</div>
</div>

<footer>Generated by bench/dashboard.mjs — claude-code-rlm</footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// FS + CLI + server (side-effecting; only run on direct invocation)
// ---------------------------------------------------------------------------

/** Read the log, parse it, and render fresh HTML. Re-read per call so a server
 *  reflects the live log on every request. */
async function buildHTML(logPath) {
  const text = await readLog(logPath);
  const agg = aggregate(parseLog(text));
  return renderHTML(agg, { logPath });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { serve: false, port: 9876, out: null, logPath: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--serve') opts.serve = true;
    else if (a === '--port') opts.port = Number(args[++i]) || opts.port;
    else if (a === '--out') opts.out = args[++i];
    else if (!a.startsWith('--') && !opts.logPath) opts.logPath = a;
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const logPath = opts.logPath || defaultLogPath();

  if (opts.serve) {
    const server = createServer(async (req, res) => {
      try {
        const html = await buildHTML(logPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`dashboard error: ${err && err.message}`);
      }
    });
    server.listen(opts.port, () => {
      console.error(`RLM dashboard serving ${logPath}`);
      console.error(`  → http://localhost:${opts.port}`);
    });
    return;
  }

  // One-shot render to a file.
  const html = await buildHTML(logPath);
  const outPath =
    opts.out || join(dirname(fileURLToPath(import.meta.url)), 'results', 'dashboard.html');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, 'utf-8');
  console.log(outPath);
}

// Run only when invoked directly (not on import) — keeps tests side-effect-free.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv);
}
