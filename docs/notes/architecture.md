# RLM Hook — Architecture Notes

## Why UserPromptSubmit (not PreToolUse)

UserPromptSubmit fires once per user turn, before Opus/Sonnet sees the message. This is the ideal injection point:

- **PreToolUse** fires per tool call — too late (Sonnet is already running) and fires many times per turn, multiplying cost.
- **UserPromptSubmit** fires once and injects context into the hook output, which Claude Code prepends to the conversation. Sonnet receives the user's message plus the RLM preresearch block as ambient context.

The tradeoff: the hook must complete before Sonnet starts. We cap timeout at 60s (configurable via `RLM_TIMEOUT`). Graceful degradation (exit 0 on any error) ensures the hook never blocks the conversation.

## Trust and injection surface

The `<rlm_preresearch>` and `<rlm_analysis>` blocks, and their human-readable
summaries, are **untrusted data, not instructions**. Haiku may copy text from a
repository controlled by someone other than the user; that text can include
instructions addressed to the main model. The main model must treat findings
as leads to verify against the user's request and the repository, never as a
new instruction source. Cache hits and prior-block reuse have the same trust
posture as a fresh Haiku response.

The parser normalizes every response before it can be emitted. It neutralizes
RLM opening/closing tags and Markdown fences in strings and JSON keys, including
unknown fields, so repository text cannot splice a second block or terminate
the current one. It also limits strings, arrays, object keys, nesting, and
unknown top-level fields. This is a framing defense; it cannot determine
whether a plausible finding is true or prevent all semantic prompt injection.

The **total stdout injection** (including `console.log`'s newline) is capped at
12,000 characters by default. `RLM_MAX_OUTPUT_CHARS` accepts an integer and is
clamped to 2,000–32,000 characters. The hook first truncates individual strings
and collections, then drops unknown fields, then shrinks known fields under cap
pressure. It marks structured elision with `rlm_truncated: true`. If even the
shrunk JSON cannot fit, it emits a parseable truncation notice. The final
rendering keeps the JSON block whole and truncates the repeated summary tail
with a visible marker; if the block itself is too large, it replaces the body
with the truncation notice. The exact limits and rule are in
[Preresearch output schema](preresearch-schema.md#injected-output-bound).

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

Semantic caching (default off, `RLM_SEMANTIC_CACHE=true`) layers onto the SHA-256 miss path: on a miss, the query is embedded as `prompt + '\0' + cwd` and scored against stored embeddings, and the nearest analysis above `RLM_SEMANTIC_THRESHOLD` is served in place of a Haiku run. It uses an OpenAI-compatible embeddings endpoint. Set `RLM_EMBED_BASE_URL` to override the default `https://api.openai.com/v1`, and provide `OPENAI_API_KEY`. This is an outbound transmission of raw prompt text — see [Outbound data flow and privacy](#outbound-data-flow-and-privacy) for the payload and its controls.

### Embedding failure and latency contract

The exact SHA-256 cache lookup always runs first. An exact hit is therefore
SHA-only: it does not contact the embedding endpoint, even when
`RLM_SEMANTIC_CACHE=true`. Only a SHA miss attempts semantic lookup.

Each embedding request has its own deadline, controlled by
`RLM_EMBED_TIMEOUT` and defaulting to **5,000 ms**. The deadline covers waiting
for response headers and reading the response body; the request is aborted when
the transport supports abort signals. A timeout, connection failure, non-2xx
response, or malformed response is a semantic-cache miss. The hook catches the
failure and continues to the ordinary Haiku path; there is no second SHA lookup
because the exact SHA lookup already completed. This is the SHA-256-only cache
behavior: semantic caching cannot prevent a normal miss from reaching Haiku.

The failure is recorded in `RLM_LOG_FILE` (normally
`~/.local/share/rlm-hook/rlm-hook.log`) with the bounded diagnostic, including
the timeout reason when applicable. The hook still exits 0. If the post-Haiku
embedding write fails, the JSON SHA cache entry remains valid and the failure
is logged in the same way.

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

## Outbound data flow and privacy

The hook makes at most two kinds of outbound network calls. Everything else it touches — the metrics JSONL, the error/verbose log, the prompt-keyed analysis cache, the agentic scratch file, and the metrics dashboard (loopback-bound by default) — stays on the local machine; the observability content policy in the README and the [Graceful Degradation](#graceful-degradation) section cover what those local artifacts may contain. This section enumerates what actually leaves it.

### Call 1 — the Haiku preresearch request

| | |
|---|---|
| Destination | The Anthropic Messages API, reached one of two ways: through the `claude` CLI subprocess (default; the CLI's own provider routing applies, so any gateway/`ANTHROPIC_BASE_URL`-style override the CLI honors applies here too), or directly from the hook process via `@anthropic-ai/sdk` when `RLM_USE_SDK=true` and `ANTHROPIC_API_KEY` is set |
| Trigger | Any prompt that survives skip detection and misses both the SHA-256 cache and (when enabled) the semantic cache — see the ordering below |
| Auth | Whichever credential the chosen transport uses: the CLI's subscription/Console auth for subprocess runs, the Console API key for SDK runs (billing routes in the SDK-Direct mode section above) |

**Payload.** Both transports send the same assembled prompt (`buildRLMPrompt` in `rlm-hook.mjs`):

- The user prompt, truncated to `RLM_MAX_LENGTH` (default 4000 chars) with a `[truncated]` marker.
- An `INITIAL CONTEXT` block when `RLM_GATHER_CONTEXT=true` (default). Gathered locally by `gatherProjectContext` and `gatherConversationContext`, then transmitted as part of the prompt: project directory name and type, dependency names from `package.json` (up to 10 deps + 5 devDependencies are gathered; the prompt carries at most the first 8 stack entries), the current git branch, the first 5 lines of `git status --porcelain`, up to 5 recent source-file paths, and previews of the last 3 conversation turns (≤100 chars each) read from the Claude Code transcript at `transcript_path`.
- In agentic mode (default), the transmission does not stop at the prompt. Haiku explores the repository with `Read`/`Glob`/`Grep` and read-only git commands for up to `RLM_MAX_TURNS` rounds, and **the file contents and command output those tools return are transmitted to the Anthropic API as tool results** in the ongoing conversation. Both transports do this — the CLI's native tool loop, and the SDK agentic loop feeding `tool_result` messages back (`callHaikuAgenticSDK`). Tool reads are confined to the project directory in both modes (see the sandbox paragraph in the README's "Example output" section), but files *inside* the project are read and their contents transit to the model provider.

Env vars that shape this call: `RLM_AGENTIC_MODE`, `RLM_FAST_MODE`, `RLM_MODEL`, `RLM_MAX_TURNS`, `RLM_TIMEOUT` (subprocess kill timer), `RLM_USE_SDK` + `ANTHROPIC_API_KEY` (transport), `RLM_SDK_MAX_TOKENS` (SDK path only), `RLM_GATHER_CONTEXT` (whether the context block is attached), `RLM_MAX_LENGTH` (prompt truncation), `RLM_CONTEXT_WINDOW` (how much transcript the hook reads).

**When this call does not fire:** skip detection (trivial inputs), a SHA-256 cache hit, a semantic cache hit, or the Phase 4 early-exit all exit before Haiku is invoked — zero outbound calls on those paths.

### Call 2 — the embedding request (semantic cache only)

Fires only when **both** `RLM_SEMANTIC_CACHE=true` and `OPENAI_API_KEY` are set. Off by default.

| | |
|---|---|
| Destination | `{RLM_EMBED_BASE_URL}/embeddings` — default `https://api.openai.com/v1/embeddings`. Unless you override `RLM_EMBED_BASE_URL` (e.g. to a self-hosted endpoint), the recipient is OpenAI, a third party distinct from the model provider |
| Trigger | Twice per fresh analysis: once on the lookup path (`semanticLookup` embeds every query that reached it — so even a semantic-cache *miss* transmits the prompt), and again after a successful Haiku analysis (`saveCacheEmbedding` stores the query's vector) |
| Payload | `{ model, input }` where `input` is the **raw, untruncated user prompt** with `'\0' + cwd` appended — the full prompt text and the project directory path, verbatim |
| Auth | `Authorization: Bearer $OPENAI_API_KEY` |

Note the asymmetry with Call 1: `RLM_MAX_LENGTH` truncation applies only to the Haiku prompt, never to the embedding input. The raw prompt goes to the embedding endpoint in full. A SHA-256 cache hit short-circuits before `semanticLookup`, so enabling the SHA cache also avoids this call for exact repeats.

Env vars that control this call: `RLM_SEMANTIC_CACHE` (gate), `OPENAI_API_KEY` (gate and credential), `RLM_EMBED_BASE_URL` (destination), `RLM_EMBED_MODEL`, `RLM_SEMANTIC_THRESHOLD` (decides hit vs. miss, i.e. whether the Haiku call in Call 1 happens).

### Limiting exposure

- Keep `RLM_SEMANTIC_CACHE` off (the default): Call 2 does not exist, and only preresearch prompts reach the model provider.
- Point `RLM_EMBED_BASE_URL` at a self-hosted or first-party-trusted embeddings endpoint if the semantic cache is wanted but raw prompts must not reach a third party.
- `RLM_GATHER_CONTEXT=false` skips context gathering entirely: only the prompt itself is transmitted (agentic exploration is unaffected — Haiku still reads whatever it chooses to read).
- `RLM_AGENTIC_MODE=false` (with `RLM_FAST_MODE` choosing the non-agentic variant) removes the tool loop entirely: only the assembled prompt is transmitted, no project file contents beyond the context line.
- The injected `<rlm_preresearch>` block becomes part of the main conversation; its onward transmission follows whatever provider and settings the *main* Claude Code session uses — the hook cannot scope that.

## Model ID

`claude-haiku-4-5-20251001` is the explicit model ID (not the alias `haiku`). Using the full ID ensures stable routing even if `haiku` alias is remapped to a newer version. Overridable via `RLM_MODEL`.
