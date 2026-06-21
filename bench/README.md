# claude-code-rlm Benchmark Suite

Publicly reproducible benchmarks for the non-LLM logic inside `rlm-hook.mjs`.
No `claude` CLI, no API keys, no network access required.

## What Is Measured

| Suite | What it measures | Target |
|-------|-----------------|--------|
| **Skip Detection Accuracy** | Precision/recall/F1 of `shouldSkipRLM()` against 50 labeled cases | ≥ 95% accuracy |
| **Parse Robustness** | Success rate of `parseHaikuResponse()` across 5 input formats | ≥ 90% overall |
| **Cache Performance** | File-based cache write/read throughput + TTL expiry correctness | ≥ 1 000 ops/sec write |
| **Throughput** | Pure-JS skip detection ops/sec on a representative input mix | ≥ 10 000 ops/sec |

The benchmark logic is **inlined** from `rlm-hook.mjs` — it does not import or exec the hook itself — so it remains runnable in any environment, including CI runners without the Claude Code CLI.

## Running the Benchmark

```bash
# One-shot run — prints table + saves bench/results/<timestamp>.json
node bench/benchmark.mjs

# npm script shortcut
npm run bench
```

## Updating the Baseline

After a logic change you want to accept as the new norm:

```bash
node bench/benchmark.mjs --update-baseline
```

This writes the current run to `bench/results/baseline.json`. The baseline is committed to the repo so anyone can compare against it.

## Comparing Against the Baseline

```bash
node bench/benchmark.mjs --compare
```

Prints the full results table followed by a delta table showing each metric's movement relative to `bench/results/baseline.json`.

## Suite Details

### Suite 1 — Skip Detection Accuracy

**Fixture:** `bench/fixtures/skip-cases.json` — 50 labeled cases, 10 per category.

| Category | Description | Expected |
|----------|-------------|----------|
| `short` | Inputs under 20 chars | skip |
| `cli-command` | `ls`, `git status`, `npm`, `yarn`, `cat`, `echo`, `cd` commands | skip |
| `slash-command` | `/help`, `/clear`, `/config`, etc. | skip |
| `complex-query` | Architecture, debugging, or feature requests | **no skip** |
| `code-heavy` | 2+ fenced code blocks where code exceeds 50% of total length | skip |

**Metrics computed:** accuracy, precision, recall, F1, per-category accuracy.

### Suite 2 — Parse Robustness

**Fixture:** `bench/fixtures/parse-cases.json` — 30 cases, 5 formats × 6 cases each.

| Format | Description | Expected |
|--------|-------------|----------|
| `raw` | Bare JSON string | success |
| `markdown-json-block` | JSON inside ` ```json ... ``` ` | success |
| `markdown-plain-block` | JSON inside ` ``` ... ``` ` (no language tag) | success |
| `embedded` | JSON object embedded mid-prose | success |
| `garbage` | Plain text, XML, JS object literals, YAML — no valid JSON | **failure** |

A case is counted as correct when:
- The parse succeeded/failed as expected, AND
- For success cases, the named `expected_field` in the result matches `expected_value`.

### Suite 3 — Cache Performance

Creates a temporary directory and benchmarks 1 000 synchronous file-based cache writes then reads, measuring:

- **Write throughput** (ops/sec)
- **Read throughput** (ops/sec)
- **TTL expiry correctness** — 10 entries are written with a past expiry timestamp; all 10 must return `null` on read.

The cache used here stores `{ value, expires }` inline in the JSON file (matching the spirit of the production mtime-based TTL without requiring filesystem clock manipulation).

### Suite 4 — Throughput

Runs 10 000 iterations of `shouldSkip()` over a rotating set of 20 representative inputs (short inputs, CLI commands, slash commands, and complex queries) and reports ops/sec.

Pure JS with no I/O — should easily exceed 100 000 ops/sec on any modern Node.js runtime.

## Threshold Rationale

| Threshold | Value | Rationale |
|-----------|-------|-----------|
| Skip accuracy | ≥ 95% | 3+ mistakes per 50 cases would indicate a broken skip heuristic |
| Parse success | ≥ 90% | Allows for minor edge-case variance; garbage cases must still fail correctly |
| Cache write | ≥ 1 000 ops/sec | Well below any reasonable file-system capability; ensures basic I/O works |
| Throughput | ≥ 10 000 ops/sec | Pure-JS floor; real performance is 10–100x higher |

## How to Reproduce (from a Clean Checkout)

```bash
git clone <repo-url>
cd claude-code-rlm
node --version   # requires >=18.0.0
node bench/benchmark.mjs
```

No `npm install` required — the benchmark uses only Node.js built-in modules (`fs`, `path`, `crypto`, `perf_hooks`, `os`, `url`).

## Result Files

Each run creates `bench/results/<ISO-timestamp>.json` with the full machine-readable output. `bench/results/baseline.json` is the committed reference run.

To compare two arbitrary result files:

```bash
# Diff two run files
diff <(jq '.thresholds' bench/results/baseline.json) \
     <(jq '.thresholds' bench/results/<other-run>.json)
```
