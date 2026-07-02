# Bead bf-gjo: Documentation Refresh

## Status: Already Complete

All issues described in bead bf-gjo were already fixed in commit 7c6ac8a (2026-06-24, "docs: improve README for clarity and discoverability"). The bead description was based on an older state of the documentation.

## Verification Results (2026-07-02)

### 1. Env Var Documentation ✓
All 20 env vars in CONFIG are documented in README.md Configuration section (lines 107-149):
- RLM_AGENTIC_MODE, RLM_FAST_MODE (mode selection)
- RLM_MODEL, RLM_TIMEOUT, RLM_CACHE_TTL, RLM_MIN_LENGTH, RLM_MAX_LENGTH, RLM_MAX_TURNS (model tuning)
- RLM_CACHE_DIR, RLM_LOG_FILE, RLM_METRICS_FILE (paths)
- RLM_USE_SDK, ANTHROPIC_API_KEY, RLM_SDK_MAX_TOKENS (Phase 2: SDK-Direct)
- RLM_SEMANTIC_CACHE, RLM_SEMANTIC_THRESHOLD, RLM_EMBED_MODEL, RLM_EMBED_BASE_URL, OPENAI_API_KEY (Phase 3: Semantic caching)
- RLM_CONTEXT_WINDOW, RLM_GATHER_CONTEXT (Phase 4: Context awareness)
- RLM_DEBUG (debug)

CLAUDE.md documents the key env vars appropriately for a project-level reference.

### 2. Example Output Format ✓
README.md Example output (lines 29-68) matches formatOutput exactly:
- `<rlm_preresearch>` tag
- Pretty-printed JSON via `JSON.stringify(analysis, null, 2)`
- `</rlm_preresearch>` tag
- Empty line
- `PRERESEARCH COMPLETE:` header
- Plain-text summary with Intent, Summary, Relevant Files, Existing Patterns, Recent Changes, Tasks, Approach

### 3. NPM Scripts ✓
README.md Development section (lines 237-248) correctly lists only existing scripts:
- `npm test` (runs unit tests)
- `npm run test:integration` (runs integration tests)
- `npm run bench` (runs benchmarks)

No reference to `npm run lint` (which doesn't exist).

### 4. Phase 4 and Phase 5 Documentation ✓
README.md includes complete sections:
- Phase 4: Context reuse optimization (lines 180-193)
- Phase 5: Metrics dashboard (lines 196-218) with `bench/dashboard.mjs --serve` and port 9876

### 5. CLAUDE.md Accuracy ✓
- Line count: "~1880 lines" (actual: 1879 lines) ✓
- Dependency: "depends on @anthropic-ai/sdk for Phase 2 SDK mode" ✓
- Env vars: RLM_AGENTIC_MODE, RLM_FAST_MODE (not the non-existent RLM_MODE) ✓
- Phase framing: No "Phase 2 adds the SDK" as future (it's already shipped) ✓

### 6. Skip-Detection Table ✓
README.md table (lines 157-164) matches shouldSkipRLM (rlm-hook.mjs lines 159-185):
- Short (<20 chars) - minInputLength check
- Simple command - simplePatterns regex (git status, npm, pwd)
- Single-word response - simplePatterns regex (yes, no, ok, thanks)
- Slash command - /^\/\w+$/ pattern
- Code-heavy paste - code block detection

No false patterns like "cargo build" or "bare question words".

## Conclusion

Documentation is accurate, complete, and matches the shipped code (rlm-hook.mjs). No changes needed.
