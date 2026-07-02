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

The hook injects a structured analysis block before your prompt reaches the main model. In agentic mode (default), the output includes pretty-printed JSON followed by a plain-text summary:

```
<rlm_preresearch>
{
  "intent": "Add retry logic to the payment service submit function",
  "summary": "User wants to add retry logic to a payment submission function. Analysis needed to find existing patterns and determine approach.",
  "relevant_files": [
    {"path": "src/payments.ts", "purpose": "Contains submitPayment() at line 142; currently no retry logic"},
    {"path": "src/utils/retry.ts", "purpose": "withRetry() utility for exponential backoff (max 3 retries, 200ms base delay)"},
    {"path": "test/payments.test.ts", "purpose": "6 existing tests for submitPayment; mock at line 34"}
  ],
  "existing_patterns": [
    "Retry logic uses withRetry() from src/utils/retry.ts",
    "Retryable error types: RateLimitError, NetworkError",
    "Non-retryable: AuthError",
    "Tests use vi.useFakeTimers() for delay testing (see src/pricing.test.ts)"
  ],
  "recent_changes": "2d ago: Added RateLimitError (a3f1c2b)\n5d ago: withRetry() added (8e9d0f4)",
  "approach": "Wrap submitPayment()'s HTTP call with withRetry(), passing [RateLimitError, NetworkError] as retryable types. Update tests to use fake timers.",
  "tasks": [
    "Read src/payments.ts to locate submitPayment()",
    "Review src/utils/retry.ts for retry pattern",
    "Identify retryable error types"
  ],
  "warnings": []
}
</rlm_preresearch>

PRERESEARCH COMPLETE:
Intent: Add retry logic to the payment service submit function
Summary: User wants to add retry logic to a payment submission function. Analysis needed to find existing patterns and determine approach.
Relevant Files: src/payments.ts (Contains submitPayment() at line 142; currently no retry logic); src/utils/retry.ts (withRetry() utility for exponential backoff (max 3 retries, 200ms base delay)); test/payments.test.ts (6 existing tests for submitPayment; mock at line 34)
Existing Patterns: Retry logic uses withRetry() from src/utils/retry.ts; Retryable error types: RateLimitError, NetworkError; Non-retryable: AuthError; Tests use vi.useFakeTimers() for delay testing (see src/pricing.test.ts)
Recent Changes: 2d ago: Added RateLimitError (a3f1c2b)
5d ago: withRetry() added (8e9d0f4)
Tasks: Read src/payments.ts to locate submitPayment(); Review src/utils/retry.ts for retry pattern; Identify retryable error types
Approach: Wrap submitPayment()'s HTTP call with withRetry(), passing [RateLimitError, NetworkError] as retryable types. Update tests to use fake timers.
```

---

## Installation

**Quick install (recommended):**
```bash
git clone https://github.com/jedarden/claude-code-rlm.git
cd claude-code-rlm
bash install.sh
```

The install script copies `rlm-hook.mjs` to `~/.claude/hooks/` and makes it executable. During installation, you'll be prompted to optionally install SDK dependencies for SDK-Direct mode.

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
            "timeout": 90
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

**SDK-Direct mode (optional):**
If you chose to install SDK dependencies during installation, set these environment variables:
```bash
RLM_USE_SDK=true
ANTHROPIC_API_KEY=sk-ant-...
```

If you skipped SDK installation during install, you can add it later:
```bash
npm install --prefix ~/.claude/hooks @anthropic-ai/sdk
```

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
RLM_TIMEOUT=60000                      # Total timeout in ms (default: 60s, must be < hook timeout in settings.json)
RLM_CACHE_TTL=3600                     # Cache TTL in seconds (default: 1h)
RLM_MIN_LENGTH=20                      # Skip inputs shorter than this (chars)
RLM_MAX_LENGTH=4000                    # Truncate inputs longer than this (chars)
RLM_MAX_TURNS=10                       # Max tool calls in agentic mode

# Paths
RLM_CACHE_DIR=~/.cache/rlm-hook        # Cache directory
RLM_LOG_FILE=~/.local/share/rlm-hook/rlm-hook.log
RLM_METRICS_FILE=~/.local/share/rlm-hook/metrics.jsonl  # Phase 5: metrics JSONL for dashboard

# Phase 2: SDK-Direct mode (alternative to subprocess)
RLM_USE_SDK=true                       # Use Anthropic SDK directly (requires ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-ant-...           # Required when RLM_USE_SDK=true
RLM_SDK_MAX_TOKENS=2048                # Max tokens for SDK Haiku calls (default: 2048)

# Phase 3: Semantic caching (embeddings)
RLM_SEMANTIC_CACHE=true                # Enable embedding similarity cache (default: off)
RLM_SEMANTIC_THRESHOLD=0.92            # Cosine similarity threshold (0-1, default: 0.92)
RLM_EMBED_MODEL=text-embedding-3-small # OpenAI embedding model (default: text-embedding-3-small)
RLM_EMBED_BASE_URL=https://api.openai.com/v1  # Embedding API endpoint
OPENAI_API_KEY=sk-...                  # Required for semantic caching

# Phase 4: Context awareness
RLM_CONTEXT_WINDOW=5                   # How many prior RLM blocks to look back (default: 5)
RLM_GATHER_CONTEXT=true                # Gather project context (default: true)

# Debug
RLM_DEBUG=true    # Verbose logging to RLM_LOG_FILE
```

---

## How skip detection works

Not every prompt benefits from preresearch. The hook detects and skips trivial inputs immediately — no API call, ~27ms exit.

| Input type | Example | Reason skipped |
|---|---|---|
| Short (\<20 chars) | `ls`, `yes`, `ok`, `sure` | Not worth analyzing |
| Simple command | `ls`, `pwd`, `cat`, `echo`, `git status`, `npm`, `yarn` | Operational, not exploratory |
| Single-word response | `yes`, `no`, `ok`, `thanks`, `y`, `n` | Affirmation/negation, not a task |
| Slash command | `/help`, `/clear`, `/compact` | Claude Code meta-commands |
| Code-heavy paste | Input where >50% is code blocks with 2+ blocks | Prompt already carries its own context |

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

## Phase 4: Context reuse optimization

The hook tracks prior RLM blocks in the conversation and looks back over recent history to avoid re-analyzing the same intent or files. Configured via `RLM_CONTEXT_WINDOW` (default: 5 prior blocks).

**How it works:**

- Each RLM block stores its `intent`, `relevant_files`, and a content hash of analyzed files
- On a new prompt, the hook checks if the current intent was already explored in the last N blocks
- If the current prompt's files overlap significantly with a prior analysis, the hook may skip or shorten re-exploration
- This is an always-on optimization — no enable gate, only the look-back depth is tunable

**Example scenario:**

You ask "add error handling to the API client." Haiku explores `src/api.ts`, finds the client, and surfaces the pattern. Two turns later, you refine to "add retry logic too." The hook sees that `src/api.ts` was just analyzed and the new prompt is a continuation — it may skip re-reading the file and focus on the new requirement.

---

## Phase 5: Metrics dashboard

Phase 5 adds a metrics JSONL log (`RLM_METRICS_FILE`, default: `~/.local/share/rlm-hook/metrics.jsonl`). One JSON line per hook outcome captures latency, cache status, mode, and token counts. The bundled dashboard visualizes these metrics:

```bash
# Serve the dashboard
node bench/dashboard.mjs --serve

# Access at http://localhost:9876
```

**Metrics tracked:**

- `timestamp` — when the hook ran
- `latency_ms` — total hook runtime
- `cache_hit` — whether the cache was used
- `mode` — agentic, fast, or detailed
- `input_length` — character count of the prompt
- `output_length` — character count of the analysis
- `token_estimate` — estimated tokens used (if SDK mode)

The dashboard shows latency distribution, cache hit rate over time, and per-mode performance — useful for tuning timeouts, cache TTL, and mode selection.

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
