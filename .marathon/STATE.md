# Marathon State — claude-code-rlm

## Last completed

**Phase 2, Unit 5 (SDK agentic tool-use loop) — commit b5bfff8.** Implemented `callHaikuAgenticSDK(prompt, apiKey, cwd, client=null, dispatch=dispatchAgenticTool)` — the explicit tool-use loop. Sends the agentic prompt with an `AGENTIC_TOOLS` schema (Glob/Grep/Read/Write/Bash); loops while `stop_reason === 'tool_use'`, echoing the assistant turn back as `{role:'assistant', content: response.content}` then appending a `{role:'user', content: [tool_result...]}` turn keyed by `tool_use_id`; stops on non-tool_use (returns that turn's text) or at `CONFIG.maxTurns` (returns best text seen). Tool impls are dependency-free: **Glob** → recursive `readdir` + `globToRegExp` (`**` crosses `/`, `*`/`?` don't), skips node_modules/.git, caps 100; **Grep** → system `grep -rn` via `execSync` (shell-quoted); **Read** → `readFile`, 16KB truncation, `resolveWithin` blocks path traversal; **Write** → always the pid-scoped `.claude/rlm-scratch-<pid>.md` (ignores any model-supplied path → fixes scratch-collision open question); **Bash** → `isAllowedGitCommand` guard (must start `git`, no `;&|\`$()<>{}` metachars → blocks chaining/redir/subst) then `execSync`. `dispatchAgenticTool` routes one block, never throws (returns `Error: ...` strings). Wired `main()`: a new branch `response === null && shouldUseSDK() && CONFIG.agenticMode` → `callHaikuAgenticSDK`, cleans up its pid scratch in `finally`, falls back to subprocess on error. Added Group 12 (17 tests: loop threading/tool_result keying, tools advertised each turn, turn cap, model/maxTokens passthrough, error propagation, git guard matrix, unknown-tool, glob translation, real Glob/Read/Write/Bash/Grep against a temp dir). 122 unit tests green. `node --check rlm-hook.mjs` clean. Also refreshed Group 10's now-stale routing comment (agentic has its own SDK branch as of Unit 5).

(Prior — Unit 4, commit 7d1da25: `callMessagesSDK` core + `callHaikuDetailedSDK` wrapper, Group 11. Units 1+2+3, commit 979e2b1: installed `@anthropic-ai/sdk` v0.105.0; `useSDK`/`apiKey`/`sdkMaxTokens` config, `shouldUseSDK()`, `extractSDKText()`, `createAnthropicClient()`, `callHaikuFastSDK`, Group 10.)

## Current phase

Phase 2 — SDK-Direct Mode (Units 1–5 done; Units 6–7 remain)

## Next unit

**Phase 2, Unit 6 + 7: broader SDK unit tests + integration SDK scenario.** Most SDK paths are already covered (Groups 10/11/12), so Unit 6 is about filling any remaining gaps and hardening: e.g. a test for `createAnthropicClient` lazy-import failure surfacing as an error the caller can catch (so `main()` falls back); an `extractSDKText` test against a real-ish multi-block agentic final turn; optionally a small `main()`-level routing test that the agentic SDK branch is only taken when `response === null` (i.e. it doesn't double-run after a successful non-agentic SDK call). Unit 7: extend `test/integration.test.mjs` with an SDK scenario — since the hook lazily `import('@anthropic-ai/sdk')`, the cleanest fake is to inject a stub module on the import path (or set `RLM_USE_SDK=true` with a fake `ANTHROPIC_API_KEY` and assert graceful subprocess fallback when the SDK call fails). Run `RUN_INTEGRATION_TESTS=1 node --test test/integration.test.mjs` for that one. Completing 6+7 finishes Phase 2 → flip the phase checkbox and move to Phase 3 (semantic caching).

## Known issues / blockers

None. Note: tests inline faithful copies of hook logic (no imports from `rlm-hook.mjs`, since it calls `main()` on load) — keep new SDK tests in that style. The loop runner writes to an untracked nested `.marathon/.marathon/logs/` dir; leave it untracked, do not commit it.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [ ] Phase 2 — SDK-Direct Mode
- [ ] Phase 3 — Semantic Caching
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
