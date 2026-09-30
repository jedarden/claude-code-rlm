/**
 * Parsing and runtime normalization for Haiku's preresearch response.
 *
 * The model is prompted for one of the mode-specific shapes documented in
 * docs/notes/preresearch-schema.md. This module deliberately keeps the
 * consumer tolerant: a malformed response becomes a skip result and invalid
 * optional fields are reduced to safe empty values instead of breaking the
 * hook.
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
 * Always returns an object so callers can safely inspect skip flags.
 */
export function parsePreresearchResponse(response) {
  if (typeof response !== 'string') return { ...PARSE_FAILURE };

  const trimmed = response.trim();
  const direct = parseObject(trimmed);
  if (direct) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of trimmed.matchAll(fenced)) {
    const parsed = parseObject(match[1].trim());
    if (parsed) return parsed;
  }

  return extractBalancedObject(trimmed) || { ...PARSE_FAILURE };
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
 */
export function normalizePreresearch(value) {
  if (!isRecord(value)) return { ...PARSE_FAILURE, skip_reason: 'Response was not a JSON object' };

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

  return normalized;
}
