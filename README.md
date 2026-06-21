# claude-code-rlm

**Preresearch hook for Claude Code — lets Haiku explore your codebase before Opus/Sonnet takes over**

![Status: Active](https://img.shields.io/badge/status-active-brightgreen)
![Node: 18+](https://img.shields.io/badge/node-18%2B-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

---

## What it does

When you type a prompt in Claude Code, this hook fires first. Haiku (fast, cheap) explores your codebase using Glob, Grep, Read, and Git tools — finding relevant files, surfacing existing patterns, and noting recent changes. The findings are synthesized into a structured `<rlm_preresearch>` block and injected as context before the main model ever sees your prompt. By the time Opus or Sonnet starts responding, it already has a pre-digested map of exactly what's relevant — so it can skip straight to implementation.

---

## Why it matters

**Without RLM:** Opus starts cold. It spends 10–20 tool calls just orienting itself — reading `package.json`, globbing for test files, grepping for the function you mentioned — before writing a single line of code. You're paying Opus prices for work Haiku could do at a tenth of the cost.

**With RLM:** Haiku pre-maps the codebase in the time it takes you to read your own prompt back. Opus gets handed a structured summary of the files that matter, the patterns already in use, and the most recent relevant commits. It starts implementing on turn one.

**Smart skipping:** Trivial queries — `ls`, `/help`, short affirmatives, pure CLI commands — are detected and bypassed instantly. No API call, no delay.

**Caching:** Identical or near-identical prompts (common in coding sessions where you refine the same request) return in ~37ms via a SHA-256 keyed file cache with a 1-hour TTL.

---

## Example output

The hook injects a block like this before your prompt reaches the main model:

```xml
<rlm_preresearch>
  <intent>Add retry logic to the Kalshi order submission function</intent>
  <relevant_files>
    <file path="src/orders.ts" relevance="primary">Contains submitOrder() at line 142; currently no retry logic</file>
    <file path="src/client.ts" relevance="secondary">HttpClient with exponential backoff helper already implemented at line 89</file>
    <file path="test/orders.test.ts" relevance="tests">6 existing tests for submitOrder; mock at line 34</file>
  </relevant_files>
  <patterns>
    - Retry logic in this codebase uses withRetry() from src/utils/retry.ts (max 3, 200ms base delay)
    - Error types: KalshiRateLimitError and KalshiNetworkError are retryable; KalshiAuthError is not
    - Tests use vi.useFakeTimers() for delay testing (see src/pricing.test.ts line 12)
  </patterns>
  <recent_changes>
    - 2d ago: Added KalshiRateLimitError to error.ts (commit a3f1c2b)
    - 5d ago: withRetry() added to utils/retry.ts (commit 8e9d0f4)
  </recent_changes>
  <approach>
    Wrap the HTTP call in submitOrder() with withRetry(), passing [KalshiRateLimitError, KalshiNetworkError]
    as retryable types. Update the 6 existing tests to cover retry behavior using fake timers.
  </approach>
</rlm_preresearch>
```

---

## Installation

**Quick install (recommended):**
```bash
git clone https://git.ardenone.com/jedarden/claude-code-rlm.git
cd claude-code-rlm
bash install.sh
```

The install script copies `rlm-hook.mjs` to `~/.claude/hooks/` and makes it executable.

**Add to Claude Code settings** (`~/.claude/settings.json`):
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/rlm-hook.mjs",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

**Requirements:**
- Node.js 18+
- Claude Code CLI (`claude` in PATH)

---

## Configuration

All configuration is via environment variables. Set them in your shell profile or in `~/.claude/settings.json` under `env`.

```bash
# Mode selection
RLM_AGENTIC_MODE=true    # Enable codebase exploration with tools (default: true, ~20s)
RLM_AGENTIC_MODE=false   # Fast analysis only (~4s)
RLM_FAST_MODE=true       # Concise non-agentic analysis (~4s, default when agentic=false)

# Model tuning
RLM_MODEL=claude-haiku-4-5-20251001   # Which model to use for preresearch
RLM_TIMEOUT=60000                      # Total timeout in ms (default: 60s)
RLM_CACHE_TTL=3600                     # Cache TTL in seconds (default: 1h)
RLM_MIN_LENGTH=20                      # Skip inputs shorter than this (chars)
RLM_MAX_LENGTH=4000                    # Truncate inputs longer than this (chars)
RLM_MAX_TURNS=10                       # Max tool calls in agentic mode

# Paths
RLM_CACHE_DIR=~/.cache/rlm-hook        # Cache directory
RLM_LOG_FILE=~/.local/share/rlm-hook/rlm-hook.log

# Debug
RLM_DEBUG=true    # Verbose logging to RLM_LOG_FILE
```

---

## How skip detection works

Not every prompt benefits from preresearch. The hook detects and skips trivial inputs immediately — no API call, ~27ms exit.

| Input type | Example | Reason skipped |
|---|---|---|
| Short (\<20 chars) | `ls`, `yes`, `ok`, `sure` | Not worth analyzing |
| Slash command | `/help`, `/clear`, `/compact` | Claude Code meta-commands |
| CLI pattern | `git status`, `npm install`, `cargo build` | Operational, not exploratory |
| Code-heavy paste | Block with 2+ large fenced code sections | Prompt already carries its own context |
| Pure question words | `what`, `why`, `how` alone | Underspecified; Opus handles better cold |

---

## Latency profile

| Scenario | Latency | Notes |
|---|---|---|
| Skip (trivial query) | ~27ms | No API call made |
| Cache hit | ~37ms | File read + JSON parse only |
| Agentic mode (cache miss) | ~20s | Full codebase exploration with tools |
| Fast mode (cache miss) | ~4s | Concise analysis, no tool calls |

Agentic mode latency overlaps with the time you spend reading the response to your previous turn — for most workflows, it adds zero perceived delay.

---

## Benchmark

```bash
node bench/benchmark.mjs
```

See [`bench/README.md`](bench/README.md) for methodology, baseline comparisons, and how to interpret results.

```bash
# Quick smoke test
npm run bench
```

---

## Development

```bash
# Run unit tests
npm test

# Run integration tests (requires claude CLI)
npm run test:integration

# Run benchmark
npm run bench

# Lint
npm run lint
```

Tests live in `test/`. Integration tests require a live `claude` binary and make real API calls — they are skipped automatically if `claude` is not in PATH.

---

## How it works (technical)

1. **Hook fires:** Claude Code calls `rlm-hook.mjs` with JSON on stdin: `{prompt, cwd, transcript_path}`.
2. **Skip check:** Trivial inputs (short, slash commands, CLI patterns, code-heavy) exit 0 immediately.
3. **Cache check:** SHA-256 hash of `(prompt, cwd)` is looked up in `RLM_CACHE_DIR`. Hit → print cached block, exit 0.
4. **Haiku runs:** `claude --model $RLM_MODEL --allowedTools 'Read,Glob,Grep,Bash(git:*)'` is spawned with a structured system prompt instructing it to explore the codebase and write findings to a scratch file.
5. **Haiku explores:** Up to `RLM_MAX_TURNS` tool calls — globbing for relevant files, grepping for referenced symbols, reading key sections, checking `git log` for recent changes.
6. **Synthesis:** Haiku writes a JSON scratch file, then the hook formats it into the `<rlm_preresearch>` XML block and cleans up the scratch file.
7. **Injection:** The formatted block is printed to stdout. Claude Code injects it as a system-level prefix before the user's prompt reaches the main model.
8. **Error safety:** Any failure (timeout, API error, parse error) exits 0 with no output — the hook never blocks or corrupts a conversation.

---

## License

MIT. See [LICENSE](LICENSE).
