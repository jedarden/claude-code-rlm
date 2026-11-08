/**
 * Parsing and runtime normalization for Haiku's preresearch response.
 *
 * The model is prompted for one of the mode-specific shapes documented in
 * docs/notes/preresearch-schema.md. This module deliberately keeps the
 * consumer tolerant: a malformed response becomes a skip result and invalid
 * optional fields are reduced to safe empty values instead of breaking the
 * hook.
 *
 * Injected-output hardening: whatever Haiku returns is treated as untrusted
 * DATA, never as instructions — content Haiku read from an untrusted
 * repository reaches the main model in the demarcated JSON block and repeated
 * plain-text summary. Three defenses live here so every
 * injection path (fresh Haiku run, SHA cache, semantic cache, Phase 4
 * prior-block reuse) inherits them through normalizePreresearch:
 *
 * 1. Structured size bounds — strings, arrays, nesting depth, and the number
 *    of unknown top-level keys are capped (tier 1), so no single field can
 *    carry an unbounded payload.
 * 2. Tag neutralization — the exact sequences <rlm_preresearch>,
 *    </rlm_preresearch>, <rlm_analysis>, and </rlm_analysis> in data are
 *    rewritten to [bracketed] text so data can never splice or spoof the
 *    block framing (which the transcript-recovery parser pairs on).
 * 3. Cap-pressure ladder — if the serialized object alone exceeds
 *    RLM_MAX_OUTPUT_CHARS, unknown fields are shed first (tier 2), then all
 *    content shrinks to a conservative floor (tier 3) that keeps the JSON
 *    parseable for transcript recovery. The fully rendered block is finally
 *    hard-capped by boundPreresearchOutput, which the hook applies to the
 *    exact text it emits.
 *
 * Structured elision or rewrite sets `rlm_truncated: true` on the result;
 * clipping only the repeated summary adds a visible marker. See
 * docs/notes/architecture.md ("Trust and injection surface") and
 * docs/notes/preresearch-schema.md.
 */

export const PRERESEARCH_SCHEMAS = Object.freeze({
  agentic: Object.freeze({
    tag: 'rlm_preresearch',
    required: Object.freeze([
      'intent',
      'summary',
      'relevant_files',
      'existing_patterns',
      'recent_changes',
      'dependencies',
      'tasks',
      'approach',
      'warnings',
    ]),
    optional: Object.freeze(['skip', 'skip_reason', 'relevant_files[].key_exports']),
  }),
  fast: Object.freeze({
    tag: 'rlm_analysis',
    required: Object.freeze(['intent', 'tasks', 'tech', 'files', 'approach']),
    optional: Object.freeze(['skip', 'skip_reason']),
  }),
  detailed: Object.freeze({
    tag: 'rlm_analysis',
    required: Object.freeze([
      'intent',
      'intent.primary',
      'intent.secondary',
      'intent.confidence',
      'decomposition',
      'implicit_context',
      'ambiguities',
      'success_criteria',
      'suggested_approach',
      'skip_rlm',
      'skip_reason',
    ]),
    optional: Object.freeze(['skip']),
  }),
});

const PARSE_FAILURE = Object.freeze({
  skip_rlm: true,
  skip_reason: 'Could not parse Haiku response',
});

const STRING_ARRAY_FIELDS = [
  'existing_patterns',
  'dependencies',
  'tasks',
  'warnings',
  'tech',
  'files',
  'success_criteria',
];

/**
 * Injected-output bounds. Tier-1 caps are generous enough that legitimate
 * analyses never hit them (a typical block is 1–3 KB); the tier-3 shrink
 * floor keeps worst-case output parseable under any input. Sizes are in
 * characters (not bytes/tokens) — the block is text injected into a prompt.
 */
export const PRERESEARCH_OUTPUT_BOUNDS = Object.freeze({
  /** Total injected output cap (RLM_MAX_OUTPUT_CHARS). */
  maxChars: 12000,
  /** Floor for the RLM_MAX_OUTPUT_CHARS override. */
  minChars: 2000,
  /** Ceiling for the RLM_MAX_OUTPUT_CHARS override. */
  maxConfiguredChars: 32000,
  /** Tier-1 per-string cap, truncation marker included. */
  maxStringChars: 2000,
  /** Tier-1 per-array item cap. */
  maxArrayItems: 40,
  /** Cap at every object level, including unknown nested objects. */
  maxObjectKeys: 40,
  /** Maximum length of each JSON object key. */
  maxKeyChars: 128,
  /** Tier-1 container nesting cap; deeper containers become safe empties. */
  maxDepth: 5,
  /** Tier-1 cap on unknown top-level keys (first-appearance order). */
  maxUnknownKeys: 25,
  /** Tier-3 shrink targets, applied only under cap pressure. */
  shrunkStringChars: 200,
  shrunkArrayItems: 4,
});

/** Field names normalizePreresearch sheds last under cap pressure. Derived
 * from PRERESEARCH_SCHEMAS (dotted/array paths reduce to their top-level
 * name) plus the hook's runtime flags, so the schema doc stays the single
 * source of truth. */
const KNOWN_FIELDS = new Set([
  'rlm_truncated',
  'reason', // skip-reason fallback read by the hook
  ...Object.values(PRERESEARCH_SCHEMAS).flatMap((schema) =>
    [...schema.required, ...schema.optional].map((field) => field.split(/[.[]/)[0])
  ),
]);

/**
 * Resolve the total-output cap. Only a plain positive integer is honored;
 * anything else — and any value below minChars, so a bad config cannot shrink
 * the bound into uselessness — falls back to the documented default.
 */
export function resolveMaxOutputChars(env = process.env) {
  const raw = env.RLM_MAX_OUTPUT_CHARS;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return PRERESEARCH_OUTPUT_BOUNDS.maxChars;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return PRERESEARCH_OUTPUT_BOUNDS.maxChars;
  return Math.min(PRERESEARCH_OUTPUT_BOUNDS.maxConfiguredChars,
    Math.max(PRERESEARCH_OUTPUT_BOUNDS.minChars, parsed));
}

const RLM_TAG_PATTERN = /<\s*(\/?)\s*(rlm_(?:preresearch|analysis))\s*>/gi;
const MARKDOWN_FENCE_PATTERN = /`{3,}/g;

/**
 * Defang RLM block-tag sequences embedded in model-produced strings.
 *
 * The injected block is demarcated by <rlm_preresearch>/<rlm_analysis> tags,
 * and the transcript-recovery parser pairs those exact sequences to recover
 * prior blocks. Data containing a closing tag would end the block early and
 * let the remainder escape the "this is untrusted preresearch data" framing;
 * data containing a full fake block could spoof the reuse path. Rewriting the
 * tag-like sequences and Markdown fences to bracketed text keeps them
 * human-readable while making them unmatchable as structural delimiters.
 * Idempotent: the rewritten form contains no tag or fence.
 */
export function neutralizeRlmTags(text) {
  if (typeof text !== 'string') return text;
  return text.replace(RLM_TAG_PATTERN, (_, slash, name) => `[${slash}${name.toLowerCase()}]`)
    .replace(MARKDOWN_FENCE_PATTERN, '[code fence]');
}

function truncateString(text, maxChars, state) {
  if (text.length <= maxChars) return text;
  state.modified = true;
  let omitted = text.length - maxChars;
  let marker;
  // The marker itself consumes part of the cap, so calculate the actual
  // number of omitted characters after reserving space for it.
  do {
    marker = `... [truncated ${omitted} chars]`;
    const next = text.length - Math.max(0, maxChars - marker.length);
    if (next === omitted) break;
    omitted = next;
  } while (true);
  return text.slice(0, text.length - omitted) + marker;
}

/**
 * Recursively bound a value: strings truncated (and tag-neutralized), arrays
 * sliced, containers deeper than maxDepth reduced to safe empties. Builds
 * fresh containers, so the caller's object (e.g. a cached analysis) is never
 * mutated.
 */
function boundValue(value, depth, limits, state) {
  if (typeof value === 'string') {
    const neutralized = neutralizeRlmTags(value);
    if (neutralized !== value) state.modified = true;
    return truncateString(neutralized, limits.maxStringChars, state);
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= limits.maxDepth) {
    state.modified = true;
    return Array.isArray(value) ? [] : {};
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) state.modified = true;
    return value.slice(0, limits.maxArrayItems).map((item) => boundValue(item, depth + 1, limits, state));
  }
  const bounded = {};
  let count = 0;
  for (const [rawKey, item] of Object.entries(value)) {
    if (count >= limits.maxObjectKeys) {
      state.modified = true;
      break;
    }
    const key = truncateString(neutralizeRlmTags(rawKey), limits.maxKeyChars, state);
    if (key !== rawKey) state.modified = true;
    // Define an own data property so JSON keys such as "__proto__" cannot
    // mutate the new container's prototype. A collision after key rewriting
    // keeps the first value in source order.
    if (Object.hasOwn(bounded, key)) {
      state.modified = true;
      continue;
    }
    Object.defineProperty(bounded, key, {
      value: boundValue(item, depth + 1, limits, state),
      enumerable: true,
      configurable: true,
      writable: true,
    });
    count += 1;
  }
  return bounded;
}

function serializedSize(value) {
  try {
    return JSON.stringify(value, null, 2)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY; // unserializable content must shed tiers
  }
}

function resolveBoundLimit(maxChars) {
  return typeof maxChars === 'number' && Number.isSafeInteger(maxChars)
    && maxChars >= 256
    ? Math.min(maxChars, PRERESEARCH_OUTPUT_BOUNDS.maxConfiguredChars)
    : resolveMaxOutputChars();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Find the first balanced JSON object in prose. A simple /\{.*?\}/ regex
 * stops at the first closing brace and cannot extract detailed-mode objects
 * containing nested intent/context/decomposition values.
 */
function extractBalancedObject(text) {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const character = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseObject(text.slice(start, index + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  return null;
}

/**
 * Parse direct JSON, fenced JSON, or a balanced object embedded in prose.
 * Return a normalized, injection-safe object even to callers that do not
 * perform a second normalization before using the result.
 */
export function parsePreresearchResponse(response) {
  if (typeof response !== 'string') return { ...PARSE_FAILURE };

  const trimmed = response.trim();
  const direct = parseObject(trimmed);
  if (direct) return normalizePreresearch(direct);

  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of trimmed.matchAll(fenced)) {
    const parsed = parseObject(match[1].trim());
    if (parsed) return normalizePreresearch(parsed);
  }

  const embedded = extractBalancedObject(trimmed);
  return embedded ? normalizePreresearch(embedded) : { ...PARSE_FAILURE };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === 'string' && item.trim().length > 0);
}

function normalizeRelevantFiles(value) {
  if (!Array.isArray(value)) return [];

  return value.flatMap(file => {
    if (typeof file === 'string' && file.trim().length > 0) return [file];
    if (!isRecord(file) || typeof file.path !== 'string' || file.path.trim().length === 0) {
      return [];
    }

    const normalized = { ...file, path: file.path };
    if (typeof normalized.purpose !== 'string') delete normalized.purpose;
    if (!Array.isArray(normalized.key_exports)) delete normalized.key_exports;
    return [normalized];
  });
}

function normalizeObjectArray(value, requiredKey) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => isRecord(item) && typeof item[requiredKey] === 'string');
}

/**
 * Normalize values used by formatOutput without inventing model findings.
 * Missing fields remain absent (so the serialized response preserves what the
 * model actually returned); invalid containers become safe empty values.
 *
 * The result is also bounded: every string/array/depth is capped at the tier-1
 * limits, RLM tag sequences in data are neutralized, and under cap pressure
 * (serialized object > maxChars, default from RLM_MAX_OUTPUT_CHARS) unknown
 * fields are shed (tier 2) and all content shrinks to the conservative floor
 * (tier 3). Any elision or rewrite sets `rlm_truncated: true`. Idempotent —
 * the hook normalizes on production, again on cache/reuse re-emission.
 */
export function normalizePreresearch(value, { maxChars } = {}) {
  if (!isRecord(value)) return { ...PARSE_FAILURE, skip_reason: 'Response was not a JSON object' };

  const limit = resolveBoundLimit(maxChars);
  const normalized = { ...value };

  for (const field of STRING_ARRAY_FIELDS) {
    if (field in normalized) normalized[field] = normalizeStringArray(normalized[field]);
  }

  if ('relevant_files' in normalized) {
    normalized.relevant_files = normalizeRelevantFiles(normalized.relevant_files);
  }
  if ('secondary' in normalized) normalized.secondary = normalizeStringArray(normalized.secondary);
  if ('decomposition' in normalized) {
    normalized.decomposition = normalizeObjectArray(normalized.decomposition, 'task');
  }
  if ('ambiguities' in normalized) {
    normalized.ambiguities = normalizeObjectArray(normalized.ambiguities, 'aspect');
  }

  if ('intent' in normalized && normalized.intent !== null
      && typeof normalized.intent !== 'string' && !isRecord(normalized.intent)) {
    normalized.intent = {};
  }
  if ('implicit_context' in normalized && !isRecord(normalized.implicit_context)) {
    normalized.implicit_context = {};
  }
  if (isRecord(normalized.implicit_context) && 'relevant_technologies' in normalized.implicit_context) {
    normalized.implicit_context = {
      ...normalized.implicit_context,
      relevant_technologies: normalizeStringArray(normalized.implicit_context.relevant_technologies),
    };
  }

  if ('skip_rlm' in normalized && typeof normalized.skip_rlm !== 'boolean') normalized.skip_rlm = false;
  if ('skip' in normalized && typeof normalized.skip !== 'boolean') normalized.skip = false;
  if ('rlm_truncated' in normalized && typeof normalized.rlm_truncated !== 'boolean') {
    normalized.rlm_truncated = false;
  }

  // Tier 1: bound every value. Builds fresh containers; never mutates the
  // caller's object (cached analyses are re-normalized on every emission).
  const state = { modified: false };
  const tier1 = {
    maxStringChars: PRERESEARCH_OUTPUT_BOUNDS.maxStringChars,
    maxArrayItems: PRERESEARCH_OUTPUT_BOUNDS.maxArrayItems,
    maxDepth: PRERESEARCH_OUTPUT_BOUNDS.maxDepth,
  };
  tier1.maxObjectKeys = PRERESEARCH_OUTPUT_BOUNDS.maxObjectKeys;
  tier1.maxKeyChars = PRERESEARCH_OUTPUT_BOUNDS.maxKeyChars;
  const bounded = boundValue(normalized, 0, tier1, state);

  // Unknown keys are kept in first-appearance order up to the tier-1 cap.
  let unknownKeys = Object.keys(bounded).filter((key) => !KNOWN_FIELDS.has(key));
  if (unknownKeys.length > PRERESEARCH_OUTPUT_BOUNDS.maxUnknownKeys) {
    state.modified = true;
    for (const key of unknownKeys.slice(PRERESEARCH_OUTPUT_BOUNDS.maxUnknownKeys)) {
      delete bounded[key];
    }
  }

  // Tier 2: cap pressure sheds unknown fields first.
  let size = serializedSize(bounded);
  let shed = false;
  if (size > limit) {
    unknownKeys = Object.keys(bounded).filter((key) => !KNOWN_FIELDS.has(key));
    if (unknownKeys.length > 0) {
      for (const key of unknownKeys) delete bounded[key];
      size = serializedSize(bounded);
    }
    shed = true;
  }

  // Tier 3: still over the cap with only known fields left — shrink all
  // content to the conservative floor. The result stays parseable so
  // transcript recovery can still reuse the block.
  if (size > limit) {
    const tier3 = {
      maxStringChars: PRERESEARCH_OUTPUT_BOUNDS.shrunkStringChars,
      maxArrayItems: PRERESEARCH_OUTPUT_BOUNDS.shrunkArrayItems,
      maxDepth: PRERESEARCH_OUTPUT_BOUNDS.maxDepth,
      maxObjectKeys: PRERESEARCH_OUTPUT_BOUNDS.maxObjectKeys,
      maxKeyChars: PRERESEARCH_OUTPUT_BOUNDS.maxKeyChars,
    };
    const shrinkState = { modified: true };
    for (const key of Object.keys(bounded)) {
      bounded[key] = boundValue(bounded[key], 1, tier3, shrinkState);
    }
    shed = true;
  }

  if (state.modified || shed) bounded.rlm_truncated = true;

  // Even after tier 3, a dense tree of nested known fields can exceed the
  // limit. Preserve a parseable, visibly elided response rather than relying
  // on a later byte cut through the JSON body.
  if (serializedSize(bounded) > limit) {
    return { rlm_truncated: true, summary: 'Preresearch findings omitted: size limit exceeded' };
  }

  return bounded;
}

/**
 * Final cap for the fully rendered injected block (JSON body + summary text).
 *
 * Applied by the hook to the exact stdout it emits, this is the hard bound
 * behind the structured tiers. It keeps the JSON block whole and parseable:
 * first omit the summary tail, and if the block itself does not fit, replace
 * its body with a small JSON truncation notice. The delimiter pair survives.
 */
export function boundPreresearchOutput(text, { maxChars } = {}) {
  if (typeof text !== 'string') return text;
  const limit = resolveBoundLimit(maxChars);
  if (text.length <= limit) return text;

  const marker = `\n... [rlm output truncated at ${limit} chars]`;
  const opening = text.startsWith('<rlm_preresearch>\n') ? 'rlm_preresearch'
    : text.startsWith('<rlm_analysis>\n') ? 'rlm_analysis' : null;
  if (opening) {
    const close = `\n</${opening}>`;
    const end = text.indexOf(close);
    if (end !== -1) {
      const body = text.slice(opening.length + 3, end);
      if (parseObject(body)) {
        const block = text.slice(0, end + close.length);
        if (block.length + marker.length <= limit) {
          return block + text.slice(end + close.length, limit - marker.length) + marker;
        }
      }
      const fallback = `<${opening}>\n${JSON.stringify({
        rlm_truncated: true,
        summary: 'Preresearch findings omitted: size limit exceeded',
      })}\n</${opening}>`;
      return fallback + marker;
    }
  }
  return text.slice(0, limit - marker.length) + marker;
}
