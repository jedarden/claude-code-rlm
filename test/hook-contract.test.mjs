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
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
 * FAKE_CLAUDE_MODE so one script can cover success, failure, timeout, and a
 * killed parent process.
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

if (process.env.FAKE_CLAUDE_MODE === 'echo-failure') {
  process.stderr.write(process.env.FAKE_CLAUDE_ECHO || 'synthetic subprocess failure');
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
} else if (process.env.FAKE_CLAUDE_MODE === 'kill-parent') {
  process.kill(process.ppid, 'SIGKILL');
  process.exit(137);
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
    child.on('close', (code, signal) => finish({ code, signal, pid: child.pid, stdout, stderr }));

    child.stdin.end(input);
  });
}

/** Execute the exact command installed as the subprocess's tool guard. */
function runToolGuard(command, event, cwd) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
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
      assert.match(log, /ERROR: Haiku failed \(exit 42\)/);
      assert.equal(log.includes(sensitivePrompt), false, 'error log must not include the user prompt');
      assert.equal(metrics.at(-1).event, 'error');
      assert.equal(metrics.at(-1).cache_hit, false);
      assert.equal(metrics.at(-1).reason, 'Haiku failed (exit 42)');
      assert.equal(JSON.stringify(metrics).includes(sensitivePrompt), false, 'error metrics must not include the user prompt');
    } finally {
      await destroyEnvironment(environment);
    }
  });

  it('does not persist prompt, transcript, or explored-file content in debug artifacts', async () => {
    const environment = await createEnvironment();
    try {
      const prompt = 'Inspect the payment path; prompt-secret-9f8c7b6a';
      const transcriptText = 'Earlier conversation carries transcript-secret-4e3d2c1b';
      const exploredFileText = 'Read output contains explored-file-secret-a7b6c5d4';
      const transcriptPath = join(environment.root, 'conversation.jsonl');
      await writeFile(transcriptPath, JSON.stringify({
        type: 'user',
        message: { content: transcriptText },
      }) + '\n');

      const result = await runHook(
        JSON.stringify({ prompt, transcript_path: transcriptPath }),
        environment,
        {
          FAKE_CLAUDE_MODE: 'echo-failure',
          FAKE_CLAUDE_ECHO: `${prompt} ${transcriptText} ${exploredFileText}`,
          RLM_DEBUG: 'true',
          RLM_GATHER_CONTEXT: 'true',
        },
      );
      const log = await readIfPresent(environment.env.RLM_LOG_FILE);
      const metrics = await readIfPresent(environment.env.RLM_METRICS_FILE);
      const persisted = `${log}\n${metrics}`;

      assert.equal(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      for (const secret of [prompt, transcriptText, exploredFileText]) {
        assert.equal(persisted.includes(secret), false, `observability files must omit ${secret}`);
      }
      assert.match(log, /ERROR: Haiku failed \(exit 42\)/);
      const record = JSON.parse(metrics.trim().split('\n').at(-1));
      assert.equal(record.input_len, prompt.length);
      assert.equal(record.reason, 'Haiku failed (exit 42)');
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
          'Read,Glob,Grep,Write,Bash(git status:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git branch:*),Bash(git ls-files:*),Bash(git remote:*),Bash(rm .claude/rlm-scratch-*.md)',
          `${mode}: only exploration, read-only git, and scoped scratch cleanup are allowed`,
        );
        assert.equal(args[allowedToolsIndex + 1].includes('Bash(git:*)'), false, `${mode}: broad git must not be allowed`);
        for (const subcommand of ['status', 'log', 'diff', 'show', 'branch', 'ls-files', 'remote']) {
          assert.equal(
            args[allowedToolsIndex + 1].includes(`Bash(git ${subcommand}:*)`),
            true,
            `${mode}: git ${subcommand} must be allowed`,
          );
        }
        for (const subcommand of ['commit', 'push', 'reset', 'clean', 'checkout', 'restore', 'blame']) {
          assert.equal(
            args[allowedToolsIndex + 1].includes(`Bash(git ${subcommand}:*)`),
            false,
            `${mode}: git ${subcommand} must not be allowed`,
          );
        }
        assert.equal(
          args[args.indexOf('--permission-mode') + 1],
          'bypassPermissions',
          `${mode}: protected .claude scratch path needs bypassPermissions`,
        );
        assert.equal(args.includes('--safe-mode'), false, `${mode}: safe mode would suppress the Write guard`);
        assert.equal(args[args.indexOf('--setting-sources') + 1], '', `${mode}: inherited settings must be disabled`);
        assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Write,Bash');
        assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__*');
        const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
        const [toolHook] = settings.hooks.PreToolUse;
        assert.equal(toolHook.matcher, 'Read|Glob|Grep|Write|Bash');
        const guardCommand = toolHook.hooks[0].command;
        assert.match(guardCommand, /--guard-agentic-tool/);
        assert.ok(guardCommand.includes(projectDir), `${mode}: guard receives the project root`);

        const insideFile = join(projectDir, 'inside.txt');
        const outsideFile = join(environment.root, 'outside.txt');
        const outsideDir = join(environment.root, 'outside-dir');
        await writeFile(insideFile, 'project content');
        await writeFile(outsideFile, 'outside content');
        await mkdir(outsideDir);
        await writeFile(join(outsideDir, 'secret.txt'), 'outside content');
        await symlink(insideFile, join(projectDir, 'inside-link.txt'));

        for (const event of [
          { tool_name: 'Read', tool_input: { file_path: insideFile } },
          { tool_name: 'Read', tool_input: { file_path: 'inside.txt' } },
          { tool_name: 'Read', tool_input: { file_path: 'inside-link.txt' } },
          { tool_name: 'Glob', tool_input: { pattern: '**/*.txt' } },
          { tool_name: 'Glob', tool_input: { pattern: '*.txt', path: '.' } },
          { tool_name: 'Grep', tool_input: { pattern: 'project' } },
          { tool_name: 'Grep', tool_input: { pattern: 'project', path: insideFile } },
          { tool_name: 'Grep', tool_input: { pattern: 'project', path: 'inside-link.txt' } },
        ]) {
          const allowedRead = await runToolGuard(guardCommand, event, projectDir);
          assert.equal(allowedRead.code, 0);
          assert.equal(allowedRead.stdout, '', `${mode}: project-local ${event.tool_name} must pass`);
        }

        for (const event of [
          { tool_name: 'Read', tool_input: { file_path: '../outside.txt' } },
          { tool_name: 'Read', tool_input: { file_path: outsideFile } },
          { tool_name: 'Read', tool_input: {} },
          { tool_name: 'Glob', tool_input: { pattern: '**/*.txt', path: outsideDir } },
          { tool_name: 'Glob', tool_input: { pattern: '../*.txt' } },
          { tool_name: 'Glob', tool_input: { pattern: '/etc/*' } },
          { tool_name: 'Grep', tool_input: { pattern: 'outside', path: '../outside.txt' } },
          { tool_name: 'Grep', tool_input: { pattern: 'outside', path: outsideDir } },
          { tool_name: 'Grep', tool_input: { pattern: 'outside', glob: '../*.txt' } },
          { tool_name: 'Grep', tool_input: {} },
        ]) {
          const blockedRead = await runToolGuard(guardCommand, event, projectDir);
          assert.equal(blockedRead.code, 0);
          assert.equal(JSON.parse(blockedRead.stdout).hookSpecificOutput.permissionDecision, 'deny',
            `${mode}: out-of-project or malformed ${event.tool_name} must be denied`);
        }

        await symlink(outsideFile, join(projectDir, 'outside-link.txt'));
        await symlink(outsideDir, join(projectDir, 'outside-link-dir'));
        for (const event of [
          { tool_name: 'Read', tool_input: { file_path: 'outside-link.txt' } },
          { tool_name: 'Grep', tool_input: { pattern: 'outside', path: 'outside-link.txt' } },
          { tool_name: 'Glob', tool_input: { pattern: '**/*.txt' } },
          { tool_name: 'Grep', tool_input: { pattern: 'outside' } },
        ]) {
          const blockedLink = await runToolGuard(guardCommand, event, projectDir);
          assert.equal(blockedLink.code, 0);
          assert.equal(JSON.parse(blockedLink.stdout).hookSpecificOutput.permissionDecision, 'deny',
            `${mode}: ${event.tool_name} must not follow an external project symlink`);
        }

        const scratchPath = join(projectDir, '.claude', `rlm-scratch-${result.pid}.md`);
        const allowed = await runToolGuard(guardCommand, {
          tool_name: 'Write', tool_input: { file_path: scratchPath, content: 'notes' },
        }, projectDir);
        assert.equal(allowed.code, 0);
        assert.equal(allowed.stdout, '', `${mode}: scratch Write must pass the guard`);

        for (const outsidePath of [join(projectDir, 'src', 'app.js'),
          join(projectDir, '.claude', `rlm-scratch-${result.pid + 1}.md`)]) {
          const blocked = await runToolGuard(guardCommand, {
            tool_name: 'Write', tool_input: { file_path: outsidePath, content: 'bad' },
          }, projectDir);
          assert.equal(blocked.code, 0);
          assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny',
            `${mode}: out-of-scope Write to ${outsidePath} must be rejected`);
        }
        for (const command of ['git status --short', `rm .claude/rlm-scratch-${result.pid}.md`]) {
          const allowedBash = await runToolGuard(guardCommand, {
            tool_name: 'Bash', tool_input: { command },
          }, projectDir);
          assert.equal(allowedBash.code, 0);
          assert.equal(allowedBash.stdout, '', `${mode}: ${command} must pass the guard`);
        }
        for (const command of ['git status; touch source.js', 'rm source.js',
          `rm .claude/rlm-scratch-${result.pid + 1}.md`]) {
          const blockedBash = await runToolGuard(guardCommand, {
            tool_name: 'Bash', tool_input: { command },
          }, projectDir);
          assert.equal(blockedBash.code, 0);
          assert.equal(JSON.parse(blockedBash.stdout).hookSpecificOutput.permissionDecision, 'deny',
            `${mode}: unsafe Bash command must be rejected`);
        }
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

  it('removes the orphaned scratch file from a killed run on the next startup', async () => {
    const environment = await createEnvironment();
    try {
      const projectDir = join(environment.root, 'project');
      await mkdir(projectDir, { recursive: true });

      const killed = await runHook(
        JSON.stringify({
          prompt: 'Leave an orphaned scratch file when the hook process is killed.',
          cwd: projectDir,
        }),
        environment,
        {
          FAKE_CLAUDE_MODE: 'kill-parent',
          FAKE_CLAUDE_CREATE_SCRATCH: 'true',
        },
      );

      assert.equal(killed.code, null);
      assert.equal(killed.signal, 'SIGKILL');
      const orphaned = await readdir(join(projectDir, '.claude'));
      assert.deepEqual(orphaned, [`rlm-scratch-${killed.pid}.md`]);

      const recovered = await runHook(
        JSON.stringify({
          prompt: 'Recover from the previous killed hook run and continue normally.',
          cwd: projectDir,
        }),
        environment,
      );

      assert.equal(recovered.code, 0);
      assert.match(recovered.stdout, /The hook received and analyzed the user request\./);
      assert.deepEqual(await readdir(join(projectDir, '.claude')), []);
    } finally {
      await destroyEnvironment(environment);
    }
  });
});
