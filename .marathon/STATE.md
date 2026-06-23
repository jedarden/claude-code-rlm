# Marathon State — claude-code-rlm

## Last completed

**Phase 2, Unit 7 (integration SDK scenario) — commit abe7313. PHASE 2 COMPLETE.** Added a `SDK-Direct mode` describe block (3 scenarios) to `test/integration.test.mjs`, following the existing fake-`claude`-on-PATH spawn harness (no stub-injection of the bare ESM `@anthropic-ai/sdk` specifier — that's awkward to mock from a subprocess; chose the robustness contract instead). Scenarios: (1) **fast SDK path** — `RLM_USE_SDK=true` + fake `ANTHROPIC_API_KEY` + unreachable `ANTHROPIC_BASE_URL=http://127.0.0.1:1` → SDK call fails (ECONNREFUSED, retries exhaust ~1.6s) → `main()` falls through to the fake-claude subprocess → exit 0 + output contains `code_writing`; (2) **agentic SDK path** — same with `RLM_AGENTIC_MODE=true`, graceful fallback; (3) **SDK enabled but no key** — `ANTHROPIC_API_KEY=''` → `shouldUseSDK()` false → straight to subprocess, *zero* SDK attempt (returns in ~150ms, proving the routing guard). Failures are forced deterministically and network-independently via the unreachable base URL — no real API/network. No `cwd` passed → no stray scratch files. 15 integration tests green (was 12); 132 unit tests still green.

(Prior — Unit 6, commit 58b466a: Group 13 SDK seam tests — `createAnthropicClient` importer injection + `routeSDK` decision-tree model, 132 unit tests. Unit 5, commit b5bfff8: `callHaikuAgenticSDK` tool-use loop + `dispatchAgenticTool` + dependency-free tools, Group 12. Unit 4, commit 7d1da25: `callMessagesSDK` core + `callHaikuDetailedSDK`, Group 11. Units 1+2+3, commit 979e2b1: installed `@anthropic-ai/sdk` v0.105.0; SDK config + `shouldUseSDK`/`extractSDKText`/`createAnthropicClient`/`callHaikuFastSDK`, Group 10.)

## Current phase

Phase 3 — Semantic Caching (starting; Phase 2 done)

## Next unit

**Phase 3, Unit 1: `embedText(text, apiKey)`.** Add an embedding helper that calls `text-embedding-3-small` and returns a `Float32Array`. Gate the whole feature behind `RLM_SEMANTIC_CACHE === 'true'` (new CONFIG flag) and add `RLM_SEMANTIC_THRESHOLD` (default `0.92`) to CONFIG now too. Implementation note: `text-embedding-3-small` is an **OpenAI** model — the Anthropic SDK does not expose it. Re-check the plan (`docs/plan/plan.md`, Phase 3) for the intended embedding provider; if it expects OpenAI, embed via a small `fetch` to the OpenAI embeddings endpoint using `OPENAI_API_KEY` (or whatever the plan names), with a subprocess/`fetch` fallback and a clean throw-on-failure so the cache layer degrades to plain SHA-256 lookup (never breaks the hook). Keep the function injectable (accept an optional fetch/client arg) so unit tests can mock it without network — mirror the SDK units' injectable-seam style. Then Unit 2 is the pure `cosineSimilarity(a, b)` (easy, no deps, test first if simpler). Tests stay inlined (no imports from `rlm-hook.mjs`). Run `node --test test/unit.test.mjs`.

## Known issues / blockers

None. Note: tests inline faithful copies of hook logic (no imports from `rlm-hook.mjs`, since it calls `main()` on load) — keep new SDK tests in that style. The loop runner writes to an untracked nested `.marathon/.marathon/logs/` dir; leave it untracked, do not commit it.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [x] Phase 2 — SDK-Direct Mode (COMPLETE)
- [ ] Phase 3 — Semantic Caching
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
