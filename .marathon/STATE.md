# Marathon State — claude-code-rlm

## Last completed

**Phase 3, Unit 2 (`cosineSimilarity`) — commit 9c6030f.** Added pure-math `cosineSimilarity(a, b)` in the `SEMANTIC CACHE` section right after `embedText` (before RESPONSE PARSING). `(a·b)/(‖a‖·‖b‖)` via one loop accumulating dot/magA/magB; accepts Float32Array or plain number arrays. **Edge-case contract (decided + documented):** length mismatch → THROWS (`length mismatch (N vs M)` — embeddings are fixed-dim, so unequal lengths signal a corrupt/foreign vector, fail loudly); either zero-magnitude → returns `0` (angle undefined; 0 stays below any positive threshold, no NaN). No deps. Group 15: 7 inlined tests (identical→1, orthogonal→0, opposite→-1, hand-computed pair [1,2,3]·[4,5,6]=0.9746318461970762 @1e-12, zero-vector guard, length-mismatch throw, Float32Array inputs). 147 unit tests green (was 140).

(Prior — Phase 3 Unit 1, commit af5908f: 5 CONFIG flags (`semanticCache`/`semanticThreshold` 0.92/`embedModel` text-embedding-3-small/`embedApiKey` OPENAI_API_KEY/`embedBaseUrl`) + `embedText(text, apiKey, {fetchImpl=fetch, model, baseUrl})` POSTing to OpenAI `${baseUrl}/embeddings`, returns Float32Array, throws on every failure so cache degrades to SHA-256. Group 14: 8 tests via `makeFakeFetch`. Phase 2 COMPLETE, abe7313: Unit 7 integration SDK scenarios. Unit 6 58b466a: Group 13 `createAnthropicClient`/`routeSDK`. Unit 5 b5bfff8: `callHaikuAgenticSDK`/`dispatchAgenticTool`, Group 12. Unit 4 7d1da25: `callMessagesSDK`/`callHaikuDetailedSDK`, Group 11. Units 1-3 979e2b1: SDK v0.105.0 + `shouldUseSDK`/`extractSDKText`/`callHaikuFastSDK`, Group 10.)

## Current phase

Phase 3 — Semantic Caching (in progress; Units 1-2 done)

## Next unit

**Phase 3, Unit 3: extend cache writes to also emit `<hash>.embedding` (binary float32).** Find the existing cache-write path (Group 7 covers cache file ops; look for where the `<sha256>.json` entry is persisted — grep `writeCache`/`cacheDir`/`.json` write in `rlm-hook.mjs`). When `CONFIG.semanticCache` is on AND an embedding API key is available, after writing the JSON entry also compute `embedText(prompt, CONFIG.embedApiKey)` and persist the returned `Float32Array` as a sibling `<hash>.embedding` file written as raw bytes (`Buffer.from(vec.buffer)` / `fs.writeFile`). Must be best-effort: wrap in try/catch and `log()` on failure — a failed embedding write must NEVER break the cache write or the hook (embedText already throws on every failure mode, so catch it here). Gate entirely behind `CONFIG.semanticCache` so default-off behavior is byte-identical to today. Add inlined tests (new Group 16): round-trip a Float32Array through `Buffer.from(vec.buffer)` → `new Float32Array(buf.buffer, buf.byteOffset, buf.length/4)` and assert values survive; assert the `.embedding` file is only written when the flag is on; assert a thrown embedText is swallowed (cache write still succeeds). Keep helpers inlined in the test file (no imports). Run `node --test test/unit.test.mjs`. Then Unit 4 implements semantic lookup on cache miss (load `.embedding` files, `cosineSimilarity` vs query, return best match ≥ `CONFIG.semanticThreshold`).

## Known issues / blockers

None. Note: tests inline faithful copies of hook logic (no imports from `rlm-hook.mjs`, since it calls `main()` on load) — keep new SDK tests in that style. The loop runner writes to an untracked nested `.marathon/.marathon/logs/` dir; leave it untracked, do not commit it.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [x] Phase 2 — SDK-Direct Mode (COMPLETE)
- [ ] Phase 3 — Semantic Caching
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
