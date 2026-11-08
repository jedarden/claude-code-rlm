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

**Without RLM:** On an unfamiliar codebase, the main model may first read project files, find tests, and search for relevant symbols. A 10–20-call orientation pass is an illustrative scenario, not a measured baseline or a prediction for every prompt. The number of calls saved by this hook has not been measured here.

**With RLM:** Haiku can hand the main model a structured summary of relevant files, existing patterns, and recent changes. The main model may still need to inspect files and verify the summary; whether preresearch saves time depends on the task and hook latency.

**Smart skipping:** Trivial queries — `ls`, `/help`, short affirmatives, pure CLI commands — bypass the model call. The hook itself still takes time to run.

**Caching:** An identical prompt in the same working directory can reuse a SHA-256 keyed file-cache entry within its 1-hour TTL. Near-identical prompts require the optional semantic cache, which sends raw prompt text to an embeddings endpoint — see [Outbound data flow and privacy](docs/notes/architecture.md#outbound-data-flow-and-privacy) for exactly what leaves the machine. Cache hits avoid a model call; actual hook latency depends on the machine and session context (see [Latency profile](#latency-profile)).

**Model cost:** As a concrete [Claude API list-price example](https://platform.claude.com/docs/en/about-claude/pricing), Haiku 4.5 is $1/$5 per million input/output tokens, versus $3/$15 for Sonnet 4.5 and $5/$25 for Opus 4.5. Haiku's per-token rates are one-third or one-fifth of those rates at equal usage, not a guaranteed saving per task. Actual cost depends on model versions, token counts, caching, and billing route; the hook's extra Haiku call can outweigh any main-model savings.

---

## Example output

The hook injects a structured analysis block before your prompt reaches the main model. In agentic mode (default), the output includes pretty-printed JSON followed by a plain-text summary:

Agentic Read, Glob, and Grep are limited to the hook's project directory (`cwd`) in both CLI and SDK modes. Paths that leave the project, including symlinks to outside files, are rejected. CLI recursive searches are denied if their search tree contains an outward symlink; SDK Glob skips symlinks. The CLI check runs before each tool call, so a project writable by an untrusted process during the call is outside this boundary's trust model. Read-only Git commands have a separate allowlist.

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

> **Billing:** SDK-Direct mode requires an **Anthropic Console API key** and is billed
> **pay-per-token** to your Console workspace. A Claude Pro/Max/Ultra subscription
> cannot be used — subscription credentials authenticate only the `claude` CLI, never
> direct SDK/API calls (verified against Anthropic's docs, 2026-11-08; details in
> `docs/notes/architecture.md`). Note also that with `ANTHROPIC_API_KEY` set, Claude
> Code itself prefers that key over a subscription login in `-p` mode — so the hook's
> *fallback subprocess runs* are pay-per-token too while the key is in the hook's
> environment. Without a usable key the hook logs the reason and falls back to the
> subprocess path automatically; the conversation is never blocked.

> **Privacy:** SDK-Direct mode transmits the same payload as the subprocess path —
> your prompt plus gathered project context, and (in agentic mode) the contents of
> any project files Haiku reads. The default subprocess path makes the same
> transmission through the `claude` CLI. The full enumeration, including the
> optional semantic-cache call that sends raw prompt text to an embeddings
> endpoint, is in [Outbound data flow and privacy](docs/notes/architecture.md#outbound-data-flow-and-privacy).

If you skipped SDK installation during install, you can add it later:
```bash
npm install --prefix ~/.claude/hooks @anthropic-ai/sdk
```

**Disable without uninstalling:**
Set `RLM_ENABLED=false` (or `RLM_DISABLED=true`) in your environment — in your
shell profile, or in `~/.claude/settings.json` under `env`. This is a master
off switch checked before skip detection and every cache: the hook exits
immediately (~30ms), injects nothing, reads no cache, and never calls Haiku.
The installation itself is untouched, so `RLM_ENABLED=true` turns preresearch
back on instantly. `RLM_ENABLED` wins when both variables are set; only the
literal strings `true`/`false` are recognized, so a typo'd value falls back to
enabled rather than silently disabling the hook.

**Uninstall:**
```bash
bash uninstall.sh
```
Removes exactly what the installation created — the runtime files in
`~/.claude/hooks/`, the SDK dependencies it installed (only if that
`package.json` declares nothing but `@anthropic-ai/sdk`), the hook's
`UserPromptSubmit` registration in `~/.claude/settings.json`, and its cache
(`~/.cache/rlm-hook`) and logs (`~/.local/share/rlm-hook`). Other hooks,
unrelated settings, and any other `package.json` in the hooks directory are
preserved, a malformed `settings.json` is left untouched rather than
destroyed, and the script is safe to run repeatedly or when nothing is
installed. If a *project-level* `.claude/settings.json` also references the
hook, remove that entry by hand — the script only manages the user-level
`~/.claude/settings.json`.

---

## Configuration

All configuration is via environment variables. Set them in your shell profile or in `~/.claude/settings.json` under `env`.

```bash
# Master switch
RLM_ENABLED=true         # Master off switch: RLM_ENABLED=false disables all preresearch (default: true)
RLM_DISABLED=false       # Equivalent inverse switch: RLM_DISABLED=true also disables (RLM_ENABLED wins if both set)

# Mode selection
RLM_AGENTIC_MODE=true    # Enable codebase exploration with tools (default: true)
RLM_AGENTIC_MODE=false   # Fast analysis only
RLM_FAST_MODE=true       # Concise non-agentic analysis (default when agentic=false)

# Model tuning
RLM_MODEL=claude-haiku-4-5-20251001   # Which model to use for preresearch
RLM_TIMEOUT=60000                      # Total timeout in ms (default: 60s, must be < hook timeout in settings.json)
RLM_CACHE_TTL=3600                     # Cache TTL in seconds (default: 1h)
RLM_MIN_LENGTH=20                      # Skip inputs shorter than this (chars)
RLM_MAX_LENGTH=4000                    # Truncate inputs longer than this (chars)
RLM_MAX_TURNS=10                       # Max model turns in agentic mode

# Paths
RLM_CACHE_DIR=~/.cache/rlm-hook        # Cache directory
RLM_LOG_FILE=~/.local/share/rlm-hook/rlm-hook.log
RLM_METRICS_FILE=~/.local/share/rlm-hook/metrics.jsonl  # Phase 5: metrics JSONL for dashboard
RLM_DASHBOARD_HOST=127.0.0.1                 # Dashboard bind host; loopback by default

# Phase 2: SDK-Direct mode (alternative to subprocess)
RLM_USE_SDK=true                       # Use Anthropic SDK directly (requires ANTHROPIC_API_KEY)
ANTHROPIC_API_KEY=sk-ant-...           # Required when RLM_USE_SDK=true (Console key, pay-per-token — see "SDK-Direct mode" above)
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

Not every prompt benefits from preresearch. The hook detects and skips trivial inputs without a model call.

| Input type | Example | Reason skipped |
|---|---|---|
| Short (<20 chars) | `hi`, `sure`, `thx` | Not worth analyzing |
| Simple command | `ls`, `pwd`, `cat`, `echo`, `git status`, `npm`, `yarn` | Operational, not exploratory |
| Single-word response | `yes`, `no`, `ok`, `thanks`, `y`, `n` | Affirmation/negation, not a task |
| Slash command | `/help`, `/clear`, `/compact` | Claude Code meta-commands |
| Code-heavy paste | Input where >50% is code blocks with 2+ blocks | Prompt already carries its own context |

---

## Latency profile

| Scenario | Historical rough example | Notes |
|---|---|---|
| Skip (trivial query) | ~27 ms | No model call |
| SHA cache hit | ~37 ms | Avoids a model call; includes other hook work |
| Agentic mode (cache miss) | ~20 s | Exploration with tools |
| Fast mode (cache miss) | ~4 s | Analysis without exploration tools |

No reproducible end-to-end measurements are committed for these historical figures. They are **examples**, not service targets or expected results for a particular setup. In particular, the ~37 ms figure is not established by the committed [cache microbenchmark](bench/README.md), which times synthetic file reads and writes rather than a full hook invocation. The hook records total runtime as `latency_ms` in its [metrics log](#phase-5-metrics-and-dashboard); use cache-hit and mode fields from that log to measure your own distribution. Cache misses vary with model response time, tool calls, project size, and configuration. Hook time is on the prompt's critical path.

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

The hook rotates this file before an append would exceed 8 MiB, retaining three
backups (`metrics.jsonl.1` through `.3`). The dashboard, `bench/parse-log.mjs`,
and `rlm-hook.mjs --stats` aggregate the current file and all retained backups.
The oldest backup is discarded at the next rotation, so totals cover retained
history rather than all-time history. The error/debug log (`RLM_LOG_FILE`, default:
`~/.local/share/rlm-hook/rlm-hook.log`) rotates at 2 MiB with two backups.
An individual entry larger than its file limit is dropped. Existing oversized
files are trimmed to complete recent lines when first rotated. Writes to both
files remain best effort and cannot interrupt the hook.

```bash
# Serve the dashboard
node bench/dashboard.mjs --serve

# Access locally at http://127.0.0.1:9876
```

The server binds to `127.0.0.1:9876` by default, keeping prompt-derived
metrics local to the machine. To make it reachable from another host, set
`RLM_DASHBOARD_HOST` explicitly (for example, `RLM_DASHBOARD_HOST=0.0.0.0`);
that exposes intents, latencies, and token counts to the network, so protect
the port with an appropriate firewall or access-control boundary.

**Metrics tracked:**

- `timestamp` — when the hook ran
- `latency_ms` — total hook runtime
- `cache_hit` — whether the cache was used
- `mode` — agentic, fast, or detailed
- `input_len` — character count of the original prompt
- `token_estimate` — `{ input_tokens, output_tokens }` when usage is available;
  SDK runs use the provider's exact envelope, while text subprocess runs use
  the deterministic conservative estimate `ceil(characters / 4)` for the
  constructed Haiku prompt and raw CLI output. Exits that never receive a
  Haiku response (for example, a cache hit or pre-analysis skip) omit this
  field; unavailable usage never changes the hook's exit behavior.

The dashboard shows latency distribution, cache hit rate over time, per-mode performance, and estimated Haiku cost when token estimates are available — useful for tuning timeouts, cache TTL, mode selection, and spend.

### Observability content policy

The metrics file and `RLM_LOG_FILE` are observability artifacts, not transcript
or research archives. The hook persists only operational metadata: `input_len`
is a character count, while event/mode/cache/source/intent values are labels and
`token_estimate` contains numbers. Raw prompt text is never a metrics field.

Recent transcript turns and explored file contents are request context only. They
may be held in memory or sent to Haiku, but transcript excerpts, prompt text,
and file contents are not written to the metrics JSONL, the error log, or the
verbose log produced when `RLM_DEBUG=true`. Model-provided skip reasons are
discarded, and subprocess stderr is not persisted because it can echo request
or explored-file content. If a known sensitive value reaches an unavoidable
diagnostic path, it is replaced by a short SHA-256 marker and its length; log
messages are also bounded to 512 characters. The existing rotation limits bound
retention, and all writes remain best effort.

This policy covers the three observability files named above. The prompt-keyed
analysis cache and the temporary agentic scratch file are separate storage
surfaces with their own lifecycle.

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
4. **Haiku runs:** `claude --model $RLM_MODEL` is spawned with the five needed built-in tools and a `PreToolUse` guard that confines `Write` to its PID-scoped `.claude/rlm-scratch-{pid}.md` and Bash to the configured Git commands and scratch cleanup. A structured prompt instructs it to explore the codebase and write findings to that scratch file.
5. **Haiku explores:** Up to `RLM_MAX_TURNS` model turns, potentially using multiple tool calls per turn — globbing for relevant files, grepping for referenced symbols, reading key sections, checking `git log` for recent changes.
6. **Synthesis:** Haiku writes a JSON scratch file, then the hook formats it into the `<rlm_preresearch>` XML block and cleans up the scratch file.
7. **Injection:** The formatted block is printed to stdout. Claude Code injects it as a system-level prefix before the user's prompt reaches the main model.
8. **Error safety:** Any failure (timeout, API error, parse error) exits 0 with no output — the hook never blocks or corrupts a conversation.

---

## License

MIT. See [LICENSE](LICENSE).
