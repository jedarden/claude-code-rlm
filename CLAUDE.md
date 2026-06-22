# claude-code-rlm

A `UserPromptSubmit` hook for Claude Code that dispatches Haiku to pre-explore the codebase before Opus/Sonnet processes the prompt. Haiku's findings are injected as `<rlm_preresearch>` context ahead of the main model's turn.

## Key files

- `rlm-hook.mjs` — main hook (664 lines, Node ESM, no external deps currently)
- `rlm-hook.sh` — thin bash wrapper
- `install.sh` — copies hook to `~/.claude/hooks/`
- `docs/plan/plan.md` — authoritative implementation plan (5 phases)
- `docs/notes/architecture.md` — design rationale
- `test/unit.test.mjs` — unit tests (inline logic, no imports from hook)
- `test/integration.test.mjs` — integration tests (fake subprocess injection)
- `bench/benchmark.mjs` — benchmark suite

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

Phase 2 adds `@anthropic-ai/sdk`. Use npm:

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

All `RLM_*` vars are documented in `rlm-hook.mjs` at the top. Key ones:
- `RLM_MODE` — `agentic` (default) | `fast` | `detailed`
- `RLM_USE_SDK` — `true` to use SDK path (Phase 2)
- `RLM_SEMANTIC_CACHE` — `true` to use embedding similarity cache (Phase 3)
- `RLM_DEBUG` — `true` for verbose logging

## Marathon

Progress journal: `.marathon/STATE.md`
Done sentinel: `.marathon/DONE`
