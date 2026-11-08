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
- `bench/dashboard.mjs` — metrics dashboard (Phase 5, loopback-only on port 9876 by default)

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

All `RLM_*` vars are documented in the README's Configuration section and parsed
by `createConfig` in `rlm-config.mjs`. Key ones:
- `RLM_AGENTIC_MODE` — `true` (default) to enable codebase exploration with tools; `false` for fast analysis only
- `RLM_FAST_MODE` — `true` (default) for concise non-agentic analysis (~4s); `false` for detailed (~9s)
- `RLM_USE_SDK` — `true` to use Anthropic SDK directly instead of subprocess (requires `ANTHROPIC_API_KEY`)
- `RLM_SDK_MAX_TOKENS` — Max tokens for SDK Haiku calls (default: 2048)
- `RLM_SEMANTIC_CACHE` — `true` to enable embedding similarity cache (requires `OPENAI_API_KEY`)
- `RLM_SEMANTIC_THRESHOLD` — Cosine similarity threshold for semantic cache (0-1, default: 0.92)
- `RLM_EMBED_MODEL` — OpenAI embedding model (default: text-embedding-3-small)
- `RLM_EMBED_BASE_URL` — Embedding API endpoint (default: https://api.openai.com/v1)
- `OPENAI_API_KEY` — API key for the embedding endpoint when semantic caching is enabled
- `RLM_CONTEXT_WINDOW` — How many prior RLM blocks to look back for context reuse (default: 5)
- `RLM_GATHER_CONTEXT` — Gather project context (default: true)
- `RLM_METRICS_FILE` — Path to metrics JSONL log for dashboard (Phase 5)
- `RLM_DASHBOARD_HOST` — Dashboard bind host (default: `127.0.0.1`; set explicitly, for example `0.0.0.0`, only when network access is intended)
- `RLM_DEBUG` — `true` for verbose logging to `RLM_LOG_FILE`

The live metrics dashboard binds to `127.0.0.1:9876` by default, so prompt-derived
metrics remain reachable only from the local machine. Set `RLM_DASHBOARD_HOST`
explicitly to bind elsewhere; non-loopback hosts expose intents, latencies, and
token counts to any network path that can reach port 9876, so use an appropriate
firewall or access control boundary.

## Supplying credentials

`RLM_USE_SDK` needs `ANTHROPIC_API_KEY`; `RLM_SEMANTIC_CACHE` needs
`OPENAI_API_KEY`. The hook reads both from its process environment only — it has
no key-file feature of its own. Keep the long-lived value in a secret store
(e.g. an OpenBao path like `secret/<cluster>/claude-code-rlm/<key>`) or a
mode-600 env file that the shell launching Claude Code sources, and materialize
it by pipe or interactive read. Never place the value on a command line, in an
rc-file literal, in a `settings.json` `env` entry, or in any commit, bead, log,
or doc. Verify features by property, not by echoing the key: a fresh
`Used SDK-Direct` log line plus a numeric `token_estimate` on the metrics
`complete` record for SDK mode; a `.embedding` sidecar in the cache dir plus a
`Wrote semantic embedding` log line for the semantic cache. Recipes and failure
signatures: README, [Supplying credentials](README.md#supplying-credentials).

## Marathon

Progress journal: `.marathon/STATE.md`
Done sentinel: `.marathon/DONE`
