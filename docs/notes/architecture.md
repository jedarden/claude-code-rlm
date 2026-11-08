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

Since we never want the preresearch hook to interrupt a conversation, all `catch` blocks call `process.exit(0)`. Errors are logged to `~/.local/share/rlm-hook/rlm-hook.log` for debugging. The metrics JSONL, error log, and `RLM_DEBUG` verbose log share a content-safety boundary: they retain counts, fixed labels, token numbers, and bounded operational diagnostics only. Raw prompts, transcript excerpts, and explored-file contents are not persisted; subprocess stderr and model-provided skip reasons are dropped when they could carry such content. Known sensitive values reaching an unavoidable diagnostic are replaced with a short SHA-256 plus length marker, and log entries remain bounded by the rotating-log limits.

## Why subprocess instead of SDK

The hook uses `spawn('claude', ...)` to invoke the Claude CLI rather than the Anthropic SDK directly. Reasons (verified against Anthropic's live docs, 2026-11-08 — see the next section for the evidence and citations):

1. **No API key required**: Uses the user's existing Claude Pro/Max/Ultra subscription (same billing as interactive Claude Code sessions). Subscription credentials authenticate only the `claude` CLI and the surfaces that wrap it — the Anthropic SDK cannot bill `client.messages.create` to a claude.ai subscription.
2. **Tool use for free**: The Claude CLI handles tool invocation natively in agentic mode. Implementing the same with the SDK requires a full tool-call loop.
3. **Model routing**: The `--model` flag routes through the same account/proxy as the interactive session.

Tradeoffs: ~1–2s subprocess startup overhead vs direct API. See Phase 2 in `plan.md` for the SDK-direct path.

## SDK-Direct mode: authentication, billing, and fallback

Verified 2026-11-08 against Anthropic's own documentation (Claude Code authentication: `code.claude.com/docs/en/authentication.md`; Claude API authentication: `platform.claude.com/docs/en/manage-claude/authentication.md`). This resolves Phase 2's open questions in `plan.md`.

### Which account types support which path

| Credential | Bills to | Works with | Works with this hook |
|---|---|---|---|
| claude.ai Pro/Max/Ultra/Team/Enterprise login (OAuth, stored in `~/.claude/.credentials.json` / macOS Keychain) | Flat Claude.ai subscription | Only Claude Code surfaces: the `claude` CLI, VS Code extension, Agent SDK, GitHub Actions | **Default subprocess path only** |
| `claude setup-token` long-lived OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) | Same subscription | Same Claude Code surfaces; "can only make model requests" | Subprocess path (CI/headless Claude Code) |
| Console API key (`ANTHROPIC_API_KEY`, `sk-ant-...`) | **Pay-per-token to a Console workspace** | Any SDK / raw-API client | Default path *and* `RLM_USE_SDK=true` SDK-Direct path |
| Workload Identity Federation, App Attest | Pay-per-token to a Console workspace | Any SDK / raw-API client | Not wired up (`createConfig` reads only `ANTHROPIC_API_KEY`) |

The decisive fact: the Claude API's documented credential types are exactly API keys, WIF, and App Attest — every one bills usage to a Console workspace. There is **no claude.ai subscription credential for direct API calls**. SDK-Direct mode therefore requires a Console API key and is *always* pay-per-token; a Max subscription cannot subsidize it. (Subscription OAuth tokens minted by Claude Code hit `api.anthropic.com` with `Authorization: Bearer` plus the `anthropic-beta: oauth-2025-04-20` header, but their authorized surface is Claude Code itself, not arbitrary SDK clients; `ant auth login` OAuth profiles are bound to a Console org+workspace and are pay-per-token too.)

### Cost interaction to be aware of

Claude Code's authentication precedence places `ANTHROPIC_API_KEY` (sent as `X-Api-Key`) **above** the subscription OAuth credential, and in non-interactive `-p` mode "the key is always used when present". This hook's fallback spawns `claude -p`, so once `ANTHROPIC_API_KEY` is exported into the hook's environment to enable SDK mode, the **fallback subprocess runs are billed pay-per-token too** — not to the subscription. A user on Max who enables `RLM_USE_SDK=true` should assume both paths bill to the Console while the key is in scope; unset the key (or scope it out of the hook's env) to return the subprocess path to subscription billing. For scale: `claude-haiku-4-5` lists at $1/$5 per MTok input/output (Anthropic first-party rate, October 2026), and an agentic run is estimated at ~2K–10K input / ~0.5K–2K output tokens.

### Model IDs via SDK vs CLI (Phase 2 open question 2)

The SDK and the CLI target the same `/v1/messages` endpoint, and the same explicit model IDs are valid on both — the hook's `claude-haiku-4-5-20251001` resolves identically either way. Aliases such as `haiku` are a CLI convenience layer and are not part of the SDK contract, so the hook correctly uses the full dated ID (`RLM_MODEL` overrides it). Verified from documentation, not a live call: anyone with a key can confirm with one Models API request — `await client.models.retrieve('claude-haiku-4-5-20251001')` (Models API is GA, no beta header).

### Unavailable-access fallback (defined behavior)

SDK-Direct mode degrades through three tiers, each ending with the hook still exiting 0 and emitting analysis when a prior tier produced nothing:

1. **SDK configured but key missing/empty** (`RLM_USE_SDK=true`, no usable `ANTHROPIC_API_KEY`): `shouldUseSDK()` is false, no SDK call is attempted, and the run goes straight to the subprocess. As of 2026-11-08 the hook logs the reason ("RLM_USE_SDK=true but ANTHROPIC_API_KEY is not set — ... using subprocess fallback") once per run to `RLM_LOG_FILE` so silent cold-start cost is diagnosable. Covered by unit tests (gating) and the "SDK enabled but no API key" integration test.
2. **SDK call fails at runtime** (bad key → 401, SDK not installed → import error, network error): the `catch` around each SDK branch logs the error and falls through to the subprocess path. Covered by the "fast/agentic SDK path: SDK failure falls back to subprocess" integration tests.
3. **Subprocess also fails**: existing graceful degradation — empty stdout, exit 0, error logged (`~/.local/share/rlm-hook/rlm-hook.log`). The conversation is never blocked.

Billing note for tier 2: the fallback runs on whatever credential the subprocess resolves, which per the cost interaction above may be the same Console key — a repeated SDK failure under a pay-per-token key means every fallback run is billed, not free.

## Model ID

`claude-haiku-4-5-20251001` is the explicit model ID (not the alias `haiku`). Using the full ID ensures stable routing even if `haiku` alias is remapped to a newer version. Overridable via `RLM_MODEL`.
