# claude-code-rlm

A `UserPromptSubmit` hook for Claude Code that dispatches Haiku to pre-explore the codebase before Opus/Sonnet processes the prompt. Haiku's findings are injected as `<rlm_preresearch>` context ahead of the main model's turn.

## Key files

- `rlm-hook.mjs` — main hook (~1913 lines, Node ESM, depends on @anthropic-ai/sdk for Phase 2 SDK mode)
- `rlm-hook.sh` — thin bash wrapper
- `install.sh` — copies hook to `~/.claude/hooks/`
- `docs/plan/plan.md` — authoritative implementation plan (5 phases)
- `docs/notes/architecture.md` — design rationale
- `test/unit.test.mjs` — unit tests (inline logic, no imports from hook)
- `test/integration.test.mjs` — integration tests (fake subprocess injection)
- `bench/benchmark.mjs` — benchmark suite
- `bench/dashboard.mjs` — metrics dashboard (Phase 5, serves on port 9876)

## Test commands

```bash
# Unit tests (always the gate — must pass before commit)
node --test test/unit.test.mjs

# Integration tests (require RUN_INTEGRATION_TESTS=1)
RUN_INTEGRATION_TESTS=1 node --test test/integration.test.mjs

# Benchmarks
node bench/benchmark.mjs
```

## Adding dependencies

The hook uses `@anthropic-ai/sdk` for Phase 2 SDK-Direct mode. To add or update:

```bash
npm install @anthropic-ai/sdk
```

Commit `package.json` and `package-lock.json` together.

## Git

- Push to `origin` (Forgejo at `git.ardenone.com`) — GitHub mirrors automatically
- Never force-push
- Conventional commit messages: `feat(scope): …`, `fix(scope): …`, `test(scope): …`
- Git identity already configured in repo

## Env vars (all optional, runtime config)

All `RLM_*` vars are documented in `rlm-hook.mjs` at the top (lines 32-76). Key ones:
- `RLM_AGENTIC_MODE` — `true` (default) to enable codebase exploration with tools; `false` for fast analysis only
- `RLM_FAST_MODE` — `true` (default) for concise non-agentic analysis (~4s); `false` for detailed (~9s)
- `RLM_USE_SDK` — `true` to use Anthropic SDK directly instead of subprocess (requires `ANTHROPIC_API_KEY`)
- `RLM_SEMANTIC_CACHE` — `true` to enable embedding similarity cache (requires `OPENAI_API_KEY`)
- `RLM_CONTEXT_WINDOW` — How many prior RLM blocks to look back for context reuse (default: 5)
- `RLM_METRICS_FILE` — Path to metrics JSONL log for dashboard (Phase 5)
- `RLM_DEBUG` — `true` for verbose logging to `RLM_LOG_FILE`

## Marathon

Progress journal: `.marathon/STATE.md`
Done sentinel: `.marathon/DONE`
