# Preresearch output schema

The Haiku response is parsed as a JSON object and then wrapped in one of the
two output tags below. The producer should emit every required field for its
mode. The hook is intentionally tolerant at runtime: missing fields are
rendered with empty/default values, invalid arrays are treated as empty, and a
response that is not a JSON object becomes a `skip_rlm` result.

Unknown fields are preserved within the bounds below and ignored by the human-readable
summary. `skip` is the fast/agentic legacy skip flag; `skip_rlm` is the
detailed-mode equivalent. When either is `true`, the hook exits without
emitting an analysis block.

## Injected-output bound

The hook treats Haiku output as untrusted data. The default total injected
stdout cap is **12,000 characters**. `RLM_MAX_OUTPUT_CHARS` accepts a decimal
integer; values below 2,000 become 2,000, values above 32,000 become 32,000,
and invalid values use the default. These are JavaScript string characters,
not tokens or UTF-8 bytes, and include the newline printed after the block.

Truncation is deterministic and retains the first entries in source order:

1. Every string is limited to 2,000 characters with a visible
   `... [truncated N chars]` suffix. Every array keeps its first 40 items,
   every object its first 40 keys, each key is limited to 128 characters,
   and containers deeper than five levels become empty containers. Unknown
   top-level fields keep their first 25 keys.
2. If the serialized JSON still exceeds the configured cap, all unknown
   top-level fields are dropped. If needed, strings shrink to 200 characters
   and arrays to four items. If dense nested content still will not fit, the
   JSON becomes a small truncation notice. Structured changes set
   `rlm_truncated: true`.
3. The fully rendered output is capped separately. The JSON block and its
   closing tag stay whole. The repeated plain-text summary is cut first and
   receives `... [rlm output truncated at N chars]`. If the block itself is
   too large, its body is replaced by a parseable truncation notice.

RLM tags and Markdown fences appearing in strings or keys are rewritten as
bracketed text before emission. This stops delimiter splicing but does not
validate the truth of the model's findings or make them instructions.

## Semantic-cache transport behavior

Semantic cache lookup is layered after the exact SHA-256 lookup. A SHA hit
returns the cached schema without contacting the embedding service. On a SHA
miss, the embedding request is bounded by `RLM_EMBED_TIMEOUT` (default 5,000
ms), including response-body parsing. An unreachable, slow, non-2xx, or
malformed embedding service is logged to `RLM_LOG_FILE`, treated as a semantic
miss, and followed by the normal Haiku path with exit code 0. There is no
second SHA lookup after the embedding attempt: the SHA-only behavior is the
initial exact lookup plus normal processing after an exact miss. A failed
post-Haiku embedding write does not invalidate the JSON SHA cache entry.

## Agentic mode

Output tag: `<rlm_preresearch>`

Required top-level fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `intent` | string | `code_writing`, `debugging`, `refactoring`, `architecture`, `learning`, or `other` |
| `summary` | string | Short synthesis of the request and findings |
| `relevant_files` | array | Relevant path entries; each entry is a path string or an object with required `path` and optional `purpose`/`key_exports` |
| `existing_patterns` | string array | Patterns already used in the repository |
| `recent_changes` | string | Relevant git history |
| `dependencies` | string array | Relevant packages, services, or modules |
| `tasks` | string array | Concrete follow-up investigation/implementation tasks |
| `approach` | string | Recommended implementation approach |
| `warnings` | string array | Risks or caveats; use `[]` when there are none |

Optional fields are `skip`, `skip_reason`, and `key_exports` on individual
`relevant_files` entries. A minimal useful agentic response still includes the
summary, relevant files, tasks, and approach; the remaining required fields
should be emitted as empty strings/arrays when no findings exist.

## Fast mode

Output tag: `<rlm_analysis>`

| Field | Type | Meaning |
| --- | --- | --- |
| `intent` | string | `code_writing`, `debugging`, `architecture`, `learning`, or `other` |
| `tasks` | string array | Up to three concise tasks |
| `tech` | string array | Relevant technologies |
| `files` | string array | Likely relevant paths |
| `approach` | string | One-sentence strategy |

All five fields are required for a normal response. `skip` and `skip_reason`
are optional and may be returned for a trivial request.

## Detailed mode

Output tag: `<rlm_analysis>`

| Field | Type | Meaning |
| --- | --- | --- |
| `intent` | object | Contains required `primary`, `secondary` (string array), and `confidence` (number from 0 to 1) |
| `decomposition` | object array | Each item has `task`, `priority` (1–5), and `dependencies` (string array) |
| `implicit_context` | object | Contains `domain`, `assumed_knowledge` (string array), and `relevant_technologies` (string array) |
| `ambiguities` | object array | Each item has `aspect`, `interpretations` (string array), and `suggested_default` |
| `success_criteria` | string array | Observable completion criteria |
| `suggested_approach` | string | High-level strategy |
| `skip_rlm` | boolean | Whether detailed analysis should be skipped |
| `skip_reason` | string or null | Why it was skipped; `null` for a normal response |

These fields are required for a normal detailed response. `skip` is accepted
as an optional legacy alias, and a `skip_rlm: true` response may omit analysis
fields while providing `skip_reason`.

## Accepted transport forms

The parser accepts, in order:

1. A direct JSON object.
2. A JSON object in a fenced block (```json or an unlabelled ``` fence).
3. A balanced JSON object embedded in explanatory text, including nested
   objects and braces inside JSON strings.

Anything else is converted to:

```json
{"skip_rlm":true,"skip_reason":"Could not parse Haiku response"}
```
