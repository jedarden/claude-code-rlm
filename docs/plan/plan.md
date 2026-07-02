# RLM Hook — Implementation Plan

## Overview

`claude-code-rlm` is a Claude Code `UserPromptSubmit` hook that runs Haiku before Opus/Sonnet to explore the codebase and inject structured context. The goal: give the more expensive model a head-start by front-loading file discovery, pattern identification, and intent classification into the cheaper, faster model.

## Architecture Summary

```
User submits prompt
       │
       ▼
UserPromptSubmit hook fires
       │
       ▼
rlm-hook.mjs
  ├── Skip detection (trivial inputs → exit 0)
  ├── Cache lookup (SHA-256 of message)
  ├── Project context gathering (project type, git state)
  ├── Haiku invocation (agentic or fast mode)
  │     ├── Agentic: Glob, Grep, Read, Write scratch, Bash(git)
  │     └── Fast: pure text analysis from initial context
  ├── Parse JSON response
  ├── Save to cache
  └── Output <rlm_preresearch>...</rlm_preresearch> block
       │
       ▼
Claude Code prepends RLM output to conversation
       │
       ▼
Opus/Sonnet sees: [RLM context] + [user prompt]
```

---

## Phase 1 — Core Hook (COMPLETE ✅) `[x]`

**Deliverables:**
- `rlm-hook.mjs`: main hook implementation
- `rlm-hook.sh`: thin bash wrapper
- `install.sh`: installation script
- `package.json`, `.gitignore`

**Features implemented:**
- `UserPromptSubmit` hook integration (stdin JSON → stdout context)
- Skip detection: short inputs, simple commands, code-heavy inputs
- SHA-256 caching with configurable TTL (`~/.cache/rlm-hook/`)
- Agentic mode: Haiku uses Glob/Grep/Read/Write/Bash(git) to explore codebase
- Fast mode: pure text analysis (~2–4s, no tool use)
- Detailed mode: verbose structured JSON with confidence/ambiguity fields
- Project context gathering: project type, tech stack, git branch/status, file list
- Conversation context: reads recent transcript turns
- Graceful degradation: always exit 0, log errors to `~/.local/share/rlm-hook/`
- JSON parsing fallbacks: direct parse → markdown code block → regex object match
- `--version` flag
- All config overridable via env vars (`RLM_*`)

**Key design decisions:** See `docs/notes/architecture.md`

---

## Phase 2 — SDK-Direct Mode (COMPLETE ✅) `[x]`

**Goal:** Bypass the `claude` subprocess and call the Anthropic API directly, reducing latency from ~4s to ~800ms.

**Requirements:**
- `ANTHROPIC_API_KEY` environment variable
- `@anthropic-ai/sdk` npm dependency
- Tool use loop implementation for agentic mode (the CLI handles this automatically; SDK requires explicit loop)

**Approach:**
1. Add `@anthropic-ai/sdk` as optional dependency
2. Add `RLM_USE_SDK=true` config flag
3. If `RLM_USE_SDK=true` and `ANTHROPIC_API_KEY` is set: use SDK path
4. Otherwise: fall back to subprocess path (current behavior)
5. Implement tool dispatch loop for SDK agentic mode:
   - Haiku returns `tool_use` blocks → execute tool → send `tool_result` → repeat
   - Use Node.js built-ins for Glob/Grep/Read (no subprocess needed for these)
   - Bash tools still need subprocess

**Expected latency:** ~800ms for fast mode, ~2–5s for agentic mode (no subprocess overhead, but tool calls still have I/O latency).

**Open questions:**
- Does the Max subscription expose an API endpoint, or is SDK mode only for pay-per-token accounts?
- Need to confirm model ID availability via SDK (vs CLI alias routing)

---

## Phase 3 — Semantic Caching (COMPLETE ✅) `[x]`

**Deliverables:**
- Embedding generation and cosine similarity scoring (`embedText`, `cosineSimilarity`)
- Sidecar `.embedding` files (Float32Array, raw binary)
- `index.json` reverse index with inline vectors for fast lookup
- File-scan fallback when index is missing/corrupt
- `semanticLookup` helper with threshold gating
- Integrated into `main()` after SHA-256 miss

**Features implemented:**
- Embedding via OpenAI-compatible endpoint (`RLM_EMBEDDING_ENDPOINT`, default OpenAI, keyed by `OPENAI_API_KEY`)
- Cosine similarity with dimension mismatch safety and zero-magnitude handling
- `index.json` design: inline `{dim, vec: Array.from(float32)}` per entry, single-read lookup, tolerant of absent/malformed index (falls back to file scan)
- Per-record `ts` stamping for accurate timestamping
- Threshold gating (default 0.92) with TTL validation
- Gated behind `RLM_SEMANTIC_CACHE=true`, default off

**Key design decision:** Inline vectors in `index.json` (single-read lookup) over key-list scan, with robust file-scan fallback when index is missing/corrupt.

**Test coverage:** Groups 14-18 (42 tests) covering embedding generation, similarity math, sidecar I/O, index read/write, and semantic lookup with fallback.

---

## Phase 4 — Conversation Context Awareness (COMPLETE ✅) `[x]`

**Goal:** Read the recent conversation transcript and skip redundant exploration by reusing prior RLM analysis when intent and files are unchanged.

**Deliverables:**
- `extractPriorRLMBlocks` — parse prior `<rlm_preresearch>`/`<rlm_analysis>` blocks from transcript text
- `classifyIntentLocal` — keyword-based intent classifier (code_writing, debugging, refactoring, architecture, learning, other)
- `intentsOverlap` — strict intent equality check
- `findReusablePriorBlock` — find most recent reusable block by intent + changed files
- `computeChangedFiles` — mtime-based file change detection with cwd resolution
- `findReusablePriorBlockWithMtime` — per-block mtime checking (handles timestamped blocks correctly)
- `extractPriorBlocksFromTranscript` — JSONL-aware wrapper that extracts per-record blocks
- `gatherConversationContext` extended to return `{messages, priorBlocks}`
- Early-exit wired into `main()` — reuse hits skip Haiku entirely

**Features implemented:**
- Intent classification via ordered keyword regexes (debugging → refactoring → code_writing → architecture → learning → other)
- Per-block timestamp tracking (`ts` stamped on extraction from each transcript record's timestamp)
- Mtime-based file change detection (relative paths resolved under cwd, strict `>` comparison)
- Per-block changed-file computation (each block carries its own timestamp)
- Best-effact early-exit: any failure falls through to normal Haiku exploration
- Continuation marker: `[Continuing from prior pre-research — files unchanged since last turn]` prepended to reused analysis
- Configurable via `RLM_CONTEXT_WINDOW` (default 5 turns)

**Key design decision:** Per-record timestamping (option a from plan) — each extracted block carries the `ts` from its transcript record, enabling accurate per-block mtime checks. The cheap keyword classifier fires on the current turn (option a) so early-exit can trigger immediately.

**Test coverage:** Groups 19-23 (62 tests) covering block extraction, intent classification, overlap detection, reuse logic, mtime change detection, per-block timestamping, JSONL transcript parsing, and main() early-exit behavior.

---

## Phase 5 — Metrics Dashboard (COMPLETE ✅) `[x]`

**Goal:** Understand hook performance in production: hit rate, skip rate, latency distribution, model cost.

**Deliverables:**
- `appendMetric` — bullet-proof JSONL append to `~/.local/share/rlm-hook/metrics.jsonl`
- `recordMetric` — sugar for recording events with latency, mode, input_len, cache_hit, and extras
- `currentMode` — returns current mode (agentic/fast/detailed)
- Metrics wired at every `main()` exit (skip, cache_hit SHA/semantic, context_reuse, haiku_skip, complete, error)
- `bench/parse-log.mjs` — JSONL parser + per-UTC-day aggregation with nearest-rank percentiles
- `bench/dashboard.mjs` — static HTML render + `--serve` HTTP server on port 9876
- Configurable via `RLM_METRICS_FILE`

**Features implemented:**
- JSONL format (one JSON object per line, never throws on parse errors)
- Event taxonomy extended beyond the original 4: `skip`, `cache_hit` (SHA/semantic source), `context_reuse`, `haiku_skip`, `complete`, `error`
- Canonical `cache_hit` boolean (true for cache_hit + context_reuse) for hit-rate calculations
- Latency distribution: p50/p95/p99/min/max over `latency_ms` field
- Per-UTC-day buckets with `overall` rollup
- Skip-reason and mode breakdowns
- Dashboard: summary cards, per-day table, skip-reason table, events table, modes table
- XSS-safe HTML rendering (all interpolated text escaped)
- Null-handling: renders as `—`, never the string "null"
- Static HTML render (`--out <path>`) or live HTTP server (`--serve`, `--port N`)

**Deviations from plan:**
- Event taxonomy richer than planned (adds semantic source, context_reuse, haiku_skip, complete for better breakdown)
- Embeddings use OpenAI-compatible endpoint keyed by `OPENAI_API_KEY` (not hard-coded to OpenAI)

**Test coverage:** Groups 24-26 (34 tests) covering metric append/shaping, JSONL parsing, aggregation math, percentile calculation, and HTML rendering.

---

## Open Questions

### Resolved during implementation

1. **Scratch file location (SDK path)**: RESOLVED — Phase 2 SDK mode uses a pid-scoped temp file (`/tmp/rlm-scratch-<pid>.md`) to avoid conflicts. Still open for the CLI subprocess path (currently uses `.claude/rlm-scratch.md`).
2. **Block timestamp tracking (Phase 4)**: RESOLVED — per-record timestamping (option a). Each extracted block carries the `ts` from its transcript record, enabling accurate per-block mtime checks via `computeChangedFiles`.
3. **Index design (Phase 3)**: RESOLVED — inline vectors in `index.json` with file-scan fallback. Single-read lookup for speed; absent/corrupt index degrades gracefully to per-file `.embedding` scan.

### Still open

4. **Max turns in agentic mode**: 10 turns is a guess. Does it reliably finish exploration within that budget for large codebases? Needs empirical testing.
5. **Multi-project sessions**: When `cwd` changes between turns (user switches projects), the cache should be invalidated or keyed differently.
6. **Cost tracking**: Each agentic run consumes Haiku tokens. With 10 turns of tool calls, estimated ~2K–10K input tokens and ~500–2K output tokens per run. Need to measure actual usage.
7. **Race conditions**: If the user submits two prompts rapidly, two hook invocations run concurrently. Cache writes are not atomic — last writer wins. Acceptable for now; use a lock file in Phase 3+ if needed.
