# Marathon State — claude-code-rlm

## Last completed

**Phase 3, Unit 1 (`embedText`) — commit af5908f.** Added 5 CONFIG flags after `sdkMaxTokens`: `semanticCache` (`RLM_SEMANTIC_CACHE === 'true'`, default off), `semanticThreshold` (`RLM_SEMANTIC_THRESHOLD`, default `0.92`, parsed with `parseFloat`), `embedModel` (`RLM_EMBED_MODEL`, default `text-embedding-3-small`), `embedApiKey` (`OPENAI_API_KEY`), `embedBaseUrl` (`RLM_EMBED_BASE_URL`, default `https://api.openai.com/v1`). Added new `SEMANTIC CACHE — EMBEDDINGS` section (after the agentic SDK section, before RESPONSE PARSING) with `embedText(text, apiKey, { fetchImpl = fetch, model, baseUrl })`. Decision per STATE note + plan: `text-embedding-3-small` is **OpenAI** (Anthropic SDK has no embeddings), so it POSTs to `${baseUrl}/embeddings` with `Authorization: Bearer <OPENAI_API_KEY>`, body `{model, input}`, returns `Float32Array.from(json.data[0].embedding)`. `fetchImpl` injected (defaults to global `fetch`, available on Node v20.19.2). **Throws on every failure mode** (no key, empty input, non-2xx, fetch reject, malformed body) so the cache layer (Unit 4) catches it and degrades to plain SHA-256 — hook never breaks. Group 14: 8 inlined tests (`makeFakeFetch` records url/init + canned Response). 140 unit tests green (was 132).

(Prior — Phase 2 COMPLETE, commit abe7313: Unit 7 integration SDK scenarios, 15 integration tests. Unit 6 (58b466a): Group 13 `createAnthropicClient` importer seam + `routeSDK`. Unit 5 (b5bfff8): `callHaikuAgenticSDK` tool-use loop + `dispatchAgenticTool`, Group 12. Unit 4 (7d1da25): `callMessagesSDK` + `callHaikuDetailedSDK`, Group 11. Units 1-3 (979e2b1): `@anthropic-ai/sdk` v0.105.0 + SDK config + `shouldUseSDK`/`extractSDKText`/`createAnthropicClient`/`callHaikuFastSDK`, Group 10.)

## Current phase

Phase 3 — Semantic Caching (in progress; Unit 1 done)

## Next unit

**Phase 3, Unit 2: `cosineSimilarity(a, b)`.** Pure math, no deps — `sum(a[i]*b[i]) / (||a|| * ||b||)`. Accept two `Float32Array`s (or arrays). Decide the contract on edge cases and test it: mismatched lengths → throw (or return 0 — pick one and document); a zero-magnitude vector → return 0 (avoid NaN from divide-by-zero). Add inlined tests (new Group 15): identical vectors → 1, orthogonal → 0, opposite → -1, a known hand-computed pair, the zero-vector guard, the length-mismatch contract. Keep it dependency-free and inline the copy in the test file (no imports from `rlm-hook.mjs`). Place the function in the SEMANTIC CACHE section right after `embedText`. Run `node --test test/unit.test.mjs`. Then Unit 3 extends cache writes to also emit `<hash>.embedding` (binary float32).

## Known issues / blockers

None. Note: tests inline faithful copies of hook logic (no imports from `rlm-hook.mjs`, since it calls `main()` on load) — keep new SDK tests in that style. The loop runner writes to an untracked nested `.marathon/.marathon/logs/` dir; leave it untracked, do not commit it.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [x] Phase 2 — SDK-Direct Mode (COMPLETE)
- [ ] Phase 3 — Semantic Caching
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
