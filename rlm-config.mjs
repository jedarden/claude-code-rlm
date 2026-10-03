import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULTS = Object.freeze({
  minInputLength: 20,
  maxInputLength: 4000,
  cacheTTL: 3600,
  haikuModel: 'claude-haiku-4-5-20251001',
  timeout: 60000,
  maxTurns: 10,
  fastMode: true,
  gatherContext: true,
  useSDK: false,
  sdkMaxTokens: 2048,
  semanticCache: false,
  semanticThreshold: 0.92,
  embedModel: 'text-embedding-3-small',
  embedBaseUrl: 'https://api.openai.com/v1',
  contextWindow: 5,
  debug: false,
  sessionResume: false,
  sessionResumeMaxTurns: 20,
});

function parseInteger(value, fallback) {
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function parseNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function stringValue(env, name, fallback) {
  return typeof env[name] === 'string' && env[name] !== '' ? env[name] : fallback;
}

function expandTilde(value, home) {
  return value?.startsWith('~/') ? join(home, value.slice(2)) : value;
}

/**
 * Build the runtime configuration from an environment-like object.
 * Invalid typed overrides fall back to the documented default so one bad
 * setting cannot disable a safety gate or produce NaN in the hook.
 */
export function createConfig(env = process.env, home = homedir()) {
  return {
    minInputLength: parseInteger(env.RLM_MIN_LENGTH, DEFAULTS.minInputLength),
    maxInputLength: parseInteger(env.RLM_MAX_LENGTH, DEFAULTS.maxInputLength),
    cacheTTL: parseInteger(env.RLM_CACHE_TTL, DEFAULTS.cacheTTL),
    haikuModel: stringValue(env, 'RLM_MODEL', DEFAULTS.haikuModel),
    timeout: parseInteger(env.RLM_TIMEOUT, DEFAULTS.timeout),
    cacheDir: expandTilde(
      stringValue(env, 'RLM_CACHE_DIR', join(home, '.cache', 'rlm-hook')),
      home,
    ),
    logFile: expandTilde(
      stringValue(env, 'RLM_LOG_FILE', join(home, '.local', 'share', 'rlm-hook', 'rlm-hook.log')),
      home,
    ),
    metricsFile: expandTilde(
      stringValue(env, 'RLM_METRICS_FILE', join(home, '.local', 'share', 'rlm-hook', 'metrics.jsonl')),
      home,
    ),
    agenticMode: parseBoolean(env.RLM_AGENTIC_MODE, true),
    maxTurns: parseInteger(env.RLM_MAX_TURNS, DEFAULTS.maxTurns),
    fastMode: parseBoolean(env.RLM_FAST_MODE, DEFAULTS.fastMode),
    gatherContext: parseBoolean(env.RLM_GATHER_CONTEXT, DEFAULTS.gatherContext),
    useSDK: parseBoolean(env.RLM_USE_SDK, DEFAULTS.useSDK),
    apiKey: env.ANTHROPIC_API_KEY || null,
    sdkMaxTokens: parseInteger(env.RLM_SDK_MAX_TOKENS, DEFAULTS.sdkMaxTokens),
    semanticCache: parseBoolean(env.RLM_SEMANTIC_CACHE, DEFAULTS.semanticCache),
    semanticThreshold: parseNumber(
      env.RLM_SEMANTIC_THRESHOLD,
      DEFAULTS.semanticThreshold,
      { min: 0, max: 1 },
    ),
    embedModel: stringValue(env, 'RLM_EMBED_MODEL', DEFAULTS.embedModel),
    embedApiKey: env.OPENAI_API_KEY || null,
    embedBaseUrl: stringValue(env, 'RLM_EMBED_BASE_URL', DEFAULTS.embedBaseUrl),
    contextWindow: parseInteger(env.RLM_CONTEXT_WINDOW, DEFAULTS.contextWindow),
    debug: parseBoolean(env.RLM_DEBUG, DEFAULTS.debug),
    sessionResume: parseBoolean(env.RLM_SESSION_RESUME, DEFAULTS.sessionResume),
    sessionResumeMaxTurns: parseInteger(
      env.RLM_SESSION_RESUME_MAX_TURNS,
      DEFAULTS.sessionResumeMaxTurns,
    ),
  };
}

export function selectMode({ agenticMode, fastMode }) {
  if (agenticMode) return 'agentic';
  return fastMode ? 'fast' : 'detailed';
}

export function shouldUseSDK({ useSDK, apiKey }) {
  return useSDK === true && typeof apiKey === 'string' && apiKey.length > 0;
}

export { DEFAULTS };
