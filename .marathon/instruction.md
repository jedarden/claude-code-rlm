# claude-code-rlm — Marathon Iteration Instructions

You are an autonomous coding agent implementing **claude-code-rlm**, a `UserPromptSubmit` hook for Claude Code. This file is re-read at the start of every iteration. Do **one focused unit of work**, verify it, commit it, then stop. The loop will call you again.

## Ground truth — read these every iteration

- Repo root: `/home/coding/claude-code-rlm` — cd there first.
- Plan: `docs/plan/plan.md` — authoritative spec for all phases.
- Progress journal: `.marathon/STATE.md` — your only memory across iterations.
- Done sentinel: `.marathon/DONE` — if this file exists, go to "Completion" below.

## Iteration protocol

Each iteration, do exactly this:

1. **Orient.** `cd /home/coding/claude-code-rlm`. Check for `.marathon/DONE`. Read `.marathon/STATE.md` and `git log --oneline -10`. Skim the relevant phase section in `docs/plan/plan.md`.
2. **Pick the next smallest valuable unit** that moves the project forward, following phase order (Phase 2 → 3 → 4 → 5). A unit is one function, one module, one test group — not a whole phase.
3. **Implement it** faithfully to the plan.
4. **Verify.** Run `node --test test/unit.test.mjs`. It must pass before you commit. If you broke existing tests, fix them before committing — never leave the suite red.
5. **Commit.** `git add` specific files, commit with a conventional message (`feat(phase2): …`, `fix: …`, `test: …`), then `git push origin main`.
6. **Update `.marathon/STATE.md`:** replace the "Last completed" and "Next unit" sections with what you did and what comes next. Keep the phase checklist current.
7. **Stop.** Don't chain multiple units. Trust the loop.

## Phase order and implementation guidance

### Phase 2 — SDK-Direct Mode

**Goal:** Replace `claude` subprocess calls with direct `@anthropic-ai/sdk` calls. Target: ~800ms for fast mode, ~2–5s for agentic mode.

**Units (implement in order):**
1. Install `@anthropic-ai/sdk` via `npm install @anthropic-ai/sdk`. Commit `package.json` + `package-lock.json`.
2. Add `RLM_USE_SDK` env var detection at the top of `rlm-hook.mjs`. If `RLM_USE_SDK=true` and `ANTHROPIC_API_KEY` is set, use SDK path; else fall back to subprocess (existing behavior unchanged).
3. Implement `callHaikuFastSDK(prompt, apiKey)` — single-turn SDK call with no tools. Returns parsed JSON. Start here before agentic.
4. Implement `callHaikuDetailedSDK(prompt, apiKey)` — same shape, verbose JSON.
5. Implement `callHaikuAgenticSDK(prompt, apiKey, cwd)` — tool-use loop. Haiku may return `tool_use` blocks; dispatch each tool (Glob→`fs.glob`/`glob`, Grep→child_process grep, Read→`fs.readFile`, Write→scratch file, Bash(git:*)→child_process). Send `tool_result` back. Loop until `stop_reason !== 'tool_use'`. Cap at `RLM_MAX_TURNS` (default 10).
6. Unit tests: mock `@anthropic-ai/sdk` (inject a fake constructor via env/module isolation). Test: SDK path selected when vars set, fast/detailed/agentic SDK paths return correct shapes, tool dispatch loop handles multi-turn, SDK errors fall back gracefully.
7. Integration test: add SDK scenario (fake SDK binary or env-based mock).

**Note on tool implementations for SDK agentic mode:**
- `Glob` → use `node:fs` glob (Node 22+) or a simple recursive `readdir`. Keep it dependency-free.
- `Grep` → `child_process.execSync('grep ...')` is fine.
- `Read` → `fs.readFileSync`.
- `Write` → write to `.claude/rlm-scratch-<pid>.md` (fixes the scratch file collision open question).
- `Bash(git:*)` → allow only `git ...` commands, spawn via child_process.

### Phase 3 — Semantic Caching

**Goal:** Cache by cosine similarity (~0.92 threshold), not just SHA-256. Gate: `RLM_SEMANTIC_CACHE=true`.

**Units (implement in order):**
1. Add embedding function `embedText(text, apiKey)` — calls `text-embedding-3-small` via SDK (or subprocess if SDK unavailable). Returns `Float32Array`.
2. Implement cosine similarity: `cosineSimilarity(a, b)` — pure math, no deps.
3. Extend cache write: when saving a new cache entry, also write `<hash>.embedding` (binary float32).
4. Implement semantic lookup: on cache miss, load all `.embedding` files, compute similarity against query embedding, return best match if above threshold (env `RLM_SEMANTIC_THRESHOLD`, default 0.92).
5. Write `cache/index.json` as a lightweight reverse index (hash → embedding path) to avoid scanning all files.
6. Unit tests: similarity math correctness, threshold gating, index read/write.

### Phase 4 — Conversation Context Awareness

**Goal:** Skip re-exploration when recent transcript already covered the same intent/files. Gate: always on (transparent optimization).

**Units (implement in order):**
1. Extend `gatherConversationContext` to extract prior `<rlm_preresearch>` blocks from the transcript JSONL (parse `relevant_files` and `intent` from prior turns).
2. Implement intent overlap detection: if current prompt intent classification overlaps with a prior block's intent AND files haven't changed since, return early with a lightweight "continuing" block.
3. Track file mtimes for files referenced in prior RLM outputs — skip re-read if unchanged.
4. Add `RLM_CONTEXT_WINDOW` env var (default 5 — how many prior turns to look back).
5. Unit tests: prior block extraction from transcript, overlap detection, mtime tracking, early-exit path.

### Phase 5 — Metrics Dashboard

**Goal:** JSONL metrics log + static HTML dashboard.

**Units (implement in order):**
1. Add metrics append call at hook exit: write one JSON line to `~/.local/share/rlm-hook/metrics.jsonl` with `{ts, event, latency_ms, mode, input_len, cache_hit}`.
2. Write `bench/parse-log.mjs`: read metrics JSONL, aggregate daily stats (hit rate, skip rate, P50/P95/P99 latency, error rate).
3. Write `bench/dashboard.mjs`: generate static HTML from aggregated stats. `--serve` flag opens local server on port 9876.
4. Unit tests: log append, JSONL parsing, aggregation math.

## Test gate

`node --test test/unit.test.mjs` must pass before every commit. If you add new test files, run them too. Integration tests (`RUN_INTEGRATION_TESTS=1 node --test test/integration.test.mjs`) are bonus — run when you touch integration-relevant paths.

## Git rules

- Push to `origin` (Forgejo) after every commit — `git push origin main`.
- Never force-push.
- Never amend published commits.
- Commit only specific files — no `git add .` blunderbuss.

## Anti-stuck rules

- If a unit is blocked (e.g. `node:fs` glob unavailable on this Node version), pick a concrete workaround (recursive readdir), implement it, and move on. Note the workaround in STATE.md.
- If unit tests break and you can't fix within the iteration, `git checkout -- <files>` to revert and note the blocker in STATE.md. Never commit a red suite.
- Keep each iteration to one coherent unit. Don't let "just one more thing" turn into a multi-hour sprawl.

## Completion

When all five phases are complete and `node --test test/unit.test.mjs` is green:

1. Write `/home/coding/claude-code-rlm/.marathon/DONE` with a short summary (what was built, test count, any remaining open questions from the plan).
2. Commit `.marathon/DONE` and `.marathon/STATE.md`.
3. Push.
4. Stop.

On any future iteration where `.marathon/DONE` exists: run `node --test test/unit.test.mjs` to confirm still green (fix regressions if any), then exit. Do not start new work.

---

Begin now: orient, read STATE.md, pick the next unit, implement, test, commit, push, update STATE, stop.
