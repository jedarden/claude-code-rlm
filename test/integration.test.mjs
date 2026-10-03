#!/usr/bin/env node
/**
 * Integration tests for rlm-hook.mjs.
 *
 * Spawns real `node rlm-hook.mjs` subprocesses for each scenario.
 * Does NOT require the real claude CLI — a fake `claude` binary (a tiny
 * Node.js script) is injected at the front of PATH for tests that would
 * otherwise reach the Haiku invocation step.
 *
 * Run with: node --test test/integration.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const HOOK = join(__dirname, '..', 'rlm-hook.mjs');

// ---------------------------------------------------------------------------
// Fake claude setup (top-level await — runs once before any test)
//
// The fake binary accepts any arguments, ignores them, and prints a known
// analysis JSON to stdout.  This lets tests exercise the full
// invoke → parse → cache → format → output pipeline without the real CLI.
// ---------------------------------------------------------------------------

const FAKE_DIR = join(tmpdir(), `rlm-fake-claude-${Date.now()}`);
await mkdir(FAKE_DIR, { recursive: true });
await writeFile(
  join(FAKE_DIR, 'claude'),
  `#!/usr/bin/env node
// Fake claude for rlm-hook integration tests — ignores all args
if (process.env.RLM_CLAUDE_TRACE_FILE) {
  require('node:fs').appendFileSync(process.env.RLM_CLAUDE_TRACE_FILE, 'invoked\\n');
}
process.stdout.write(JSON.stringify({
  "intent": "code_writing",
  "tasks": ["Analyze request", "Implement solution", "Add tests"],
  "tech": ["Node.js"],
  "files": ["src/main.js"],
  "approach": "Follow existing codebase patterns"
}));
`,
  { mode: 0o755 },
);

// A local ESM loader makes the spawned hook resolve its lazy SDK import to a
// deterministic fake. The fake records constructor/create calls and can model
// success, API errors, or a multi-turn tool-use exchange without network I/O.
await writeFile(
  join(FAKE_DIR, 'sdk-loader.mjs'),
  `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@anthropic-ai/sdk') {
    return { url: new URL('./fake-anthropic-sdk.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`,
);

await writeFile(
  join(FAKE_DIR, 'sdk-unavailable-loader.mjs'),
  `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@anthropic-ai/sdk') {
    throw new Error("Cannot find package '@anthropic-ai/sdk'");
  }
  return nextResolve(specifier, context);
}
`,
);

await writeFile(
  join(FAKE_DIR, 'fake-anthropic-sdk.mjs'),
  `import { appendFileSync } from 'node:fs';

function trace(event) {
  const path = process.env.RLM_SDK_TRACE_FILE;
  if (path) appendFileSync(path, JSON.stringify(event) + '\\n');
}

function response(content, stop_reason = 'end_turn') {
  return {
    id: 'msg_integration_test',
    type: 'message',
    role: 'assistant',
    content,
    stop_reason,
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

export default class Anthropic {
  constructor(options = {}) {
    trace({ event: 'construct', apiKey: options.apiKey ?? null });
    this.callCount = 0;
    this.messages = {
      create: async (request) => {
        this.callCount += 1;
        trace({ event: 'create', call: this.callCount, request });

        if (process.env.RLM_SDK_SCENARIO === 'api-error') {
          throw new Error('synthetic API 401: invalid integration-test key');
        }

        if (process.env.RLM_SDK_SCENARIO === 'multi-tool') {
          if (this.callCount === 1) {
            return response([
              { type: 'text', text: 'First tool round' },
              { type: 'tool_use', id: 'tool-read', name: 'Read', input: { path: 'fixture.txt' } },
              { type: 'tool_use', id: 'tool-glob', name: 'Glob', input: { pattern: '*.txt' } },
            ], 'tool_use');
          }
          if (this.callCount === 2) {
            return response([
              { type: 'text', text: 'Second tool round' },
              { type: 'tool_use', id: 'tool-grep', name: 'Grep', input: { pattern: 'needle', path: 'fixture.txt' } },
              { type: 'tool_use', id: 'tool-read-2', name: 'Read', input: { path: 'other.txt' } },
            ], 'tool_use');
          }
          return response([
            { type: 'text', text: JSON.stringify({
              intent: 'code_writing',
              summary: 'SDK completed after two tool rounds',
              relevant_files: [{ path: 'fixture.txt', purpose: 'contains the searched result' }],
              tasks: ['Use the gathered findings'],
              approach: 'Continue after every tool result and then complete',
            }) },
          ]);
        }

        return response([
          { type: 'text', text: JSON.stringify({
            intent: 'code_writing',
            summary: 'SDK model response',
            tasks: ['Use the direct SDK result'],
            approach: 'Return the model response without spawning the CLI',
          }) },
        ]);
      },
    };
  }
}
`,
);

// Prepend the fake claude to PATH so every subprocess finds it first
const FAKE_PATH = `${FAKE_DIR}${':'}${process.env.PATH}`;

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

/**
 * Spawn the hook as a child process, write optional stdin, collect results.
 *
 * @param {string|undefined} stdinData  Written to stdin before closing it.
 * @param {object} [opts]
 * @param {string} [opts.cacheDir]   Override RLM_CACHE_DIR.
 * @param {object} [opts.env]        Extra env vars merged on top.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function spawnHook(stdinData, { cacheDir, env = {} } = {}) {
  return new Promise((resolve) => {
    const resolvedCacheDir =
      cacheDir ??
      join(tmpdir(), `rlm-c-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    const proc = spawn('node', [HOOK], {
      env: {
        ...process.env,
        PATH: FAKE_PATH,                  // fake claude available
        RLM_LOG_FILE: '/dev/null',        // suppress log file writes
        RLM_CACHE_DIR: resolvedCacheDir,
        RLM_AGENTIC_MODE: 'false',        // simpler tool invocation
        RLM_GATHER_CONTEXT: 'false',      // skip git/find, keeps tests fast
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));

    if (stdinData !== undefined) proc.stdin.write(stdinData);
    proc.stdin.end();
  });
}

function sdkLoaderEnv(loader, traceFile, scenario = 'response') {
  return {
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--experimental-loader=${loader}`]
      .filter(Boolean)
      .join(' '),
    RLM_SDK_TRACE_FILE: traceFile,
    RLM_SDK_SCENARIO: scenario,
  };
}

async function readJsonLines(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readTextOrEmpty(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function cacheKey(prompt, cwd = '') {
  return createHash('sha256').update(prompt + '\0' + cwd).digest('hex');
}

// ---------------------------------------------------------------------------
// 1. --version flag
// ---------------------------------------------------------------------------

describe('--version flag', { timeout: 5000 }, () => {
  it('stdout is "0.1.0\\n" and exit code is 0', async () => {
    const result = await new Promise((resolve) => {
      const proc = spawn('node', [HOOK, '--version'], {
        env: { ...process.env, RLM_LOG_FILE: '/dev/null' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.on('close', (code) => resolve({ code: code ?? 1, stdout }));
      proc.stdin.end();
    });

    assert.equal(result.code, 0, `Expected exit 0, got ${result.code}`);
    assert.equal(
      result.stdout,
      '0.1.0\n',
      `Expected "0.1.0\\n", got ${JSON.stringify(result.stdout)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Short input skip
// ---------------------------------------------------------------------------

describe('Short input skip', { timeout: 5000 }, () => {
  it('{"prompt":"ls"} → exit 0 and empty stdout', async () => {
    // "ls" is 2 chars — well below the 20-char minimum; exits before Haiku
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: 'ls' }));
    assert.equal(code, 0, 'Exit code must be 0');
    assert.equal(stdout, '', `Expected empty stdout, got: ${JSON.stringify(stdout)}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Slash command skip
// ---------------------------------------------------------------------------

describe('Slash command skip', { timeout: 5000 }, () => {
  it('{"prompt":"/help"} → exit 0 and empty stdout', async () => {
    // "/help" is 5 chars (<20) AND matches the slash-command pattern
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: '/help' }));
    assert.equal(code, 0, 'Exit code must be 0');
    assert.equal(stdout, '', `Expected empty stdout, got: ${JSON.stringify(stdout)}`);
  });
});

// ---------------------------------------------------------------------------
// 4. CLI command skip
// ---------------------------------------------------------------------------

describe('CLI command skip', { timeout: 5000 }, () => {
  it('{"prompt":"git status"} → exit 0 and empty stdout', async () => {
    // "git status" is 10 chars (<20) and also matches the CLI-command pattern
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: 'git status' }));
    assert.equal(code, 0, 'Exit code must be 0');
    assert.equal(stdout, '', `Expected empty stdout, got: ${JSON.stringify(stdout)}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Skip-detection boundaries
//
// These cases deliberately use prompts at or above the default minimum so
// command and code-shape detection cannot pass accidentally via the length
// gate. Each subprocess gets an isolated cache so a prior test cannot change
// which path the hook takes.
// ---------------------------------------------------------------------------

describe('Skip-detection boundaries', { timeout: 10000 }, () => {
  it('skips below the default minimum and analyzes at exactly 20 characters', async () => {
    const cacheDir = join(tmpdir(), `rlm-boundary-min-${Date.now()}`);

    const below = await spawnHook(JSON.stringify({ prompt: 'x'.repeat(19) }), { cacheDir });
    assert.equal(below.code, 0, 'Below-threshold input must exit successfully');
    assert.equal(below.stdout, '', '19 characters must be skipped');

    const atBoundary = await spawnHook(JSON.stringify({ prompt: 'x'.repeat(20) }), { cacheDir });
    assert.equal(atBoundary.code, 0, 'Boundary input must exit successfully');
    assert.match(
      atBoundary.stdout,
      /code_writing/,
      'Exactly 20 characters must pass the length gate and reach the analyzer',
    );

    await rm(cacheDir, { recursive: true, force: true });
  });

  it('honors RLM_MIN_LENGTH overrides at the configured boundary', async () => {
    const cacheDir = join(tmpdir(), `rlm-boundary-env-${Date.now()}`);
    const prompt = 'y'.repeat(25);

    const overridden = await spawnHook(JSON.stringify({ prompt }), {
      cacheDir,
      env: { RLM_MIN_LENGTH: '30' },
    });
    assert.equal(overridden.code, 0);
    assert.equal(overridden.stdout, '', '25 characters must skip when the minimum is overridden to 30');

    const atOverride = await spawnHook(JSON.stringify({ prompt }), {
      cacheDir,
      env: { RLM_MIN_LENGTH: '25' },
    });
    assert.equal(atOverride.code, 0);
    assert.match(atOverride.stdout, /code_writing/, 'Input at the overridden minimum must be analyzed');

    await rm(cacheDir, { recursive: true, force: true });
  });

  it('recognizes long CLI and slash commands independently of the length gate', async () => {
    const prompts = [
      'git status --short --branch',
      '/aaaaaaaaaaaaaaaaaaaa',
    ];

    for (const prompt of prompts) {
      assert.ok(prompt.length >= 20, `${prompt} must exercise command detection above the minimum`);
      const result = await spawnHook(JSON.stringify({ prompt }));
      assert.equal(result.code, 0, `${prompt} must exit successfully`);
      assert.equal(result.stdout, '', `${prompt} must be skipped as a simple command`);
    }
  });

  it('skips multiple code blocks when code is the majority, but not a single block', async () => {
    const codeHeavy = [
      '```js\nconst first = 1;\n```',
      '```js\nconst second = 2;\n```',
      'Review.',
    ].join('\n');
    const codeHeavyResult = await spawnHook(JSON.stringify({ prompt: codeHeavy }));
    assert.equal(codeHeavyResult.code, 0);
    assert.equal(codeHeavyResult.stdout, '', 'Multiple majority-code blocks must be skipped');

    const oneBlock = '```js\nconst only = 1;\n```\nExplain the migration risks and suggest the next steps.';
    const oneBlockResult = await spawnHook(JSON.stringify({ prompt: oneBlock }));
    assert.equal(oneBlockResult.code, 0);
    assert.match(oneBlockResult.stdout, /code_writing/, 'A single code block must not trigger code-heavy skipping');
  });

  it('checks skip detection before reading a matching cache entry', async () => {
    const cacheDir = join(tmpdir(), `rlm-boundary-cache-${Date.now()}`);
    const prompt = 'git status --short --branch';
    const key = cacheKey(prompt);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, `${key}.json`),
      JSON.stringify({ intent: 'cached-result-must-not-be-used' }),
    );

    const result = await spawnHook(JSON.stringify({ prompt }), { cacheDir });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '', 'A skippable prompt must remain silent even when cached');

    await rm(cacheDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 6. Very long input truncation
// ---------------------------------------------------------------------------

describe('Very long input truncation', { timeout: 5000 }, () => {
  it('prompt of 5000 "A"s → does not crash, exits 0', async () => {
    // 5000 A's pass skip checks; hook truncates to 4000 chars then calls the
    // fake claude, which succeeds immediately → exit 0
    const { code } = await spawnHook(JSON.stringify({ prompt: 'A'.repeat(5000) }));
    assert.equal(code, 0, 'Hook must exit 0 for very long input');
  });
});

// ---------------------------------------------------------------------------
// 6. Malformed JSON input
// ---------------------------------------------------------------------------

describe('Malformed JSON input', { timeout: 5000 }, () => {
  it('raw non-JSON string longer than 20 chars → exit 0', async () => {
    // JSON.parse fails → hook treats raw stdin as the message.
    // The raw string is long enough to pass skip checks; fake claude handles it.
    const raw =
      'just text that is long enough to not be skipped immediately ' +
      'but is not JSON at all and will cause parse to use raw text';
    const { code } = await spawnHook(raw);
    assert.equal(code, 0, 'Hook must exit 0 for non-JSON stdin');
  });
});

// ---------------------------------------------------------------------------
// 7. Cache round-trip
//
// First call: fake claude runs, hook saves result to cache, outputs analysis.
// Second call: hook reads from cache (no fake claude needed), outputs same
// analysis faster.
// ---------------------------------------------------------------------------

describe('Cache round-trip', { timeout: 10000 }, () => {
  // Shared cache dir so second call finds what first call wrote
  let cacheDir;

  before(async () => {
    cacheDir = join(tmpdir(), `rlm-rt-${Date.now()}`);
    await mkdir(cacheDir, { recursive: true });
  });

  after(async () => {
    try { await rm(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const COMPLEX_PROMPT =
    'I need to implement a Redis-based distributed lock mechanism for my ' +
    'Node.js microservices to prevent race conditions when multiple instances ' +
    'try to update the same database record simultaneously.';

  it('first call: fake claude runs and hook outputs formatted analysis', async () => {
    const { code, stdout } = await spawnHook(
      JSON.stringify({ prompt: COMPLEX_PROMPT }),
      { cacheDir },
    );
    assert.equal(code, 0, 'Exit code must be 0');
    assert.ok(stdout.length > 0, 'First call must produce formatted output');
    assert.ok(
      stdout.includes('code_writing'),
      `Output must contain the intent from fake claude; got: ${stdout.slice(0, 200)}`,
    );
  });

  it('second call: cache hit — same output, completes under 2 s', async () => {
    const t0 = Date.now();
    const { code, stdout } = await spawnHook(
      JSON.stringify({ prompt: COMPLEX_PROMPT }),
      { cacheDir },
    );
    const elapsed = Date.now() - t0;

    assert.equal(code, 0, 'Exit code must be 0');
    assert.ok(stdout.length > 0, 'Second (cache-hit) call must produce output');
    assert.ok(
      stdout.includes('code_writing'),
      'Output must still contain the cached intent',
    );
    // A cache hit skips the Haiku invocation so it completes much faster
    assert.ok(elapsed < 2000, `Cache hit should finish in < 2 000 ms, took ${elapsed} ms`);
  });
});

// ---------------------------------------------------------------------------
// 8. SHA cache TTL and corruption handling
//
// Cache reads are deliberately best-effort: an expired or malformed entry,
// or an unavailable cache directory, must never prevent the normal Haiku path
// from running or make the hook return a failure status.
// ---------------------------------------------------------------------------

describe('SHA cache TTL and corruption handling', { timeout: 10000 }, () => {
  const cachedAnalysis = {
    intent: 'cached_sha',
    tasks: ['Use the exact cached result'],
    approach: 'Return the SHA cache entry without invoking Haiku',
  };

  it('uses a fresh SHA entry and skips normal processing', async () => {
    const cacheDir = join(tmpdir(), `rlm-sha-hit-${Date.now()}`);
    const traceFile = join(cacheDir, 'claude-trace.log');
    const prompt = 'Use the fresh SHA cache entry for this integration test.';
    const key = cacheKey(prompt);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(cacheDir, `${key}.json`), JSON.stringify(cachedAnalysis));

    try {
      const result = await spawnHook(JSON.stringify({ prompt }), {
        cacheDir,
        env: { RLM_CLAUDE_TRACE_FILE: traceFile },
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Use the exact cached result/);
      assert.equal(await readTextOrEmpty(traceFile), '', 'a fresh SHA hit must not invoke Haiku');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('lazily evicts expired entries and falls through to normal processing', async () => {
    const cacheDir = join(tmpdir(), `rlm-sha-expired-${Date.now()}`);
    const traceFile = join(cacheDir, 'claude-trace.log');
    const prompt = 'Replace the expired SHA cache entry in this integration test.';
    const key = cacheKey(prompt);
    const cacheFile = join(cacheDir, `${key}.json`);
    const orphanedEmbedding = join(cacheDir, `${key}.embedding`);
    const expiredAt = new Date(Date.now() - 10_000);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ ...cachedAnalysis, tasks: ['Expired result'] }));
    await writeFile(orphanedEmbedding, Buffer.from([0, 0, 0, 0]));
    await utimes(cacheFile, expiredAt, expiredAt);

    try {
      const result = await spawnHook(JSON.stringify({ prompt }), {
        cacheDir,
        env: {
          RLM_CACHE_TTL: '1',
          RLM_CLAUDE_TRACE_FILE: traceFile,
        },
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Follow existing codebase patterns/);
      assert.doesNotMatch(result.stdout, /Expired result/);
      assert.equal((await readTextOrEmpty(traceFile)).trim(), 'invoked');
      assert.ok((await stat(cacheFile)).mtimeMs > expiredAt.getTime(), 'normal processing must repopulate the expired key');
      await assert.rejects(() => readFile(orphanedEmbedding), /ENOENT/);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('treats malformed cache JSON as a miss and replaces it with normal output', async () => {
    const cacheDir = join(tmpdir(), `rlm-sha-malformed-${Date.now()}`);
    const traceFile = join(cacheDir, 'claude-trace.log');
    const prompt = 'Recover from malformed SHA cache JSON in this integration test.';
    const key = cacheKey(prompt);
    const cacheFile = join(cacheDir, `${key}.json`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, '{ this is not valid JSON');

    try {
      const result = await spawnHook(JSON.stringify({ prompt }), {
        cacheDir,
        env: { RLM_CLAUDE_TRACE_FILE: traceFile },
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Follow existing codebase patterns/);
      assert.equal((await readTextOrEmpty(traceFile)).trim(), 'invoked');
      assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).approach, 'Follow existing codebase patterns');
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('continues through an unreadable cache directory without blocking the hook', async () => {
    const cacheDir = join(tmpdir(), `rlm-sha-unreadable-${Date.now()}`);
    const traceFile = join(tmpdir(), `rlm-sha-unreadable-trace-${Date.now()}`);
    const prompt = 'Continue normal processing when the SHA cache is unreadable.';
    await mkdir(cacheDir, { recursive: true });
    await chmod(cacheDir, 0o000);

    try {
      const result = await spawnHook(JSON.stringify({ prompt }), {
        cacheDir,
        env: { RLM_CLAUDE_TRACE_FILE: traceFile },
      });

      assert.equal(result.code, 0);
      assert.equal((await readTextOrEmpty(traceFile)).trim(), 'invoked', 'cache read failure must fall through to Haiku');
    } finally {
      await chmod(cacheDir, 0o700);
      await rm(cacheDir, { recursive: true, force: true });
      await rm(traceFile, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. RLM_DEBUG=true
// ---------------------------------------------------------------------------

describe('RLM_DEBUG=true', { timeout: 5000 }, () => {
  it('debug mode with skippable prompt → exit 0 (debug does not break skip logic)', async () => {
    const { code } = await spawnHook(
      JSON.stringify({ prompt: 'ls' }),
      { env: { RLM_DEBUG: 'true' } },
    );
    assert.equal(code, 0, 'Debug mode must not interfere with the skip path');
  });
});

// ---------------------------------------------------------------------------
// 10. Empty prompt
// ---------------------------------------------------------------------------

describe('Empty prompt', { timeout: 5000 }, () => {
  it('{"prompt":""} → exit 0 and empty stdout (0 chars < 20-char minimum)', async () => {
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: '' }));
    assert.equal(code, 0, 'Exit code must be 0 for empty prompt');
    assert.equal(stdout, '', 'Empty prompt must produce empty stdout');
  });
});

// ---------------------------------------------------------------------------
// 11. Concurrent safety
// ---------------------------------------------------------------------------

describe('Concurrent safety', { timeout: 15000 }, () => {
  it('3 simultaneous hook processes with same skippable prompt all exit 0', async () => {
    const cacheDir = join(tmpdir(), `rlm-conc-skip-${Date.now()}`);
    const input = JSON.stringify({ prompt: 'ls' });

    const results = await Promise.all([
      spawnHook(input, { cacheDir }),
      spawnHook(input, { cacheDir }),
      spawnHook(input, { cacheDir }),
    ]);

    for (let i = 0; i < results.length; i++) {
      assert.equal(results[i].code, 0, `Process ${i} must exit 0`);
    }
  });

  it('3 simultaneous hook processes with same complex prompt all exit 0 (cache write race)', async () => {
    // All three reach the fake claude, get the same JSON, and race to write
    // the same cache file.  All must still exit 0.
    const cacheDir = join(tmpdir(), `rlm-conc-complex-${Date.now()}`);
    await mkdir(cacheDir, { recursive: true });

    const complexPrompt =
      'Implement a WebSocket-based real-time collaboration feature for a document ' +
      'editor with conflict resolution using operational transforms and CRDT data ' +
      'structures for distributed systems across multiple geographic regions.';
    const input = JSON.stringify({ prompt: complexPrompt });

    const results = await Promise.all([
      spawnHook(input, { cacheDir }),
      spawnHook(input, { cacheDir }),
      spawnHook(input, { cacheDir }),
    ]);

    for (let i = 0; i < results.length; i++) {
      assert.equal(
        results[i].code,
        0,
        `Process ${i} must exit 0 despite possible concurrent cache writes`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 11. SDK-Direct mode (Phase 2)
//
// The hook lazily does `import('@anthropic-ai/sdk')`. Faithfully mocking that
// bare ESM specifier from a spawned subprocess is awkward (NODE_PATH is ignored
// for ESM and the real package is already resolvable from the repo's
// node_modules), so instead of stubbing a *successful* SDK call we exercise the
// far more important robustness contract: when SDK-Direct mode is enabled but
// the API call cannot succeed, the hook must fall back to the subprocess path
// and still emit valid `<rlm_preresearch>` output — never break the turn, never
// emit garbage.
//
// We force a deterministic, network-independent SDK failure by pointing the SDK
// at an unreachable base URL (127.0.0.1:1 → immediate ECONNREFUSED). The SDK's
// retries exhaust quickly, the call throws, and main() falls through to the
// fake `claude` binary on PATH. A complex prompt clears every skip gate.
// ---------------------------------------------------------------------------

describe('SDK-Direct mode', { timeout: 25000 }, () => {
  const SDK_PROMPT =
    'Refactor the authentication middleware to support JWT refresh tokens and ' +
    'add rate limiting per user so that abusive clients cannot exhaust the ' +
    'login endpoint, then write integration tests covering token expiry.';

  // Unreachable base URL → the SDK call fails fast and locally.
  const UNREACHABLE = 'http://127.0.0.1:1';

  it('fast SDK path: SDK failure falls back to subprocess, still emits analysis', async () => {
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: SDK_PROMPT }), {
      env: {
        RLM_USE_SDK: 'true',
        ANTHROPIC_API_KEY: 'sk-ant-fake-integration-key',
        ANTHROPIC_BASE_URL: UNREACHABLE,
        // spawnHook already sets RLM_AGENTIC_MODE=false → fast/detailed SDK path
      },
    });
    assert.equal(code, 0, 'Hook must exit 0 when the SDK path fails');
    assert.ok(
      stdout.includes('code_writing'),
      `Fallback must produce the fake-claude analysis; got: ${stdout.slice(0, 200)}`,
    );
  });

  it('agentic SDK path: SDK failure falls back to subprocess, still emits analysis', async () => {
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: SDK_PROMPT }), {
      env: {
        RLM_USE_SDK: 'true',
        RLM_AGENTIC_MODE: 'true',
        ANTHROPIC_API_KEY: 'sk-ant-fake-integration-key',
        ANTHROPIC_BASE_URL: UNREACHABLE,
      },
    });
    assert.equal(code, 0, 'Hook must exit 0 when the agentic SDK path fails');
    assert.ok(
      stdout.includes('code_writing'),
      `Agentic fallback must produce the fake-claude analysis; got: ${stdout.slice(0, 200)}`,
    );
  });

  it('SDK enabled but no API key: routing guard goes straight to subprocess', async () => {
    // RLM_USE_SDK=true with an empty key → shouldUseSDK() is false → no SDK
    // call is attempted at all; the hook uses the subprocess path immediately.
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: SDK_PROMPT }), {
      env: {
        RLM_USE_SDK: 'true',
        ANTHROPIC_API_KEY: '',          // empty → CONFIG.apiKey === null
        ANTHROPIC_BASE_URL: UNREACHABLE, // proves it never gets used
      },
    });
    assert.equal(code, 0, 'Hook must exit 0 with SDK enabled but no key');
    assert.ok(
      stdout.includes('code_writing'),
      `No-key path must use the subprocess; got: ${stdout.slice(0, 200)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 12. SDK selection, responses, and tool-loop integration
//
// These scenarios use the local ESM loader above instead of a network server or
// a real API key. That keeps the tests deterministic while still exercising the
// real spawned hook, lazy SDK import, routing guard, response parsing, and
// subprocess fallback boundaries.
// ---------------------------------------------------------------------------

describe('SDK selection and tool-loop integration', { timeout: 15000 }, () => {
  const SDK_PROMPT =
    'Review the authentication service and explain how to add refresh-token ' +
    'rotation while preserving the existing integration-test conventions.';

  it('direct SDK usage reaches the complete metric with normalized fields', async () => {
    const trace = join(tmpdir(), `rlm-sdk-direct-usage-${Date.now()}-${Math.random()}.jsonl`);
    const metrics = join(tmpdir(), `rlm-sdk-direct-metrics-${Date.now()}-${Math.random()}.jsonl`);
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: SDK_PROMPT }), {
      env: {
        ...sdkLoaderEnv(join(FAKE_DIR, 'sdk-loader.mjs'), trace),
        ANTHROPIC_API_KEY: 'integration-test-key',
        RLM_USE_SDK: 'true',
        RLM_AGENTIC_MODE: 'false',
        RLM_METRICS_FILE: metrics,
      },
    });

    assert.equal(code, 0);
    assert.match(stdout, /SDK model response/);
    const complete = (await readJsonLines(metrics)).find((event) => event.event === 'complete');
    assert.deepEqual(complete?.token_estimate, { input_tokens: 11, output_tokens: 7 });
  });

  it('SDK enabled with an API key selects SDK and returns the model response', async () => {
    const trace = join(tmpdir(), `rlm-sdk-response-${Date.now()}-${Math.random()}.jsonl`);
    const cliTrace = join(tmpdir(), `rlm-sdk-response-cli-${Date.now()}-${Math.random()}.log`);
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: SDK_PROMPT }), {
      env: {
        ...sdkLoaderEnv(join(FAKE_DIR, 'sdk-loader.mjs'), trace),
        RLM_CLAUDE_TRACE_FILE: cliTrace,
        ANTHROPIC_API_KEY: 'integration-test-key',
        RLM_USE_SDK: 'true',
        RLM_AGENTIC_MODE: 'true',
      },
    });

    assert.equal(code, 0, 'SDK success must exit 0');
    assert.match(stdout, /SDK model response/, 'formatted output must contain the SDK text');
    assert.equal(await readTextOrEmpty(cliTrace), '', 'successful SDK calls must not spawn claude');

    const events = await readJsonLines(trace);
    assert.equal(events[0]?.event, 'construct', 'SDK client must be constructed');
    assert.equal(events[0]?.apiKey, 'integration-test-key', 'API key must reach the SDK client');
    assert.equal(events.filter((event) => event.event === 'create').length, 1);
    assert.equal(events[1].request.model, 'claude-haiku-4-5-20251001');
    assert.equal(events[1].request.messages[0].role, 'user');
  });

  it('unavailable SDK falls back to the subprocess path', async () => {
    const trace = join(tmpdir(), `rlm-sdk-unavailable-${Date.now()}-${Math.random()}.jsonl`);
    const cliTrace = join(tmpdir(), `rlm-sdk-unavailable-cli-${Date.now()}-${Math.random()}.log`);
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: SDK_PROMPT }), {
      env: {
        ...sdkLoaderEnv(join(FAKE_DIR, 'sdk-unavailable-loader.mjs'), trace),
        RLM_CLAUDE_TRACE_FILE: cliTrace,
        ANTHROPIC_API_KEY: 'integration-test-key',
        RLM_USE_SDK: 'true',
      },
    });

    assert.equal(code, 0, 'unavailable SDK must not block the hook');
    assert.match(stdout, /code_writing/, 'subprocess fallback must emit its analysis');
    assert.equal(await readJsonLines(trace).then((events) => events.length), 0);
    assert.equal(await readTextOrEmpty(cliTrace), 'invoked\n', 'fallback must invoke claude once');
  });

  it('SDK API errors fall back to the subprocess response', async () => {
    const trace = join(tmpdir(), `rlm-sdk-error-${Date.now()}-${Math.random()}.jsonl`);
    const cliTrace = join(tmpdir(), `rlm-sdk-error-cli-${Date.now()}-${Math.random()}.log`);
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: SDK_PROMPT }), {
      env: {
        ...sdkLoaderEnv(join(FAKE_DIR, 'sdk-loader.mjs'), trace, 'api-error'),
        RLM_CLAUDE_TRACE_FILE: cliTrace,
        ANTHROPIC_API_KEY: 'integration-test-key',
        RLM_USE_SDK: 'true',
      },
    });

    assert.equal(code, 0, 'SDK API errors must not block the hook');
    assert.match(stdout, /code_writing/, 'API-error fallback must emit subprocess analysis');
    const events = await readJsonLines(trace);
    assert.equal(events.filter((event) => event.event === 'create').length, 1);
    assert.equal(await readTextOrEmpty(cliTrace), 'invoked\n', 'API-error fallback must invoke claude once');
  });

  it('agentic SDK continues after multiple tool calls and completes', async () => {
    const trace = join(tmpdir(), `rlm-sdk-tools-${Date.now()}-${Math.random()}.jsonl`);
    const cliTrace = join(tmpdir(), `rlm-sdk-tools-cli-${Date.now()}-${Math.random()}.log`);
    const metrics = join(tmpdir(), `rlm-sdk-tools-metrics-${Date.now()}-${Math.random()}.jsonl`);
    const projectDir = join(tmpdir(), `rlm-sdk-tools-project-${Date.now()}-${Math.random()}`);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'fixture.txt'), 'needle: first fixture result\n');
    await writeFile(join(projectDir, 'other.txt'), 'second fixture result\n');

    const { code, stdout } = await spawnHook(JSON.stringify({
      prompt: SDK_PROMPT,
      cwd: projectDir,
    }), {
      env: {
        ...sdkLoaderEnv(join(FAKE_DIR, 'sdk-loader.mjs'), trace, 'multi-tool'),
        RLM_CLAUDE_TRACE_FILE: cliTrace,
        ANTHROPIC_API_KEY: 'integration-test-key',
        RLM_USE_SDK: 'true',
        RLM_AGENTIC_MODE: 'true',
        RLM_METRICS_FILE: metrics,
      },
    });

    assert.equal(code, 0, 'completed tool loop must exit 0');
    assert.match(stdout, /SDK completed after two tool rounds/);
    assert.equal(await readTextOrEmpty(cliTrace), '', 'successful tool loops must not spawn claude');

    const calls = (await readJsonLines(trace)).filter((event) => event.event === 'create');
    assert.equal(calls.length, 3, 'the model must receive two tool rounds and a final completion call');
    assert.equal(calls[0].request.tools.length, 5, 'agentic SDK request must advertise all tools');
    assert.equal(calls[0].request.messages.length, 1);

    const firstResults = calls[1].request.messages.at(-1);
    assert.equal(firstResults.role, 'user');
    assert.deepEqual(firstResults.content.map((result) => result.tool_use_id), ['tool-read', 'tool-glob']);
    assert.match(firstResults.content[0].content, /needle: first fixture result/);
    assert.match(firstResults.content[1].content, /fixture\.txt/);

    const secondResults = calls[2].request.messages.at(-1);
    assert.deepEqual(secondResults.content.map((result) => result.tool_use_id), ['tool-grep', 'tool-read-2']);
    assert.match(secondResults.content[0].content, /needle: first fixture result/);
    assert.match(secondResults.content[1].content, /second fixture result/);

    const complete = (await readJsonLines(metrics)).find((event) => event.event === 'complete');
    assert.deepEqual(complete?.token_estimate, { input_tokens: 33, output_tokens: 21 },
      'complete metric sums usage from all three SDK turns');
  });
});
