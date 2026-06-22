# Marathon State — claude-code-rlm

## Last completed

(none — first iteration)

## Current phase

Phase 2 — SDK-Direct Mode

## Next unit

Bootstrap Phase 2: install `@anthropic-ai/sdk`, add `RLM_USE_SDK` env var detection, wire up the SDK code path alongside the existing subprocess path. Start with the fast (non-agentic) SDK path first — it's simpler (no tool loop) and validates the latency improvement before tackling agentic.

## Known issues / blockers

None yet.

## Phase completion

- [x] Phase 1 — Core Hook (COMPLETE)
- [ ] Phase 2 — SDK-Direct Mode
- [ ] Phase 3 — Semantic Caching
- [ ] Phase 4 — Conversation Context Awareness
- [ ] Phase 5 — Metrics Dashboard
