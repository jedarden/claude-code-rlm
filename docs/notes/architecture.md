# RLM Hook — Architecture Notes

## Why UserPromptSubmit (not PreToolUse)

UserPromptSubmit fires once per user turn, before Opus/Sonnet sees the message. This is the ideal injection point:

- **PreToolUse** fires per tool call — too late (Sonnet is already running) and fires many times per turn, multiplying cost.
- **UserPromptSubmit** fires once and injects context into the hook output, which Claude Code prepends to the conversation. Sonnet receives the user's message plus the RLM preresearch block as ambient context.

The tradeoff: the hook must complete before Sonnet starts. We cap timeout at 60s (configurable via `RLM_TIMEOUT`). Graceful degradation (exit 0 on any error) ensures the hook never blocks the conversation.

## Skip Detection

The hook skips RLM when the input is unlikely to benefit from codebase exploration:

| Condition | Threshold | Rationale |
|-----------|-----------|-----------|
| Too short | < 20 chars | Greetings, "ok", "yes" — no context to gather |
| Simple CLI command | Regex match | `ls`, `git status`, slash commands — Sonnet knows these |
| Code-heavy | > 50% code blocks with > 1 block | User is pasting code for review; structure is already clear |

All thresholds are overridable via env vars (`RLM_MIN_LENGTH`, etc.). Skip detection runs before the cache check to avoid hashing trivial inputs.

## Agentic vs Fast Mode

Two operating modes, controlled by `RLM_AGENTIC_MODE` (default: `true`) and `RLM_FAST_MODE` (default: `true`, applies when agentic is disabled):

### Agentic mode (default)
- Haiku receives `Read`, `Glob`, `Grep`, `Write`, and `Bash`. A subprocess `PreToolUse` guard rejects `Write` calls outside that run's PID-scoped `.claude/rlm-scratch-{pid}.md` and Bash calls outside the configured `git status`, `log`, `diff`, `show`, `branch`, `ls-files`, `remote` command families or cleanup of that same scratch file.
- Haiku writes scratch notes to a PID-scoped `.claude/rlm-scratch-{pid}.md` as it explores, then deletes the file
- Produces a rich JSON structure: `relevant_files`, `existing_patterns`, `recent_changes`, `approach`, `warnings`
- Latency: ~4–15s depending on codebase size and number of tool calls
- The CLI runs with only those five built-in tools exposed and no MCP tools. The guard is needed because Claude Code does not match `Write(path)` permission rules, `dontAsk` denies writes under its protected `.claude/` directory even with an `Edit(path)` allow rule, and `bypassPermissions` does not enforce the Bash allowlist. `bypassPermissions` keeps the scratch write working while the guard enforces the Write and Bash scope.

### Fast mode (non-agentic, no tools)
- Pure text analysis from initial context (project type, git branch, file list)
- Produces compact JSON: `intent`, `tasks`, `tech`, `files`, `approach`
- Latency: ~2–4s
- Use when: you want lower latency, or the project is small enough that context gathered in `gatherProjectContext` is sufficient

### Detailed mode (non-agentic, verbose)
- Activated by setting both `RLM_AGENTIC_MODE=false` and `RLM_FAST_MODE=false`
- Produces the most structured JSON with confidence scores, ambiguity detection, decomposition
- Latency: ~6–10s
- Use when: you want maximum analytical depth without tool use

## Cache Design

- **Key**: SHA-256 of the raw user message plus the working directory — `sha256(userMessage + '\0' + cwd)`, computed before truncation. Project-scoped: the same prompt in two different projects produces different keys (resolved plan.md Open Question 5, bead claudeco-b1c6997f). Not keyed on model or mode.
- **Location**: `~/.cache/rlm-hook/` (user-level; entries are project-scoped by the key, not by the directory layout)
- **TTL**: 3600s (1 hour), configurable via `RLM_CACHE_TTL`
- **Format**: JSON files named `<sha256>.json`
- **Eviction**: Lazy — stale files are deleted on access, not via a background sweep

The cwd half of the key scopes entries to a project, so one repository's cached `relevant_files` paths can never be served into another repository's `<rlm_preresearch>` block. The key does not cover code state: a prompt repeated after edits within the same project still hits the pre-edit entry until the TTL expires — the TTL, not the key, is the staleness bound. Model and mode are likewise absent from the key.

Cache misses are the common case for novel questions. The cache primarily helps with repeated queries in long sessions (e.g., retrying a prompt, running the same planning query after a small edit).

Semantic caching (default off, `RLM_SEMANTIC_CACHE=true`) layers onto the SHA-256 miss path: on a miss, the query is embedded as `prompt + '\0' + cwd` and scored against stored embeddings, and the nearest analysis above `RLM_SEMANTIC_THRESHOLD` is served in place of a Haiku run. It uses an OpenAI-compatible embeddings endpoint. Set `RLM_EMBED_BASE_URL` to override the default `https://api.openai.com/v1`, and provide `OPENAI_API_KEY`.

## Graceful Degradation

Every error path exits 0. The hook contract with Claude Code is:

- **stdout**: context to prepend (empty = no context injected)
- **exit code 0**: proceed normally
- **exit code non-zero**: Claude Code may surface the error to the user

Since we never want the preresearch hook to interrupt a conversation, all `catch` blocks call `process.exit(0)`. Errors are logged to `~/.local/share/rlm-hook/rlm-hook.log` for debugging.

## Why subprocess instead of SDK

The hook uses `spawn('claude', ...)` to invoke the Claude CLI rather than the Anthropic SDK directly. Reasons:

1. **No API key required**: Uses the user's existing Claude Max subscription (same billing as interactive Claude Code sessions). The SDK would require a separate `ANTHROPIC_API_KEY`.
2. **Tool use for free**: The Claude CLI handles tool invocation natively in agentic mode. Implementing the same with the SDK requires a full tool-call loop.
3. **Model routing**: The `--model` flag routes through the same proxy/subscription as the interactive session.

Tradeoffs: ~1–2s subprocess startup overhead vs direct API. See Phase 2 in `plan.md` for the SDK-direct path.

## Model ID

`claude-haiku-4-5-20251001` is the explicit model ID (not the alias `haiku`). Using the full ID ensures stable routing even if `haiku` alias is remapped to a newer version. Overridable via `RLM_MODEL`.
