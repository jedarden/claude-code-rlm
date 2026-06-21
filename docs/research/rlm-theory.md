# RLM Theory: Preresearch as a Claude Code Hook

*Research note — June 2026*

---

## What "RLM" means here

RLM stands for **Retrieval-augmented Language Model** in the academic literature, but that framing misses what this project actually does. The academic RLM retrieves documents from a static corpus at query time. This hook does something structurally different: it dispatches a lightweight agent to *actively explore* a live codebase, synthesize what it finds, and hand the synthesis to a more capable model before that model ever processes the query.

The better mental model is **preresearch delegation**: you hire a junior researcher (Haiku) to spend 20 seconds canvassing the relevant materials, then walk into the meeting with a senior consultant (Opus/Sonnet) who has already been briefed. The senior consultant's first words are substantive — not "let me take a look around first."

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

The core tension is that preresearch costs time (20s in agentic mode) and money. The break-even depends on how much exploration the main model would otherwise do.

Empirically, a cold Opus or Sonnet session on an unfamiliar codebase spends 10–20 tool calls on orientation before writing code. At Opus pricing, those calls are expensive. Haiku at a tenth of the cost runs the same orientation pass faster and compresses the findings into a single injected block. The main model's first tool call is substantive.

For short, self-contained prompts — "what does `x` do?", quick edits with a file already in context — the trade-off inverts: preresearch adds latency with no payoff. This is why skip detection is non-negotiable, not an optimization.

---

## Why Haiku specifically

Three properties make Haiku the right choice for the preresearch role:

1. **Speed.** Haiku's time-to-first-token is roughly 4–6x lower than Sonnet and 10x lower than Opus. The 20s agentic budget covers 10 tool calls with synthesis to spare.

2. **Cost.** Preresearch is a lossy summarization task — we are discarding most of what Haiku finds and keeping only the synthesis. Paying Opus prices for lossy summarization is wasteful.

3. **Structured output reliability.** Haiku follows JSON schema instructions accurately. The synthesis step produces a structured block that the hook can parse and reformat without post-processing heuristics.

Haiku is not the right model for nuanced judgment calls, subtle architectural trade-offs, or tasks that require reading large amounts of code holistically. Those belong to Opus. The division of labor is explicit: Haiku navigates, Opus reasons.

---

## The caching insight

Coding sessions are repetitive in a specific way. Developers refine prompts — they ask roughly the same thing two or three times, tweaking wording, then accept one answer and move on. They re-open a session to continue yesterday's work with nearly identical initial context. They hit the same files repeatedly across a session.

A SHA-256 cache keyed on `(prompt, cwd)` with a 1-hour TTL captures most of this repetition. The 37ms cache hit cost is essentially free — lower than the round-trip to display a response. The cache is also a correctness guarantee: if the codebase changed significantly, `cwd` produces a different hash, and the cache is bypassed.

The 1-hour TTL is a deliberate choice: long enough to cover a focused coding session, short enough that stale preresearch from before a major refactor does not persist into the next session.
