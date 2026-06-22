# Marathon State — claude-code-rlm

## Last completed

**Phase 2, Unit 1+2+3 (fast SDK path) — commit 979e2b1.** Installed `@anthropic-ai/sdk` (v0.105.0; `package.json` + `package-lock.json` committed, `node_modules/` already gitignored). Added Phase 2 config to `rlm-hook.mjs`: `useSDK` (`RLM_USE_SDK=true`), `apiKey` (`ANTHROPIC_API_KEY`), `sdkMaxTokens` (`RLM_SDK_MAX_TOKENS`, default 2048). Added helpers `shouldUseSDK()`, `extractSDKText(response)`, `createAnthropicClient(apiKey)` (lazy dynamic import), and `callHaikuFastSDK(prompt, apiKey, client=null)` — single-turn, tool-free Messages call returning raw text (parsed by the existing `parseHaikuResponse`, mirroring `invokeHaiku`'s contract). Wired into `main()`: the non-agentic fast path routes through the SDK when `shouldUseSDK() && !agenticMode && fastMode`, with graceful fallback to the subprocess on any SDK error or unmet gate. Added test Group 10 (10 cases). All 100 unit tests green.

## Current phase

Phase 2 — SDK-Direct Mode

## Next unit

**Phase 2, Unit 4: `callHaikuDetailedSDK(prompt, apiKey)`** — same single-turn shape as fast, but for detailed (verbose) non-agentic mode. Likely a thin wrapper that shares the Messages call (consider factoring the shared body of `callHaikuFastSDK` into a `callHaikuSinglyTurnSDK`/`callMessagesSDK` core, then route detailed through it). Then extend `main()`'s routing so non-agentic **detailed** mode (`!agenticMode && !fastMode`) also uses the SDK. Add inline tests mirroring Group 10. After that, Unit 5 is the agentic tool-use loop (`callHaikuAgenticSDK`) — note: Node here is **v20.19.2**, so `fs.glob` (Node 22+) is unavailable; implement Glob via recursive `readdir`. Write tool scratch to `.claude/rlm-scratch-<pid>.md` per the plan's open question.

## Known issues / blockers

None. Note: tests inline faithful copies of hook logic (no imports from `rlm-hook.mjs`, since it calls `main()` on load) — keep new SDK tests in that style. The loop runner writes to an untracked nested `.marathon/.marathon/logs/` dir; leave it untracked, do not commit it.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [ ] Phase 2 — SDK-Direct Mode
- [ ] Phase 3 — Semantic Caching
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
