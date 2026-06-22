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

## Phase 2 — SDK-Direct Mode `[ ]`

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

## Phase 3 — Semantic Caching `[ ]`

**Goal:** Cache hits based on semantic similarity, not exact SHA-256 match. Two prompts that are 90% similar should reuse the same analysis.

**Approach:**
- Embed user messages using a local or API-based embedding model
- Store embeddings alongside cache entries
- On cache lookup: compute similarity against cached embeddings, return best match if similarity > threshold (e.g., 0.92)
- Candidate models: `text-embedding-3-small` (API), `nomic-embed-text` (local via Ollama)

**Implementation sketch:**
```
cache/
  <sha256>.json          ← exact-match cache (current)
  <sha256>.embedding     ← float32 embedding vector
  index.json             ← lightweight ANN index (cosine similarity)
```

**Tradeoffs:**
- Adds ~100–200ms for embedding lookup
- Requires embedding API or local model
- Index needs compaction as cache grows
- High-similarity threshold required to avoid injecting stale/wrong context

**Recommendation:** Gate behind `RLM_SEMANTIC_CACHE=true`. Default off until embedding latency and quality are validated.

---

## Phase 4 — Conversation Context Awareness `[ ]`

**Goal:** Read the recent conversation transcript and use it to skip redundant exploration. If Haiku explored `src/auth/` two turns ago and the user is still working on auth, don't re-explore.

**Approach:**
1. Extend `gatherConversationContext` to extract prior RLM outputs from the transcript
2. If a recent `<rlm_preresearch>` block exists and covers overlapping intent/files:
   - Skip re-exploration
   - Inject a lightweight "continuing from prior analysis" block instead
3. Track which files were already read in the session to avoid re-reading unchanged files

**Implementation:**
- Parse `transcript_path` for `<rlm_preresearch>` blocks in recent turns
- Extract `relevant_files` and `intent` from prior blocks
- If current prompt intent matches prior intent (same root task), reuse + extend
- If intent diverges (new task), run full exploration

**Expected benefit:** Eliminate ~80% of re-exploration in multi-turn coding sessions on the same task.

---

## Phase 5 — Metrics Dashboard `[ ]`

**Goal:** Understand hook performance in production: hit rate, skip rate, latency distribution, model cost.

**Metrics to capture (append to log):**
```json
{"ts": 1234567890, "event": "cache_hit|cache_miss|skip|error", "latency_ms": 1234, "mode": "agentic|fast|detailed", "input_len": 234}
```

**Dashboard:**
- Static HTML generated from log file
- Shows: daily hit rate, latency P50/P95/P99, skip reasons, error rate
- Served locally: `node bench/dashboard.mjs --serve` → `http://localhost:9876`

**Implementation:**
- Structured JSON log format (one entry per line, JSONL)
- `bench/parse-log.mjs`: parse log → aggregate metrics
- `bench/dashboard.mjs`: render HTML dashboard, optionally serve
- No external dependencies (use Node built-ins only)

---

## Open Questions

1. **Max turns in agentic mode**: 10 turns is a guess. Does it reliably finish exploration within that budget for large codebases? Needs empirical testing.
2. **Scratch file location**: `.claude/rlm-scratch.md` could conflict if the user already has a file there. Consider a temp path like `/tmp/rlm-scratch-<pid>.md`.
3. **Multi-project sessions**: When `cwd` changes between turns (user switches projects), the cache should be invalidated or keyed differently.
4. **Cost tracking**: Each agentic run consumes Haiku tokens. With 10 turns of tool calls, estimated ~2K–10K input tokens and ~500–2K output tokens per run. Need to measure actual usage.
5. **Race conditions**: If the user submits two prompts rapidly, two hook invocations run concurrently. Cache writes are not atomic — last writer wins. Acceptable for now; use a lock file in Phase 3+ if needed.
