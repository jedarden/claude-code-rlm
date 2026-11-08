/**
 * Installation smoke tests.
 *
 * These tests run install.sh and uninstall.sh against an isolated HOME so
 * they exercise the same files and paths a user gets without changing the
 * developer's config. They also cover the runtime master disable switch
 * (RLM_ENABLED / RLM_DISABLED) end to end against the installed hook.
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INSTALLER = join(ROOT, 'install.sh');
const UNINSTALLER = join(ROOT, 'uninstall.sh');
const RUNTIME_FILES = [
  'bench/parse-log.mjs',
  'preresearch-schema.mjs',
  'rlm-config.mjs',
  'rotating-log.mjs',
  'rlm-hook.mjs',
  'rlm-hook.sh',
];

const homes = new Set();

afterEach(async () => {
  await Promise.all([...homes].map((home) => rm(home, { recursive: true, force: true })));
  homes.clear();
});

async function isolatedHome() {
  const home = await mkdtemp(join(tmpdir(), 'claude-code-rlm-install-'));
  homes.add(home);
  return home;
}

function run(command, args, { env, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function installedFiles(home) {
  const hookDir = join(home, '.claude', 'hooks');
  return {
    hookDir,
    paths: Object.fromEntries(RUNTIME_FILES.map((file) => [file, join(hookDir, file)])),
  };
}

async function assertExecutable(path) {
  const mode = (await stat(path)).mode;
  assert.notEqual(mode & 0o111, 0, `${path} should be executable`);
}

test('install creates a usable UserPromptSubmit hook and resolves its runtime modules', async () => {
  const home = await isolatedHome();
  const result = await run('bash', [INSTALLER], { env: { HOME: home }, input: 'n\n' });
  assert.equal(result.code, 0, result.stderr);

  const { hookDir, paths } = await installedFiles(home);
  for (const file of RUNTIME_FILES) {
    await stat(paths[file]);
  }
  await assertExecutable(paths['rlm-hook.mjs']);
  await assertExecutable(paths['rlm-hook.sh']);
  assert.deepEqual((await readdir(hookDir)).sort(), ['bench', 'preresearch-schema.mjs', 'rlm-config.mjs', 'rlm-hook.mjs', 'rlm-hook.sh', 'rotating-log.mjs']);

  assert.match(result.stdout, /"UserPromptSubmit"/);
  assert.match(result.stdout, /"command": "~\/.claude\/hooks\/rlm-hook\.mjs"/);

  const version = await run(paths['rlm-hook.mjs'], ['--version'], { env: { HOME: home } });
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout, '0.1.0\n');
  assert.equal(version.stderr, '');

  const wrapperVersion = await run(paths['rlm-hook.sh'], ['--version'], { env: { HOME: home } });
  assert.equal(wrapperVersion.code, 0, wrapperVersion.stderr);
  assert.equal(wrapperVersion.stdout, '0.1.0\n');
  assert.equal(wrapperVersion.stderr, '');

  const hookInvocation = await run(paths['rlm-hook.sh'], [], {
    env: { HOME: home, RLM_AGENTIC_MODE: 'false' },
    input: JSON.stringify({ prompt: 'short prompt' }),
  });
  assert.equal(hookInvocation.code, 0, hookInvocation.stderr);
});

test('install is idempotent and does not duplicate or alter the runtime graph', async () => {
  const home = await isolatedHome();
  const env = { HOME: home };
  const first = await run('bash', [INSTALLER], { env, input: 'n\n' });
  assert.equal(first.code, 0, first.stderr);
  const { hookDir, paths } = await installedFiles(home);
  const before = await Promise.all(RUNTIME_FILES.map(async (file) => [file, await readFile(paths[file], 'utf8')]));

  const second = await run('bash', [INSTALLER], { env, input: 'n\n' });
  assert.equal(second.code, 0, second.stderr);
  const after = await Promise.all(RUNTIME_FILES.map(async (file) => [file, await readFile(paths[file], 'utf8')]));
  assert.deepEqual(after, before);
  assert.deepEqual((await readdir(hookDir)).sort(), ['bench', 'preresearch-schema.mjs', 'rlm-config.mjs', 'rlm-hook.mjs', 'rlm-hook.sh', 'rotating-log.mjs']);
});

test('SDK opt-in delegates installation to npm at the hook location', async () => {
  const home = await isolatedHome();
  const fakeBin = join(home, 'fake-bin');
  const npmTrace = join(home, 'npm-args.json');
  await mkdir(fakeBin);
  const fakeNpm = join(fakeBin, 'npm');
  await writeFile(fakeNpm, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.RLM_INSTALL_NPM_TRACE, JSON.stringify(process.argv.slice(2)));
`);
  await chmod(fakeNpm, 0o755);

  const result = await run('bash', [INSTALLER], {
    env: {
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RLM_INSTALL_NPM_TRACE: npmTrace,
    },
    input: 'y\n',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(npmTrace, 'utf8')), [
    'install',
    '--prefix',
    join(home, '.claude', 'hooks'),
    '@anthropic-ai/sdk',
  ]);
});

const ANALYSIS = {
  intent: 'code_writing',
  summary: 'The hook received and analyzed the user request.',
  relevant_files: [{ path: 'src/auth.js', purpose: 'Session handling.' }],
  existing_patterns: ['Temporary fake CLI output'],
  recent_changes: 'No recent changes.',
  tasks: ['Verify the disable switch'],
  approach: 'Return structured context to the parent process.',
  warnings: [],
};

const EXPLORATION_PROMPT = JSON.stringify({
  prompt: 'Please explore how the authentication middleware handles session expiry',
  cwd: '/tmp',
});

/**
 * Fake `claude` executable: appends one line per invocation to a marker file,
 * then prints the analysis exactly the way the hook's subprocess mode expects.
 */
async function installFakeClaude(binDir, marker) {
  await mkdir(binDir, { recursive: true });
  const fakeClaude = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.RLM_TEST_CLAUDE_MARKER, process.argv.slice(2).join(' ') + '\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(ANALYSIS))});
`;
  const path = join(binDir, 'claude');
  await writeFile(path, fakeClaude, { mode: 0o755 });
  return path;
}

async function readMetrics(home) {
  const text = await readFile(join(home, '.local', 'share', 'rlm-hook', 'metrics.jsonl'), 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function cacheEntries(home) {
  return readdir(join(home, '.cache', 'rlm-hook'));
}

test('RLM_ENABLED=false and RLM_DISABLED=true make the installed hook fully inert', async () => {
  const home = await isolatedHome();
  const install = await run('bash', [INSTALLER], { env: { HOME: home }, input: 'n\n' });
  assert.equal(install.code, 0, install.stderr);

  const { paths } = await installedFiles(home);
  const binDir = join(home, 'fake-bin');
  const marker = join(home, 'claude-invocations.log');
  await installFakeClaude(binDir, marker);

  const baseEnv = {
    HOME: home,
    PATH: `${binDir}:${process.env.PATH}`,
    RLM_TEST_CLAUDE_MARKER: marker,
    RLM_AGENTIC_MODE: 'true',
    RLM_GATHER_CONTEXT: 'false',
    RLM_SEMANTIC_CACHE: 'false',
  };

  // Master off switch via RLM_ENABLED=false on the .mjs entrypoint: exits 0,
  // injects nothing, never invokes claude, records exactly one disabled
  // event, and leaves the cache untouched.
  const disabled = await run(paths['rlm-hook.mjs'], [], {
    env: { ...baseEnv, RLM_ENABLED: 'false' },
    input: EXPLORATION_PROMPT,
  });
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal(disabled.stdout, '', 'a disabled hook must inject nothing');
  await assert.rejects(stat(marker), { code: 'ENOENT' }, 'claude must not be invoked while disabled');
  const [disabledEvent] = await readMetrics(home);
  assert.deepEqual(Object.keys(disabledEvent).sort(), ['cache_hit', 'event', 'input_len', 'latency_ms', 'mode', 'reason', 'ts']);
  assert.equal(disabledEvent.event, 'disabled');
  assert.equal(disabledEvent.reason, 'disabled_by_env');
  assert.equal(disabledEvent.cache_hit, false);
  assert.equal(disabledEvent.mode, 'agentic');
  assert.equal(typeof disabledEvent.latency_ms, 'number');
  assert.equal(typeof disabledEvent.input_len, 'number');
  assert.deepEqual(await cacheEntries(home), []);

  // Same outcome via RLM_DISABLED=true through the .sh wrapper entrypoint.
  const disabledAlt = await run(paths['rlm-hook.sh'], [], {
    env: { ...baseEnv, RLM_DISABLED: 'true' },
    input: EXPLORATION_PROMPT,
  });
  assert.equal(disabledAlt.code, 0, disabledAlt.stderr);
  assert.equal(disabledAlt.stdout, '');
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.deepEqual((await readMetrics(home)).map((m) => m.event), ['disabled', 'disabled']);
  assert.deepEqual(await cacheEntries(home), []);

  // Control: with the switch off (env unset) the same prompt reaches claude,
  // so the assertions above are attributable to the gate and not to a broken
  // fake or a hook that never worked in this fixture.
  const enabled = await run(paths['rlm-hook.mjs'], [], { env: baseEnv, input: EXPLORATION_PROMPT });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.match(enabled.stdout, /<rlm_preresearch>/);
  await stat(marker);
  const events = (await readMetrics(home)).map((m) => m.event);
  assert.deepEqual(events, ['disabled', 'disabled', 'complete']);
  assert.equal((await cacheEntries(home)).length, 1);
});

test('uninstall removes the hook, its registration, SDK deps, and data; foreign files survive', async () => {
  const home = await isolatedHome();
  const install = await run('bash', [INSTALLER], { env: { HOME: home }, input: 'n\n' });
  assert.equal(install.code, 0, install.stderr);

  const hookDir = join(home, '.claude', 'hooks');
  // Foreign files sharing the hooks directory must not be touched.
  await writeFile(join(hookDir, 'other-hook.py'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(hookDir, 'bench', 'other.mjs'), 'export {};\n');
  // SDK layout install.sh's npm step creates.
  await mkdir(join(hookDir, 'node_modules', '@anthropic-ai'), { recursive: true });
  await writeFile(join(hookDir, 'package.json'), JSON.stringify({
    dependencies: { '@anthropic-ai/sdk': '^0.105.0' },
  }));
  // Registration (documented manual step) plus unrelated settings and hooks.
  const settingsPath = join(home, '.claude', 'settings.json');
  await writeFile(settingsPath, JSON.stringify({
    model: 'opus',
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: '~/.claude/hooks/rlm-hook.mjs', timeout: 90 }] },
        { hooks: [{ type: 'command', command: '/usr/bin/other-tool', timeout: 10 }] },
      ],
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'rlm-hook.sh --guard-agentic-tool /tmp/scratch.md' }] },
      ],
    },
  }, null, 2));
  await writeFile(join(home, '.cache', 'rlm-hook', 'abc.json'), '{}');
  await writeFile(join(home, '.local', 'share', 'rlm-hook', 'rlm-hook.log'), 'hello\n');

  const result = await run('bash', [UNINSTALLER], { env: { HOME: home } });
  assert.equal(result.code, 0, result.stderr);

  for (const file of RUNTIME_FILES) {
    await assert.rejects(stat(join(hookDir, file)), { code: 'ENOENT' }, `${file} should be removed`);
  }
  await stat(join(hookDir, 'other-hook.py'));
  await stat(join(hookDir, 'bench', 'other.mjs'));
  await assert.rejects(stat(join(hookDir, 'package.json')), { code: 'ENOENT' });
  await assert.rejects(stat(join(hookDir, 'node_modules')), { code: 'ENOENT' });

  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.hooks.UserPromptSubmit, [
    { hooks: [{ type: 'command', command: '/usr/bin/other-tool', timeout: 10 }] },
  ]);
  assert.equal(settings.hooks.PreToolUse, undefined);
  assert.match(result.stdout, /removed 2 RLM hook registration/);

  await assert.rejects(stat(join(home, '.cache', 'rlm-hook')), { code: 'ENOENT' });
  await assert.rejects(stat(join(home, '.local', 'share', 'rlm-hook')), { code: 'ENOENT' });

  // Running it again is a no-op, not an error.
  const again = await run('bash', [UNINSTALLER], { env: { HOME: home } });
  assert.equal(again.code, 0, again.stderr);
});

test('uninstall keeps a shared package.json that declares more than the SDK', async () => {
  const home = await isolatedHome();
  const install = await run('bash', [INSTALLER], { env: { HOME: home }, input: 'n\n' });
  assert.equal(install.code, 0, install.stderr);

  const hookDir = join(home, '.claude', 'hooks');
  const pkgPath = join(hookDir, 'package.json');
  await writeFile(pkgPath, JSON.stringify({
    dependencies: { '@anthropic-ai/sdk': '^0.105.0', 'left-pad': '^1.3.0' },
  }));

  const result = await run('bash', [UNINSTALLER], { env: { HOME: home } });
  assert.equal(result.code, 0, result.stderr);
  await stat(pkgPath);
  assert.doesNotMatch(result.stdout, /removed SDK dependencies/);
});

test('uninstall leaves a malformed settings.json untouched and still removes the hook', async () => {
  const home = await isolatedHome();
  const install = await run('bash', [INSTALLER], { env: { HOME: home }, input: 'n\n' });
  assert.equal(install.code, 0, install.stderr);

  const settingsPath = join(home, '.claude', 'settings.json');
  const broken = '{ "hooks": {';
  await writeFile(settingsPath, broken);

  const result = await run('bash', [UNINSTALLER], { env: { HOME: home } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(settingsPath, 'utf8'), broken);
  assert.match(result.stderr, /not valid JSON/);
  await assert.rejects(stat(join(home, '.claude', 'hooks', 'rlm-hook.mjs')), { code: 'ENOENT' });
});

test('uninstall on a fresh install with no settings removes everything and is graceful when absent', async () => {
  const home = await isolatedHome();
  const install = await run('bash', [INSTALLER], { env: { HOME: home }, input: 'n\n' });
  assert.equal(install.code, 0, install.stderr);

  const result = await run('bash', [UNINSTALLER], { env: { HOME: home } });
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(stat(join(home, '.claude', 'hooks')), { code: 'ENOENT' });
  await assert.rejects(stat(join(home, '.cache', 'rlm-hook')), { code: 'ENOENT' });

  // Nothing installed at all: still a clean exit.
  const bare = await isolatedHome();
  const bareResult = await run('bash', [UNINSTALLER], { env: { HOME: bare } });
  assert.equal(bareResult.code, 0, bareResult.stderr);
});
