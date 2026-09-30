# Preresearch output schema

The Haiku response is parsed as a JSON object and then wrapped in one of the
two output tags below. The producer should emit every required field for its
mode. The hook is intentionally tolerant at runtime: missing fields are
rendered with empty/default values, invalid arrays are treated as empty, and a
response that is not a JSON object becomes a `skip_rlm` result.

Unknown fields are preserved in the JSON block and ignored by the human-readable
summary. `skip` is the fast/agentic legacy skip flag; `skip_rlm` is the
detailed-mode equivalent. When either is `true`, the hook exits without
emitting an analysis block.

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
