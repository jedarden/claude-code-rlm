# RLM Theory: Preresearch as a Claude Code Hook

*Research note — June 2026*

---

## What "RLM" means here

RLM stands for **Retrieval-augmented Language Model** in the academic literature, but that framing misses what this project actually does. The academic RLM retrieves documents from a static corpus at query time. This hook does something structurally different: it dispatches a lightweight agent to *actively explore* a live codebase, synthesize what it finds, and hand the synthesis to a more capable model before that model ever processes the query.

The better mental model is **preresearch delegation**: a smaller model (Haiku) canvasses relevant materials and briefs the main model (Opus/Sonnet). The time spent and how much orientation the main model can skip depend on the prompt, repository, and model response.

---

## How this differs from standard prompting

Standard RAG and prompt-stuffing approaches retrieve based on embedding similarity or keyword overlap. They work well for document corpora but poorly for codebases, where what matters is not lexical proximity but *structural relationships*: which function calls which, what patterns the codebase already uses, what changed recently.

The preresearch-agent-as-hook pattern uses a model to navigate those relationships dynamically. Haiku can:

- Glob for files matching a naming pattern the user implied but did not name
- Grep for the symbol the user mentioned, then read the files that define it
- Check `git log` to surface context the user has forgotten about
- Notice that a utility already exists that the user is about to ask Opus to write

A static retriever cannot do any of this. A human would do all of it instinctively before sitting down to implement. The hook approximates that instinct cheaply.

---

## The latency-vs-quality trade-off

The core tension is that preresearch costs time and money. The break-even depends on how much exploration the main model would otherwise do, and whether the injected summary actually reduces that work.

A cold session on an unfamiliar codebase *might* use 10–20 tool calls to orient before writing code. That range is an illustrative assumption from the original project rationale; this repository has no paired runs measuring orientation calls with and without the hook. Haiku may compress useful exploration into one injected block, but the main model can still need to inspect and verify files. A net latency or cost benefit has not been established by the repository's benchmark.

For short, self-contained prompts — "what does `x` do?", quick edits with a file already in context — the trade-off inverts: preresearch adds latency with no payoff. This is why skip detection is non-negotiable, not an optimization.

---

## Why Haiku specifically

Three properties make Haiku the right choice for the preresearch role:

1. **Speed.** Anthropic [positions Haiku as its lower-latency model](https://platform.claude.com/docs/en/models/overview). The earlier 4–6×/10× time-to-first-token ratios have no recorded model versions, workload, or measurement here, so they should not be treated as measured results. This hook allows up to `RLM_MAX_TURNS` (default 10) model turns in agentic mode, within `RLM_TIMEOUT` (default 60 s); neither limit promises that a run will finish in 20 s or use every turn. One turn may contain multiple tool calls.

2. **Cost.** Preresearch retains a synthesis rather than every file read. At [Anthropic's Claude API list prices](https://platform.claude.com/docs/en/about-claude/pricing), Haiku 4.5 is $1/$5 per million input/output tokens, Sonnet 4.5 is $3/$15, and Opus 4.5 is $5/$25. Haiku's per-token rates are one-third and one-fifth of those rates at equal token usage, rather than a universal one-tenth cost. Actual spend depends on the model versions, token mix, caching, and billing route; the extra Haiku request may increase total spend if it saves little main-model work.

3. **Structured output reliability.** Haiku follows JSON schema instructions accurately. The synthesis step produces a structured block that the hook can parse and reformat without post-processing heuristics.

Haiku is not the right model for nuanced judgment calls, subtle architectural trade-offs, or tasks that require reading large amounts of code holistically. Those belong to Opus. The division of labor is explicit: Haiku navigates, Opus reasons.

---

## The caching insight

Coding sessions are repetitive in a specific way. Developers refine prompts — they ask roughly the same thing two or three times, tweaking wording, then accept one answer and move on. They re-open a session to continue yesterday's work with nearly identical initial context. They hit the same files repeatedly across a session.

A SHA-256 cache keyed on `(prompt, cwd)` with a 1-hour TTL can capture exact repeat requests. No end-to-end log or environment description is committed for the README's historical ~37 ms cache-hit example. The committed [cache benchmark](../../bench/README.md) measures synthetic file-cache operations, not full hook time; the hook's metrics log records `latency_ms` for actual cache hits. The two key dimensions do different jobs: `prompt` identifies the request; `cwd` scopes it to a project, so the same question asked in two different repositories cannot serve one repository's file paths into the other's context. What the key cannot see is code changing underneath a stable prompt and working directory — staleness is bounded by the TTL, not by the key.

The 1-hour TTL is a deliberate choice: long enough to cover a focused coding session, short enough that stale preresearch from before a major refactor does not persist into the next session.

An optional similarity layer extends this to prompts that are *near*-identical rather than byte-identical: the prompt-plus-cwd is embedded and scored against stored embeddings, and the nearest analysis above a cosine threshold is served without consulting Haiku. It ships default-off.

*(Implemented contract — exact key scheme, TTL, and the semantic layer — is specified in `docs/notes/architecture.md`, "Cache Design". That document tracks the code; treat it as authoritative over this research note.)*
