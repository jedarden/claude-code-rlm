# Marathon State — claude-code-rlm

## Last completed

**Phase 2, Unit 6 (broader SDK unit tests + hardening) — commit 58b466a.** Added Group 13 (10 tests) covering the SDK seams Groups 10–12 left open. Faithfully inlined `createAnthropicClient(apiKey, importer=(m)=>import(m))` (importer injectable so the lazy-import seam is testable) and a `routeSDK(cfg, impls)` model that mirrors `main()`'s three-branch decision tree (fast/detailed SDK → agentic SDK → subprocess) with the two `response === null && …` guards. Tests: (1) `createAnthropicClient` threads `apiKey` into the SDK constructor on success; (2) a missing SDK rejects with a catchable error (→ `main()` falls back); (3) `extractSDKText` on a realistic agentic final turn (text + tool_use mixed) yields only the joined text and `parseHaikuResponse` decodes it; (4–9) routing: non-agentic SDK success short-circuits agentic+subprocess, detailed mode picks `detailedSDK`, non-agentic SDK error → subprocess (agentic skipped), agentic SDK success skips subprocess, agentic SDK error → subprocess, no-key → straight to subprocess with zero SDK calls; (10) the `response === null` guard predicates block both the agentic SDK and the subprocess once a response is populated. 132 unit tests green (was 122).

(Prior — Unit 5, commit b5bfff8: `callHaikuAgenticSDK` tool-use loop + `dispatchAgenticTool` + dependency-free Glob/Grep/Read/Write/Bash tools + `main()` agentic SDK branch, Group 12. Unit 4, commit 7d1da25: `callMessagesSDK` core + `callHaikuDetailedSDK`, Group 11. Units 1+2+3, commit 979e2b1: installed `@anthropic-ai/sdk` v0.105.0; SDK config + `shouldUseSDK`/`extractSDKText`/`createAnthropicClient`/`callHaikuFastSDK`, Group 10.)

## Current phase

Phase 2 — SDK-Direct Mode (Units 1–6 done; Unit 7 remains)

## Next unit

**Phase 2, Unit 7: integration SDK scenario.** Extend `test/integration.test.mjs` with an SDK-path scenario. The hook lazily does `import('@anthropic-ai/sdk')`, so the cleanest fakes are: (a) run the hook subprocess with `RLM_USE_SDK=true` + a fake `ANTHROPIC_API_KEY` and assert it gracefully falls back to the subprocess path when the real SDK call fails (no key that works) — i.e. the hook still exits 0 and emits no `<rlm_preresearch>` garbage; or (b) inject a stub `@anthropic-ai/sdk` module via `NODE_PATH`/a temp `node_modules` so the SDK call returns canned JSON and assert `<rlm_preresearch>` is produced from it. Prefer (a) for robustness (no real network), and add (b) only if a clean stub-injection harness is easy. First read `test/integration.test.mjs` to match its existing subprocess-spawn harness style (it uses a fake `claude` binary on PATH). Run `RUN_INTEGRATION_TESTS=1 node --test test/integration.test.mjs`. Completing Unit 7 finishes Phase 2 → flip the Phase 2 checkbox to `[x]` and start Phase 3 (semantic caching: `embedText`, `cosineSimilarity`, embedding cache writes, semantic lookup, `cache/index.json`).

## Known issues / blockers

None. Note: tests inline faithful copies of hook logic (no imports from `rlm-hook.mjs`, since it calls `main()` on load) — keep new SDK tests in that style. The loop runner writes to an untracked nested `.marathon/.marathon/logs/` dir; leave it untracked, do not commit it.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [ ] Phase 2 — SDK-Direct Mode
- [ ] Phase 3 — Semantic Caching
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
