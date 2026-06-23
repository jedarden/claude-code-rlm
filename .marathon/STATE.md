# Marathon State — claude-code-rlm

## Last completed

**Phase 3, Unit 3 (`.embedding` cache writes) — commit 5c76192.** Added `embeddingPath(key)` (`<cacheDir>/<key>.embedding`) and `saveCacheEmbedding(key, text, {embedImpl=embedText})` to the SEMANTIC CACHE section (after `cosineSimilarity`, before RESPONSE PARSING). Behavior: returns `false` immediately doing **zero I/O** when `!CONFIG.semanticCache` (default-off byte-identical); returns false + logs when no `CONFIG.embedApiKey`; else embeds `text`, writes the Float32Array as raw LE float32 bytes via `Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)` to a pid-scoped `.tmp` then atomic `rename` (same pattern as `saveCache`). **Best-effort:** whole body in try/catch — every failure (no key / embedText throw / write error) is swallowed + logged, returns false; the JSON entry is written first and independently so a bad embedding never breaks the cache write or hook. Wired into `main` as `await saveCacheEmbedding(cacheKey, userMessage);` immediately after `await saveCache(cacheKey, analysis);` (line ~1143). **Embeds `userMessage`** (raw user prompt, available identically at lookup time pre-truncation — Unit 4 must embed `userMessage` too for consistency). Group 16: 6 inlined tests (Buffer↔Float32Array round-trip exact; persisted file reads back; flag-off → no call/no file; no-key → no call/no file; thrown embedText swallowed + JSON untouched + no partial file; no leftover `.tmp`). Added `rename` to test imports. 153 unit tests green (was 147).

(Prior — Phase 3 Unit 2, commit 9c6030f: pure-math `cosineSimilarity(a,b)`, length-mismatch THROWS, zero-mag → 0, Group 15 7 tests. Unit 1, af5908f: 5 CONFIG flags + `embedText(text, apiKey, {fetchImpl=fetch, model, baseUrl})` → Float32Array, throws on every failure, Group 14 8 tests. Phase 2 COMPLETE, abe7313: Unit 7 integration SDK scenarios. Unit 6 58b466a: Group 13 `createAnthropicClient`/`routeSDK`. Unit 5 b5bfff8: `callHaikuAgenticSDK`/`dispatchAgenticTool`, Group 12. Unit 4 7d1da25: `callMessagesSDK`/`callHaikuDetailedSDK`, Group 11. Units 1-3 979e2b1: SDK v0.105.0 + `shouldUseSDK`/`extractSDKText`/`callHaikuFastSDK`, Group 10.)

## Current phase

Phase 3 — Semantic Caching (in progress; Units 1-3 done)

## Next unit

**Phase 3, Unit 4: semantic lookup on cache miss.** In `main`, the SHA-256 lookup is `checkCache(cacheKey)` at line ~1060; if it returns null AND `CONFIG.semanticCache` AND `CONFIG.embedApiKey`, fall through to a new `semanticLookup(queryText, queryCwd, {embedImpl, simImpl})`-style helper before invoking Haiku. Helper steps: embed the query (`embedText(userMessage, CONFIG.embedApiKey)` — embed `userMessage`, matching what Unit 3 stored), then enumerate `<hash>.embedding` files in `CONFIG.cacheDir` (use `readdir`; filter `.endsWith('.embedding')`), read each as raw bytes → `new Float32Array(buf.buffer, buf.byteOffset, buf.length/4)`, compute `cosineSimilarity` vs the query vec, track the best. If best ≥ `CONFIG.semanticThreshold` (default 0.92), load that hash's `<hash>.json` via `checkCache(hash)` (respects TTL + reuses parse) and return it as a hit; else null. **Caveats to handle:** (a) skip/guard length-mismatch throws from `cosineSimilarity` (wrap per-file in try/catch so one corrupt vector doesn't abort the scan); (b) embeddings are keyed by `userMessage` only but cache keys mix in cwd — a cross-cwd semantic hit is acceptable for now (note it), or optionally store a cwd sidecar later; (c) whole thing best-effort: any failure → fall through to Haiku, never throw. On a semantic hit, `log()` it and `console.log(formatOutput(...)); process.exit(0)` like the SHA hit path. Add Group 17 inlined tests: write 2-3 `.embedding` files + matching `.json`, query vec close to one → returns that entry; all below threshold → null; corrupt/short `.embedding` file is skipped not fatal; flag-off → null without scanning. Unit 5 then adds `cache/index.json` reverse index to avoid scanning every file.

## Known issues / blockers

None. Note: tests inline faithful copies of hook logic (no imports from `rlm-hook.mjs`, since it calls `main()` on load) — keep new SDK tests in that style. The loop runner writes to an untracked nested `.marathon/.marathon/logs/` dir; leave it untracked, do not commit it.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [x] Phase 2 — SDK-Direct Mode (COMPLETE)
- [ ] Phase 3 — Semantic Caching (Units 1-3 of 6 done)
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
