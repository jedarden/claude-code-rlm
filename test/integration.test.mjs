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
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
// 5. Very long input truncation
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
// 8. RLM_DEBUG=true
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
// 9. Empty prompt
// ---------------------------------------------------------------------------

describe('Empty prompt', { timeout: 5000 }, () => {
  it('{"prompt":""} → exit 0 and empty stdout (0 chars < 20-char minimum)', async () => {
    const { code, stdout } = await spawnHook(JSON.stringify({ prompt: '' }));
    assert.equal(code, 0, 'Exit code must be 0 for empty prompt');
    assert.equal(stdout, '', 'Empty prompt must produce empty stdout');
  });
});

// ---------------------------------------------------------------------------
// 10. Concurrent safety
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
