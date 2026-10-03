import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createConfig, DEFAULTS, selectMode, shouldUseSDK } from '../rlm-config.mjs';

const TEST_HOME = '/tmp/rlm-config-test-home';

describe('RLM configuration defaults', () => {
  it('uses the documented defaults when no environment overrides are present', () => {
    const config = createConfig({}, TEST_HOME);

    assert.equal(config.minInputLength, DEFAULTS.minInputLength);
    assert.equal(config.maxInputLength, DEFAULTS.maxInputLength);
    assert.equal(config.cacheTTL, DEFAULTS.cacheTTL);
    assert.equal(config.haikuModel, DEFAULTS.haikuModel);
    assert.equal(config.timeout, DEFAULTS.timeout);
    assert.equal(config.maxTurns, DEFAULTS.maxTurns);
    assert.equal(config.fastMode, true);
    assert.equal(config.agenticMode, true);
    assert.equal(config.gatherContext, true);
    assert.equal(config.useSDK, false);
    assert.equal(config.sdkMaxTokens, DEFAULTS.sdkMaxTokens);
    assert.equal(config.semanticCache, false);
    assert.equal(config.semanticThreshold, DEFAULTS.semanticThreshold);
    assert.equal(config.embedModel, DEFAULTS.embedModel);
    assert.equal(config.embedBaseUrl, DEFAULTS.embedBaseUrl);
    assert.equal(config.contextWindow, DEFAULTS.contextWindow);
    assert.equal(config.debug, false);
    assert.equal(config.sessionResume, false);
    assert.equal(config.sessionResumeMaxTurns, DEFAULTS.sessionResumeMaxTurns);
    assert.equal(config.cacheDir, join(TEST_HOME, '.cache', 'rlm-hook'));
    assert.equal(config.logFile, join(TEST_HOME, '.local', 'share', 'rlm-hook', 'rlm-hook.log'));
    assert.equal(config.metricsFile, join(TEST_HOME, '.local', 'share', 'rlm-hook', 'metrics.jsonl'));
    assert.equal(config.apiKey, null);
    assert.equal(config.embedApiKey, null);
  });
});

describe('RLM configuration environment overrides', () => {
  it('parses valid numeric, string, boolean, path, and credential overrides', () => {
    const config = createConfig({
      RLM_MIN_LENGTH: '12',
      RLM_MAX_LENGTH: '1200',
      RLM_CACHE_TTL: '90',
      RLM_MODEL: 'test-model',
      RLM_TIMEOUT: '2500',
      RLM_CACHE_DIR: '~/cache',
      RLM_LOG_FILE: '~/hook.log',
      RLM_METRICS_FILE: '~/metrics.jsonl',
      RLM_AGENTIC_MODE: 'false',
      RLM_MAX_TURNS: '3',
      RLM_FAST_MODE: 'false',
      RLM_GATHER_CONTEXT: 'false',
      RLM_USE_SDK: 'true',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      RLM_SDK_MAX_TOKENS: '1024',
      RLM_SEMANTIC_CACHE: 'true',
      RLM_SEMANTIC_THRESHOLD: '0.85',
      RLM_EMBED_MODEL: 'test-embedding-model',
      OPENAI_API_KEY: 'test-openai-key',
      RLM_EMBED_BASE_URL: 'http://localhost:8080/v1',
      RLM_CONTEXT_WINDOW: '8',
      RLM_DEBUG: 'true',
      RLM_SESSION_RESUME: 'true',
      RLM_SESSION_RESUME_MAX_TURNS: '7',
    }, TEST_HOME);

    assert.deepEqual(
      {
        minInputLength: config.minInputLength,
        maxInputLength: config.maxInputLength,
        cacheTTL: config.cacheTTL,
        haikuModel: config.haikuModel,
        timeout: config.timeout,
        cacheDir: config.cacheDir,
        logFile: config.logFile,
        metricsFile: config.metricsFile,
        agenticMode: config.agenticMode,
        maxTurns: config.maxTurns,
        fastMode: config.fastMode,
        gatherContext: config.gatherContext,
        useSDK: config.useSDK,
        apiKey: config.apiKey,
        sdkMaxTokens: config.sdkMaxTokens,
        semanticCache: config.semanticCache,
        semanticThreshold: config.semanticThreshold,
        embedModel: config.embedModel,
        embedApiKey: config.embedApiKey,
        embedBaseUrl: config.embedBaseUrl,
        contextWindow: config.contextWindow,
        debug: config.debug,
        sessionResume: config.sessionResume,
        sessionResumeMaxTurns: config.sessionResumeMaxTurns,
      },
      {
        minInputLength: 12,
        maxInputLength: 1200,
        cacheTTL: 90,
        haikuModel: 'test-model',
        timeout: 2500,
        cacheDir: join(TEST_HOME, 'cache'),
        logFile: join(TEST_HOME, 'hook.log'),
        metricsFile: join(TEST_HOME, 'metrics.jsonl'),
        agenticMode: false,
        maxTurns: 3,
        fastMode: false,
        gatherContext: false,
        useSDK: true,
        apiKey: 'test-anthropic-key',
        sdkMaxTokens: 1024,
        semanticCache: true,
        semanticThreshold: 0.85,
        embedModel: 'test-embedding-model',
        embedApiKey: 'test-openai-key',
        embedBaseUrl: 'http://localhost:8080/v1',
        contextWindow: 8,
        debug: true,
        sessionResume: true,
        sessionResumeMaxTurns: 7,
      },
    );
  });

  it('falls back to safe defaults for malformed typed overrides', () => {
    const config = createConfig({
      RLM_MIN_LENGTH: '20oops',
      RLM_MAX_LENGTH: 'not-a-number',
      RLM_CACHE_TTL: 'NaN',
      RLM_TIMEOUT: '1.5',
      RLM_AGENTIC_MODE: 'yes',
      RLM_MAX_TURNS: 'ten',
      RLM_FAST_MODE: '0',
      RLM_GATHER_CONTEXT: 'maybe',
      RLM_USE_SDK: 'on',
      RLM_SDK_MAX_TOKENS: '',
      RLM_SEMANTIC_CACHE: 'enabled',
      RLM_SEMANTIC_THRESHOLD: '1.2',
      RLM_CONTEXT_WINDOW: '-oops',
      RLM_DEBUG: 'verbose',
      RLM_SESSION_RESUME: '1',
      RLM_SESSION_RESUME_MAX_TURNS: '20 turns',
    }, TEST_HOME);

    assert.equal(config.minInputLength, DEFAULTS.minInputLength);
    assert.equal(config.maxInputLength, DEFAULTS.maxInputLength);
    assert.equal(config.cacheTTL, DEFAULTS.cacheTTL);
    assert.equal(config.timeout, DEFAULTS.timeout);
    assert.equal(config.agenticMode, true);
    assert.equal(config.maxTurns, DEFAULTS.maxTurns);
    assert.equal(config.fastMode, true);
    assert.equal(config.gatherContext, true);
    assert.equal(config.useSDK, false);
    assert.equal(config.sdkMaxTokens, DEFAULTS.sdkMaxTokens);
    assert.equal(config.semanticCache, false);
    assert.equal(config.semanticThreshold, DEFAULTS.semanticThreshold);
    assert.equal(config.contextWindow, DEFAULTS.contextWindow);
    assert.equal(config.debug, false);
    assert.equal(config.sessionResume, false);
    assert.equal(config.sessionResumeMaxTurns, DEFAULTS.sessionResumeMaxTurns);
  });
});

describe('RLM mode selection', () => {
  it('gives agentic mode precedence over fast and detailed modes', () => {
    assert.equal(selectMode({ agenticMode: true, fastMode: true }), 'agentic');
    assert.equal(selectMode({ agenticMode: true, fastMode: false }), 'agentic');
  });

  it('selects fast or detailed mode when agentic mode is disabled', () => {
    assert.equal(selectMode({ agenticMode: false, fastMode: true }), 'fast');
    assert.equal(selectMode({ agenticMode: false, fastMode: false }), 'detailed');
  });
});

describe('SDK gating', () => {
  it('requires both the explicit flag and a non-empty API key', () => {
    assert.equal(shouldUseSDK({ useSDK: true, apiKey: 'test-key' }), true);
    assert.equal(shouldUseSDK({ useSDK: false, apiKey: 'test-key' }), false);
    assert.equal(shouldUseSDK({ useSDK: true, apiKey: null }), false);
    assert.equal(shouldUseSDK({ useSDK: true, apiKey: '' }), false);
    assert.equal(shouldUseSDK({ useSDK: true, apiKey: 123 }), false);
  });
});
