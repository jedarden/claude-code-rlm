# Marathon State — claude-code-rlm

## Last completed

**Phase 3, Unit 5 (`index.json` reverse index) + Unit 6 (test coverage) — commit ce945e6. PHASE 3 COMPLETE.** Added three helpers to the SEMANTIC CACHE section (after `embeddingPath`, before `saveCacheEmbedding`): `indexPath()` → `<cacheDir>/index.json`; `readCacheIndex()` → parses index.json, returns `{}` on absent/malformed/non-object-or-array root, **never throws**; `updateCacheIndex(key, vec)` → best-effort upsert `index[key] = { dim, vec: Array.from(vec) }`, atomic tmp+rename, **gated on `CONFIG.semanticCache` (zero I/O off)**, whole body try/catch → false on failure (an index failure must never break the embedding write). **Decision taken: inline vectors** (single-read lookup) over key-list. Wired `await updateCacheIndex(key, vec)` into `saveCacheEmbedding` right after the `.embedding` rename. **Refactored `semanticLookup`** into two extracted scorers each returning `{bestKey,bestScore}|null`: `scoreFromIndex(queryVec, simImpl)` (reads index.json once, `Float32Array.from(entry.vec)`, per-entry try/catch skips foreign-dim, returns null if index empty/no-usable-vector) and `scoreFromFiles(queryVec, simImpl)` (the prior per-file `.embedding` scan, unchanged, the robust fallback). New body: embed query → `best = scoreFromIndex(...) ?? scoreFromFiles(...)` → if null log "no candidate embeddings" → threshold check → `checkImpl(bestKey)` (TTL/parse, gone→miss) → hit. `.embedding` files stay the **source of truth**, so absent/empty/corrupt index degrades to file scan; index just lags-but-self-heals (last-writer-wins race accepted per plan). Group 18: 10 inlined tests via `semanticLookupIndexed` + faithful helper copies (upsert round-trip w/ float32 tolerance; multi-key accumulate; same-key overwrite; off-gating no-write; readCacheIndex {} for absent/malformed/array; index-only nearest with ZERO `.embedding` files present; corrupt index→file-scan fallback; absent index→file-scan fallback; below-threshold miss; foreign-dim index entry skipped). **Unit 6 satisfied by existing tests:** similarity-math=Group 15, threshold-gating=Groups 17+18, index-read/write=Group 18. 171 unit tests green (was 161).

(Prior — Phase 3 Unit 4, commit dd02deb: `semanticLookup` file-scan on SHA-256 miss, zero-I/O when flag/key off, per-file + top-level try/catch, wired into `main` after SHA miss, Group 17 8 tests. Unit 3 5c76192: `embeddingPath`/`saveCacheEmbedding` raw-float32 sidecar, Group 16 6 tests. Unit 2 9c6030f: `cosineSimilarity`, length-mismatch THROWS, zero-mag→0, Group 15 7 tests. Unit 1 af5908f: 5 CONFIG flags + `embedText`→Float32Array, Group 14 8 tests. Phase 2 COMPLETE abe7313. Phase 1 COMPLETE.)

## Current phase

Phase 4 — Conversation Context Awareness (not started)

## Next unit

**Phase 4, Unit 1: extract prior `<rlm_preresearch>` blocks from the transcript.** Phase 4 (Conversation Context Awareness) is "always on (transparent optimization)" per the marathon instructions — no env gate to enter the phase, but Unit 4 adds `RLM_CONTEXT_WINDOW` (default 5) for look-back depth. Start with extraction: extend `gatherConversationContext` (find it in `rlm-hook.mjs` — it already reads `transcript_path`) to parse prior assistant/user turns' injected `<rlm_preresearch>…</rlm_preresearch>` blocks out of the transcript JSONL and pull `relevant_files` + `intent` from each. The hook's own output format is built by `formatOutput` — check exactly what tag/shape it emits (likely a fenced block or `<rlm_preresearch>` wrapper with a JSON body or labeled fields) so the extractor's regex/parse matches what was actually written in earlier turns. Build a small `extractPriorRLMBlocks(transcriptText, {window=CONFIG.contextWindow})` returning an array of `{ intent, relevant_files, ts? }` newest-first, capped to the look-back window. Keep it pure/string-in → array-out so it unit-tests cleanly (Group 19): block present → parsed; multiple blocks → newest-first + windowed; malformed/absent block → `[]`; non-RLM turns ignored. Then Units 2-3 (intent-overlap early-exit + mtime tracking), Unit 4 (`RLM_CONTEXT_WINDOW` CONFIG flag), Unit 5 (remaining tests). Read the plan's Phase 4 section (docs/plan/plan.md ~line 117) and the existing `gatherConversationContext`/`formatOutput`/`buildRLMPrompt` before writing — match the real tag the hook emits, don't assume.

## Known issues / blockers

None. Note: tests inline faithful copies of hook logic (no imports from `rlm-hook.mjs`, since it calls `main()` on load) — keep new SDK tests in that style. The loop runner writes to an untracked nested `.marathon/.marathon/logs/` dir; leave it untracked, do not commit it.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [x] Phase 2 — SDK-Direct Mode (COMPLETE)
- [x] Phase 3 — Semantic Caching (COMPLETE — Units 1-6)
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
