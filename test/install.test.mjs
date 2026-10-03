/**
 * Installation smoke tests.
 *
 * These tests run install.sh against an isolated HOME so they exercise the
 * same files and paths a user gets without changing the developer's config.
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
const RUNTIME_FILES = [
  'bench/parse-log.mjs',
  'preresearch-schema.mjs',
  'rlm-config.mjs',
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
  assert.deepEqual((await readdir(hookDir)).sort(), ['bench', 'preresearch-schema.mjs', 'rlm-config.mjs', 'rlm-hook.mjs', 'rlm-hook.sh']);

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
  assert.deepEqual((await readdir(hookDir)).sort(), ['bench', 'preresearch-schema.mjs', 'rlm-config.mjs', 'rlm-hook.mjs', 'rlm-hook.sh']);
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
