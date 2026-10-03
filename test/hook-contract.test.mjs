#!/usr/bin/env node
/**
 * End-to-end contract tests for rlm-hook.mjs.
 *
 * Each test starts the real hook as a subprocess and supplies a temporary
 * fake `claude` executable. The fake executable lets these tests exercise the
 * hook boundary without requiring a Claude CLI installation or an API key.
 *
 * Run with: node --test test/hook-contract.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../rlm-hook.mjs', import.meta.url));

const ANALYSIS = {
  intent: 'code_writing',
  summary: 'The hook received and analyzed the user request.',
  relevant_files: [
    { path: 'src/contract.js', purpose: 'The contract implementation.' },
  ],
  existing_patterns: ['Temporary fake CLI output'],
  recent_changes: 'No recent changes.',
  tasks: ['Verify the hook contract'],
  approach: 'Return structured context to the parent process.',
  warnings: [],
};

/**
 * Create a fake claude executable. Its behavior is selected through
 * FAKE_CLAUDE_MODE so one script can cover success, failure, and timeout.
 */
async function createEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'rlm-hook-contract-'));
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });

  const capturePath = join(root, 'claude-args.json');
  const pidPath = join(root, 'claude.pid');
  const fakeClaude = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);

if (process.env.FAKE_CLAUDE_CAPTURE) {
  writeFileSync(process.env.FAKE_CLAUDE_CAPTURE, JSON.stringify(args));
}

if (process.env.FAKE_CLAUDE_CREATE_SCRATCH === 'true') {
  const addDirIndex = args.indexOf('--add-dir');
  const projectDir = addDirIndex >= 0 ? args[addDirIndex + 1] : null;
  if (projectDir) {
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(
      join(projectDir, '.claude', 'rlm-scratch-' + process.ppid + '.md'),
      'temporary notes',
    );
  }
}

if (process.env.FAKE_CLAUDE_MODE === 'failure') {
  process.stderr.write('synthetic subprocess failure');
  process.exit(42);
}

if (process.env.FAKE_CLAUDE_MODE === 'timeout') {
  setTimeout(() => {}, 60000);
} else if (process.env.FAKE_CLAUDE_MODE === 'stubborn-timeout') {
  if (process.env.FAKE_CLAUDE_PID) {
    writeFileSync(process.env.FAKE_CLAUDE_PID, String(process.pid));
  }
  process.on('SIGTERM', () => {});
  setTimeout(() => {}, 60000);
} else {
  process.stdout.write(${JSON.stringify(JSON.stringify(ANALYSIS))});
}
`;
  await writeFile(join(binDir, 'claude'), fakeClaude, { mode: 0o755 });

  return {
    root,
    binDir,
    capturePath,
    pidPath,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      RLM_AGENTIC_MODE: 'true',
      RLM_GATHER_CONTEXT: 'false',
      RLM_SEMANTIC_CACHE: 'false',
      RLM_CACHE_DIR: join(root, 'cache'),
      RLM_LOG_FILE: join(root, 'hook.log'),
      RLM_METRICS_FILE: join(root, 'metrics.jsonl'),
      FAKE_CLAUDE_CAPTURE: capturePath,
      FAKE_CLAUDE_PID: pidPath,
    },
  };
}

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

/** Spawn the real hook and collect its complete process boundary result. */
function runHook(input, environment, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: environment.root,
      env: { ...process.env, ...environment.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => finish({ code: null, stdout, stderr, error }));
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr }));

    child.stdin.end(input);
  });
}

async function destroyEnvironment(environment) {
  await rm(environment.root, { recursive: true, force: true });
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

describe('hook process contract', { timeout: 10000 }, () => {
  it('parses JSON stdin, forwards prompt/cwd, and injects stdout context', async () => {
    const environment = await createEnvironment();
    try {
      const projectDir = join(environment.root, 'project');
      await mkdir(projectDir, { recursive: true });
      const prompt = 'Implement JSON stdin handling without losing hook context.';
      const result = await runHook(
        JSON.stringify({ prompt, cwd: projectDir }),
        environment,
      );

      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /^<rlm_preresearch>/);
      assert.match(result.stdout, /The hook received and analyzed the user request\./);
      assert.match(result.stdout, /src\/contract\.js/);
      assert.match(result.stdout, /PRERESEARCH COMPLETE:/);

      const args = JSON.parse(await readFile(environment.capturePath, 'utf8'));
      const promptIndex = args.indexOf('-p');
      assert.notEqual(promptIndex, -1, 'claude must receive a -p prompt argument');
      assert.match(args[promptIndex + 1], new RegExp(`USER REQUEST: ${prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      const addDirIndex = args.indexOf('--add-dir');
      assert.notEqual(addDirIndex, -1, 'JSON cwd must be forwarded as --add-dir');
      assert.equal(args[addDirIndex + 1], projectDir);
    } finally {
      await destroyEnvironment(environment);
    }
  });

  it('rejects malformed JSON without invoking the subprocess or emitting context', async () => {
    const environment = await createEnvironment();
    try {
      const malformed = '{"prompt":"Implement malformed input recovery.';
      const result = await runHook(malformed, environment);
      const log = await readIfPresent(environment.env.RLM_LOG_FILE);
      const metrics = (await readIfPresent(environment.env.RLM_METRICS_FILE))
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

      assert.equal(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(await readIfPresent(environment.capturePath), '');
      assert.match(log, /ERROR: Invalid hook input: stdin must be valid JSON/);
      assert.equal(metrics.at(-1).event, 'error');
      assert.equal(metrics.at(-1).cache_hit, false);
      assert.equal(metrics.at(-1).reason, 'Invalid hook input: stdin must be valid JSON');
    } finally {
      await destroyEnvironment(environment);
    }
  });

  it('rejects an incomplete JSON object without a false success', async () => {
    const environment = await createEnvironment();
    try {
      const result = await runHook(
        JSON.stringify({ cwd: environment.root }),
        environment,
      );
      const log = await readIfPresent(environment.env.RLM_LOG_FILE);

      assert.equal(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(await readIfPresent(environment.capturePath), '');
      assert.match(
        log,
        /ERROR: Invalid hook input: stdin JSON must include a non-empty prompt, message, input, or content string/,
      );
    } finally {
      await destroyEnvironment(environment);
    }
  });

  it('degrades on a failed subprocess with exit code zero and an error log', async () => {
    const environment = await createEnvironment();
    try {
      const sensitivePrompt = 'Review the failure path; bearer-token=do-not-log-this-value';
      const result = await runHook(
        JSON.stringify({ prompt: sensitivePrompt }),
        environment,
        { FAKE_CLAUDE_MODE: 'failure' },
      );
      const log = await readIfPresent(environment.env.RLM_LOG_FILE);
      const metrics = (await readIfPresent(environment.env.RLM_METRICS_FILE))
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.error, undefined);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.match(log, /ERROR: Haiku failed \(exit 42\): synthetic subprocess failure/);
      assert.equal(log.includes(sensitivePrompt), false, 'error log must not include the user prompt');
      assert.equal(metrics.at(-1).event, 'error');
      assert.equal(metrics.at(-1).cache_hit, false);
      assert.equal(metrics.at(-1).reason, 'Haiku failed (exit 42): synthetic subprocess failure');
      assert.equal(JSON.stringify(metrics).includes(sensitivePrompt), false, 'error metrics must not include the user prompt');
    } finally {
      await destroyEnvironment(environment);
    }
  });

  it('degrades on a timed-out subprocess with exit code zero and an error log', async () => {
    const environment = await createEnvironment();
    try {
      const sensitivePrompt = 'Recover from timeout; session-secret=do-not-log-this-value';
      const result = await runHook(
        JSON.stringify({ prompt: sensitivePrompt }),
        environment,
        { FAKE_CLAUDE_MODE: 'timeout', RLM_TIMEOUT: '100' },
      );
      const log = await readIfPresent(environment.env.RLM_LOG_FILE);
      const metrics = await readIfPresent(environment.env.RLM_METRICS_FILE);

      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.error, undefined);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.match(log, /ERROR: Haiku invocation timed out/);
      assert.equal(log.includes(sensitivePrompt), false, 'timeout log must not include the user prompt');
      assert.match(metrics, /"event":"error"/);
      assert.match(metrics, /"reason":"Haiku invocation timed out"/);
      assert.equal(metrics.includes(sensitivePrompt), false, 'timeout metrics must not include the user prompt');
    } finally {
      await destroyEnvironment(environment);
    }
  });

  it('kills a timed-out child that ignores SIGTERM before returning', async () => {
    const environment = await createEnvironment();
    let childPid = null;
    try {
      const startedAt = Date.now();
      const result = await runHook(
        JSON.stringify({ prompt: 'Implement cleanup for a stubborn timeout subprocess.' }),
        environment,
        { FAKE_CLAUDE_MODE: 'stubborn-timeout', RLM_TIMEOUT: '250' },
      );
      const elapsed = Date.now() - startedAt;
      const log = await readIfPresent(environment.env.RLM_LOG_FILE);
      const metrics = (await readIfPresent(environment.env.RLM_METRICS_FILE))
        .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const pidText = await readIfPresent(environment.pidPath);
      childPid = Number(pidText);

      assert.ok(Number.isInteger(childPid) && childPid > 0, 'stalled child must report its PID');
      assert.ok(elapsed >= 200, `timeout must not fire before its configured window (${elapsed}ms)`);
      assert.ok(elapsed < 5000, `timeout cleanup must return promptly (${elapsed}ms)`);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.match(log, /ERROR: Haiku invocation timed out/);
      assert.equal(metrics.at(-1).event, 'error');
      assert.equal(metrics.at(-1).cache_hit, false);
      assert.equal(metrics.at(-1).reason, 'Haiku invocation timed out');
      assert.equal(
        await waitForProcessExit(childPid),
        true,
        'timeout cleanup must not leave the stalled child running',
      );
    } finally {
      if (childPid && isProcessRunning(childPid)) {
        try { process.kill(childPid, 'SIGKILL'); } catch {}
      }
      await destroyEnvironment(environment);
    }
  });

  it('uses the narrow agentic allowlist and cleans scratch files on success and failure', async () => {
    for (const mode of ['success', 'failure']) {
      const environment = await createEnvironment();
      try {
        const projectDir = join(environment.root, 'project');
        await mkdir(projectDir, { recursive: true });
        const result = await runHook(
          JSON.stringify({
            prompt: `Verify agentic permissions on the ${mode} path and clean scratch safely.`,
            cwd: projectDir,
          }),
          environment,
          {
            FAKE_CLAUDE_MODE: mode,
            FAKE_CLAUDE_CREATE_SCRATCH: 'true',
          },
        );

        const args = JSON.parse(await readFile(environment.capturePath, 'utf8'));
        const allowedToolsIndex = args.indexOf('--allowedTools');
        assert.notEqual(allowedToolsIndex, -1, `${mode}: allowlist flag must be present`);
        assert.equal(
          args[allowedToolsIndex + 1],
          'Read,Glob,Grep,Write,Bash(git:*),Bash(rm .claude/rlm-scratch-*.md)',
          `${mode}: only exploration, git, and scoped scratch cleanup are allowed`,
        );
        assert.equal(
          args[args.indexOf('--permission-mode') + 1],
          'bypassPermissions',
          `${mode}: hook must use its isolated permission mode`,
        );
        assert.equal(args.includes('Edit'), false, `${mode}: Edit must not be allowed`);
        assert.equal(args.includes('Bash'), false, `${mode}: unrestricted Bash must not be allowed`);

        assert.equal(result.code, 0, `${mode}: hook must degrade to exit 0`);
        if (mode === 'success') {
          assert.match(result.stdout, /The hook received and analyzed the user request\./);
        } else {
          assert.equal(result.stdout, '', 'failure path must not emit partial context');
        }

        assert.deepEqual(
          await readdir(join(projectDir, '.claude')),
          [],
          `${mode}: PID-scoped scratch file must be removed after the hook finishes`,
        );
      } finally {
        await destroyEnvironment(environment);
      }
    }
  });
});
