# Marathon State — claude-code-rlm

## Last completed

**Phase 2, Unit 4 (detailed SDK path) — commit 7d1da25.** Factored the shared single-turn Messages call out of `callHaikuFastSDK` into a `callMessagesSDK(prompt, apiKey, client=null, label)` core; `callHaikuFastSDK` and the new `callHaikuDetailedSDK` are now thin wrappers (they differ only in the prompt `buildRLMPrompt` produces and the log label — fast/detailed verbosity lives entirely in the prompt). Updated `main()` routing: the SDK path now covers **any** non-agentic mode (`shouldUseSDK() && !agenticMode`), picking the fast vs detailed wrapper off `CONFIG.fastMode`, still with graceful subprocess fallback on error. Updated Group 10's routing predicate test (was `!agentic && fast`, now `!agentic`) and added Group 11 (5 cases: detailed request shape, verbose-JSON round-trip through `parseHaikuResponse`, error propagation, fast/detailed issue identical requests, wrapper selection). 105 unit tests green. `node --check rlm-hook.mjs` clean.

(Prior — Units 1+2+3, commit 979e2b1: installed `@anthropic-ai/sdk` v0.105.0; added `useSDK`/`apiKey`/`sdkMaxTokens` config, `shouldUseSDK()`, `extractSDKText()`, `createAnthropicClient()` lazy import, `callHaikuFastSDK`, Group 10.)

## Current phase

Phase 2 — SDK-Direct Mode

## Next unit

**Phase 2, Unit 5: `callHaikuAgenticSDK(prompt, apiKey, cwd)`** — the tool-use loop. Send the agentic prompt with a `tools` array (Glob, Grep, Read, Write, `Bash(git:*)`). Loop while `stop_reason === 'tool_use'`: for each `tool_use` block dispatch the tool and append a `tool_result` block (matching `tool_use_id`) to the message history, then re-call `messages.create`. Cap iterations at `CONFIG.maxTurns` (`RLM_MAX_TURNS`, default 10). Tool impls (dependency-free): **Glob** → recursive `readdir` (Node here is **v20.19.2** — `fs.glob` is Node 22+, unavailable); **Grep** → `child_process` grep; **Read** → `fs.readFile`; **Write** → write to `.claude/rlm-scratch-<pid>.md` (per the plan's scratch-collision open question); **Bash(git:*)** → spawn only `git ...` commands, reject anything else. Then wire `main()`: `shouldUseSDK() && agenticMode` → `callHaikuAgenticSDK`. Mock the client's multi-turn `messages.create` (sequence of tool_use → final text) in inline tests; test dispatch loop, turn cap, and that non-git Bash is refused. After Unit 5, do Unit 6 (broader SDK unit tests) + Unit 7 (integration SDK scenario), which completes Phase 2.

## Known issues / blockers

None. Note: tests inline faithful copies of hook logic (no imports from `rlm-hook.mjs`, since it calls `main()` on load) — keep new SDK tests in that style. The loop runner writes to an untracked nested `.marathon/.marathon/logs/` dir; leave it untracked, do not commit it.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [ ] Phase 2 — SDK-Direct Mode
- [ ] Phase 3 — Semantic Caching
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
