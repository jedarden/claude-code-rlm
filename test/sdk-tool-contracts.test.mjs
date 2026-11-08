#!/usr/bin/env node
/**
 * SDK agent-tool contract tests (Phase 2, Unit 5).
 *
 * These bind to the REAL exported implementations in rlm-hook.mjs — not the
 * "faithful copies" used by unit.test.mjs — so drift between the copies and
 * the hook cannot pass silently. Every clause of
 * docs/notes/sdk-tool-contracts.md is asserted here.
 *
 * Run with: node --test test/sdk-tool-contracts.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOK_PATH = fileURLToPath(new URL('../rlm-hook.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// Isolated environment, then import the real hook. CONFIG is built from env at
// import time, so the overrides must land first.
// ---------------------------------------------------------------------------
const TMP = await mkdtemp(join(tmpdir(), 'rlm-sdk-contracts-'));
process.env.RLM_LOG_FILE = join(TMP, 'rlm-hook.log');
process.env.RLM_METRICS_FILE = join(TMP, 'metrics.jsonl');
process.env.RLM_CACHE_DIR = join(TMP, 'cache');
process.env.RLM_MAX_TURNS = '3'; // small so the turn-cap test stays fast

const hook = await import(HOOK_PATH);

// ---------------------------------------------------------------------------
// Fixture project: real files + a real git repo, outside the workspace.
// ---------------------------------------------------------------------------
const ROOT = join(TMP, 'proj');
const OUTSIDE = join(TMP, 'outside.txt');

await mkdir(join(ROOT, 'src', 'deep'), { recursive: true });
await mkdir(join(ROOT, 'node_modules', 'dep'), { recursive: true });
await writeFile(join(ROOT, 'notes.txt'), 'plain project notes\n');
await writeFile(join(ROOT, 'src', 'app.ts'), 'export function authenticate(user) {\n  return user;\n}\n');
await writeFile(join(ROOT, 'src', 'deep', 'nested.txt'), 'nested content\n');
await writeFile(join(ROOT, 'node_modules', 'dep', 'index.js'), 'authenticateHidden\n');
await writeFile(OUTSIDE, 'secret outside the project\n');

const GIT = ['-c', 'user.email=test@example.com', '-c', 'user.name=test'];
execSync('git init', { cwd: ROOT, stdio: 'ignore' });
execSync(['git', ...GIT, 'add', 'notes.txt', 'src/app.ts', 'src/deep/nested.txt'].join(' '), { cwd: ROOT, stdio: 'ignore' });
execSync(['git', ...GIT, 'commit', '-m', 'init-fixture'].join(' '), { cwd: ROOT, stdio: 'ignore' });
// ~20 KB blob so `git show HEAD` output exceeds the 8 000-char Bash cap.
await writeFile(join(ROOT, 'big.txt'), `${'x'.repeat(20000)}\n`);
execSync(['git', ...GIT, 'add', 'big.txt'].join(' '), { cwd: ROOT, stdio: 'ignore' });
execSync(['git', ...GIT, 'commit', '-m', 'init-big-blob'].join(' '), { cwd: ROOT, stdio: 'ignore' });

// Symlinks: one escaping the root, one staying inside it.
await symlink(OUTSIDE, join(ROOT, 'escape-link'));
await symlink(join(ROOT, 'notes.txt'), join(ROOT, 'inner-link'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const responseText = (r) => (typeof r === 'string' ? r : r?.text || '');

function fakeClient(responses) {
  const calls = [];
  const client = {
    calls,
    messages: {
      create: async (args) => {
        calls.push(args);
        const i = calls.length - 1;
        return responses[i] ?? responses[responses.length - 1];
      },
    },
  };
  return client;
}

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

/**
 * Run the real `--guard-agentic-tool` PreToolUse entry point as a subprocess —
 * exactly how the CLI invokes it in subprocess mode. Resolves stdout
 * ('' = allowed, deny JSON = denied).
 */
function guardStdout(scratchPath, projectRoot, event) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [HOOK_PATH, '--guard-agentic-tool', scratchPath, projectRoot],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(out.trim()));
    p.stdin.write(JSON.stringify(event));
    p.stdin.end();
  });
}

const GUARD_SCRATCH = join(ROOT, '.claude', 'rlm-scratch-424242.md');

// The fixture owns its own removal — never leave mkdtemp droppings in TMPDIR.
after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Advertised schema
// ---------------------------------------------------------------------------
describe('SDK tool schema advertisement', () => {
  it('advertises exactly Glob, Grep, Read, Write, Bash', () => {
    assert.deepEqual(hook.AGENTIC_TOOLS.map((t) => t.name), ['Glob', 'Grep', 'Read', 'Write', 'Bash']);
  });

  it('declares the documented required fields per tool', () => {
    const required = Object.fromEntries(hook.AGENTIC_TOOLS.map((t) => [t.name, t.input_schema.required]));
    assert.deepEqual(required, {
      Glob: ['pattern'], Grep: ['pattern'], Read: ['path'], Write: ['content'], Bash: ['command'],
    });
    for (const t of hook.AGENTIC_TOOLS) {
      assert.equal(t.input_schema.type, 'object');
    }
  });

  it('Write has no path input — the scratch target is structural, not chosen', () => {
    const write = hook.AGENTIC_TOOLS.find((t) => t.name === 'Write');
    assert.deepEqual(Object.keys(write.input_schema.properties), ['content']);
  });

  it('Bash description names the allowlisted subcommands the gate enforces', () => {
    const bash = hook.AGENTIC_TOOLS.find((t) => t.name === 'Bash');
    for (const sub of hook.READ_ONLY_GIT_SUBCOMMANDS) {
      assert.ok(bash.description.includes(sub), `description must name "${sub}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Glob
// ---------------------------------------------------------------------------
describe('Glob contract', () => {
  it('returns root-relative newline-joined paths and skips node_modules/.git', async () => {
    const out = await hook.toolGlob('**/*.txt', ROOT);
    const lines = out.split('\n').sort();
    assert.deepEqual(lines, ['big.txt', 'notes.txt', 'src/deep/nested.txt']);
    assert.ok(!out.includes('node_modules'), 'node_modules must be skipped');
    assert.ok(!out.includes('.git'), '.git must be skipped');
  });

  it('**/x also matches x at the root; * and ? never cross /', async () => {
    assert.deepEqual((await hook.toolGlob('**/nested.txt', ROOT)).split('\n'), ['src/deep/nested.txt']);
    // '*' stays within one path segment: root-level *.txt only.
    const star = (await hook.toolGlob('*.txt', ROOT)).split('\n').sort();
    assert.deepEqual(star, ['big.txt', 'notes.txt']);
    // '?' matches exactly one non-separator character.
    assert.equal(await hook.toolGlob('?ig.txt', ROOT), 'big.txt');
    assert.equal(await hook.toolGlob('notes.tx?', ROOT), 'notes.txt');
  });

  it('escaping patterns are rejected with the exact error string', async () => {
    for (const bad of ['../x', '/etc/**', '~/**', 'src/../app.ts']) {
      assert.equal(await hook.toolGlob(bad, ROOT), 'Error: Glob pattern escapes project root', bad);
    }
    assert.equal(await hook.toolGlob('', ROOT), 'Error: Glob requires a pattern');
    assert.equal(await hook.toolGlob(undefined, ROOT), 'Error: Glob requires a pattern');
    assert.equal(await hook.toolGlob(123, ROOT), 'Error: Glob pattern escapes project root');
  });

  it('no matches → "No files matched."', async () => {
    assert.equal(await hook.toolGlob('**/*.xyz', ROOT), 'No files matched.');
  });
});

// ---------------------------------------------------------------------------
// 3. Grep
// ---------------------------------------------------------------------------
describe('Grep contract', () => {
  it('returns absolute path:line:text matches', () => {
    const out = hook.toolGrep('authenticate', undefined, ROOT);
    assert.ok(out.includes(`${join(ROOT, 'src', 'app.ts')}:1:export function authenticate`),
      `unexpected grep output: ${out}`);
    assert.ok(!out.includes('node_modules'), 'node_modules must be excluded');
  });

  it('honors the optional path scope (dir or file target)', () => {
    const scoped = hook.toolGrep('nested', 'src/deep', ROOT);
    assert.ok(scoped.includes(`${join(ROOT, 'src', 'deep', 'nested.txt')}:1:`), scoped);
    assert.equal(hook.toolGrep('plain project notes', 'notes.txt', ROOT).includes(':1:plain project notes'), true);
  });

  it('no matches → "No matches found." (grep exit 1 masked)', () => {
    assert.equal(hook.toolGrep('no-such-token-xyz', undefined, ROOT), 'No matches found.');
  });

  it('errors: missing pattern, escaping/non-existent/symlink-escape paths', () => {
    assert.equal(hook.toolGrep('', undefined, ROOT), 'Error: Grep requires a pattern');
    assert.equal(hook.toolGrep('x', '../outside.txt', ROOT), `Error: path escapes project root: ../outside.txt`);
    assert.equal(hook.toolGrep('x', '/etc', ROOT), 'Error: path escapes project root: /etc');
    assert.equal(hook.toolGrep('x', 'no-such-dir', ROOT), 'Error: path escapes project root: no-such-dir');
    // A symlink whose target is outside the root cannot be used as a target.
    assert.equal(hook.toolGrep('x', 'escape-link', ROOT), 'Error: path escapes project root: escape-link');
  });
});

// ---------------------------------------------------------------------------
// 4. Read
// ---------------------------------------------------------------------------

describe('Read contract', () => {
  it('returns raw UTF-8 content (no line numbers)', async () => {
    assert.equal(await hook.toolRead('notes.txt', ROOT), 'plain project notes\n');
  });

  it('follows a symlink that stays inside the root', async () => {
    assert.equal(await hook.toolRead('inner-link', ROOT), 'plain project notes\n');
  });

  it('truncates at 16000 chars with the documented marker', async () => {
    const out = await hook.toolRead('big.txt', ROOT);
    assert.ok(out.length > 16000, 'output must include the marker beyond the cap');
    assert.equal(out.length, 16000 + '\n... [truncated]'.length);
    assert.ok(out.endsWith('\n... [truncated]'));
  });

  it('errors: missing path, escape, symlink escape, unreadable file', async () => {
    assert.equal(await hook.toolRead('', ROOT), 'Error: Read requires a path');
    assert.equal(await hook.toolRead('../outside.txt', ROOT), 'Error: path escapes project root: ../outside.txt');
    assert.equal(await hook.toolRead('/etc/passwd', ROOT), 'Error: path escapes project root: /etc/passwd');
    assert.equal(await hook.toolRead('escape-link', ROOT), 'Error: path escapes project root: escape-link');
    // A missing file fails realpath resolution, so it surfaces as the escape
    // error — resolution precedes the read (contract: resolveWithin first).
    const missing = await hook.toolRead('no-such-file.txt', ROOT);
    assert.equal(missing, 'Error: path escapes project root: no-such-file.txt');
    await rm(join(ROOT, 'unreadable.txt'), { force: true });
    await writeFile(join(ROOT, 'unreadable.txt'), 'x', { mode: 0o000 });
    const denied = await hook.toolRead('unreadable.txt', ROOT);
    assert.ok(denied.startsWith('Error:'), `unreadable file must be an Error string, got: ${denied}`);
    await rm(join(ROOT, 'unreadable.txt'), { force: true });
  });

  it('SDK dispatch ignores the CLI-native file_path key', async () => {
    const out = await hook.dispatchAgenticTool('Read', { file_path: join(ROOT, 'notes.txt') }, ROOT);
    assert.equal(out, 'Error: Read requires a path');
  });
});

// ---------------------------------------------------------------------------
// 5. Write
// ---------------------------------------------------------------------------
describe('Write contract', () => {
  it('targets only the pid-scoped scratch file and reports the byte count', async () => {
    const out = await hook.toolWrite('first note', ROOT);
    assert.equal(out, `Wrote 10 chars to ${hook.sdkScratchPath(ROOT)}`);
    const content = await import('node:fs/promises').then((m) => m.readFile(hook.sdkScratchPath(ROOT), 'utf-8'));
    assert.equal(content, 'first note');
  });

  it('OVERWRITES the scratch file (prompt says "append"; tool contract is overwrite)', async () => {
    await hook.toolWrite('first note', ROOT);
    await hook.toolWrite('second note only', ROOT);
    const content = await import('node:fs/promises').then((m) => m.readFile(hook.sdkScratchPath(ROOT), 'utf-8'));
    assert.equal(content, 'second note only');
  });

  it('null content degrades to the empty string', async () => {
    const out = await hook.toolWrite(null, ROOT);
    assert.equal(out, `Wrote 0 chars to ${hook.sdkScratchPath(ROOT)}`);
  });

  it('scratch path is pid-scoped and under .claude/', () => {
    assert.equal(hook.sdkScratchPath(ROOT), join(ROOT, '.claude', `rlm-scratch-${process.pid}.md`));
  });
});

// ---------------------------------------------------------------------------
// 6. Bash — the allowed-command gate
// ---------------------------------------------------------------------------
describe('Bash gate: allowed commands', () => {
  it('accepts every allowlisted subcommand bare', () => {
    for (const sub of hook.READ_ONLY_GIT_SUBCOMMANDS) {
      assert.equal(hook.isAllowedGitCommand(`git ${sub}`), true, `git ${sub}`);
    }
  });

  it('accepts read-only flag forms of the allowlisted subcommands', () => {
    const ok = [
      'git status --porcelain',
      'git log --oneline -5',
      'git log -p -- notes.txt',
      'git diff --stat',
      'git diff HEAD -- src/app.ts',
      'git show --stat HEAD',
      'git branch -a',
      'git branch -vv',
      'git branch --list -v',
      'git branch --contains HEAD',
      'git branch --no-contains=HEAD',
      'git branch --points-at HEAD',
      'git branch --sort=-committerdate',
      'git ls-files -o --exclude-standard',
      'git remote',
      'git remote -v',
      'git remote show origin',
      'git remote get-url origin',
      'git diff --output-indicator-new=#', // boundary: NOT --output=<file>
    ];
    for (const cmd of ok) {
      assert.equal(hook.isAllowedGitCommand(cmd), true, cmd);
    }
  });
});

describe('Bash gate: rejected commands', () => {
  it('rejects every non-allowlisted subcommand (triage examples first)', () => {
    for (const sub of ['reset', 'clean', 'push', 'checkout', 'commit', 'config', 'add',
      'apply', 'stash', 'merge', 'rebase', 'revert', 'gc', 'notes', 'worktree']) {
      assert.equal(hook.isAllowedGitCommand(`git ${sub}`), false, `git ${sub}`);
    }
    assert.equal(hook.isAllowedGitCommand('git statusx'), false);
  });

  it('rejects mutating branch flags, including short-flag clusters, and branch creation', () => {
    for (const cmd of [
      'git branch -D x', 'git branch -d x', 'git branch --delete x',
      'git branch -m a b', 'git branch -M a b', 'git branch --move a b',
      'git branch -c a b', 'git branch -C a b', 'git branch --copy a b',
      'git branch -avD x', 'git branch -u origin/main', 'git branch --set-upstream-to=origin/main',
      'git branch --unset-upstream', 'git branch --edit-description',
      'git branch newbranch', 'git branch -q feature-x',
    ]) {
      assert.equal(hook.isAllowedGitCommand(cmd), false, cmd);
    }
  });

  it('rejects mutating remote forms but keeps read-only ones', () => {
    for (const cmd of [
      'git remote add origin https://example.com/x.git', 'git remote remove origin',
      'git remote rm origin', 'git remote rename origin mirror', 'git remote set-url origin https://example.com/y.git',
      'git remote set-head origin -a', 'git remote set-branches origin main', 'git remote prune origin',
    ]) {
      assert.equal(hook.isAllowedGitCommand(cmd), false, cmd);
    }
  });

  it('rejects file-writing and external-diff flags on read-only subcommands', () => {
    for (const cmd of [
      'git diff --output=/tmp/leak.patch',
      'git log --output=/tmp/leak.patch',
      'git show --output=x',
      'git diff --ext-diff',
      'git log --ext-diff',
    ]) {
      assert.equal(hook.isAllowedGitCommand(cmd), false, cmd);
    }
  });

  it('rejects shell metacharacters, chaining, redirection and substitution', () => {
    for (const cmd of [
      'git log; rm -rf /', 'git log && evil', 'git log || evil', 'git log | sh',
      'git log `whoami`', 'git $(whoami)', 'git log > /tmp/x', 'git log < /etc/passwd',
      'git status {a,b}', 'git log\nrm -rf /', 'git log &', 'git log;', 'git status|x',
    ]) {
      assert.equal(hook.isAllowedGitCommand(cmd), false, JSON.stringify(cmd));
    }
  });

  it('rejects prefix tricks, global options, and non-string input', () => {
    for (const cmd of ['gitfoo log', 'git', 'git -C /etc log', 'git --version', 'GIT_DIR=/x git status', null, undefined, 42, '']) {
      assert.equal(hook.isAllowedGitCommand(cmd), false, String(cmd));
    }
  });
});

describe('Bash execution contract', () => {
  it('executes allowlisted commands in the project root', () => {
    const out = hook.toolBashGit('git status', ROOT);
    assert.ok(out.startsWith('On branch'), `unexpected git status output: ${out}`);
  });

  it('empty stdout → "(no output)"', () => {
    assert.equal(hook.toolBashGit('git remote', ROOT), '(no output)');
  });

  it('caps stdout at 8000 chars', () => {
    const out = hook.toolBashGit('git show HEAD', ROOT);
    assert.equal(out.length, 8000, `expected the 8000-char cap, got ${out.length}`);
  });

  it('gate rejection uses the documented string with a 60-char echo', () => {
    const long = `git reset --hard && ${'y'.repeat(200)}`;
    const out = hook.toolBashGit(long, ROOT);
    assert.ok(out.startsWith('Error: only read-only "git ..." commands are permitted'), out);
    assert.ok(out.includes(long.trim().slice(0, 60)), out);
    assert.ok(!out.includes('y'.repeat(200)), 'echo must be capped at 60 chars');
  });

  it('git failures surface as Error strings with the git message', () => {
    const out = hook.toolBashGit('git log', TMP); // TMP is not a git repo
    assert.ok(out.startsWith('Error:'), out);
    assert.ok(/not a git repository/i.test(out), out);
  });

  it('dispatch rejects unknown tools without throwing', async () => {
    assert.equal(await hook.dispatchAgenticTool('Bogus', {}, ROOT), 'Error: unknown tool "Bogus"');
    assert.equal(await hook.dispatchAgenticTool('Bash', { command: 42 }, ROOT),
      'Error: only read-only "git ..." commands are permitted (rejected: 42)');
  });
});

// ---------------------------------------------------------------------------
// 7. Cross-mode guard IPC (the same gate, exercised through the real
//    --guard-agentic-tool subprocess used in subprocess mode)
// ---------------------------------------------------------------------------
describe('Cross-mode guard IPC', () => {
  it('allows scratch Write, in-root Read/Glob/Grep, and read-only git Bash', async () => {
    const allowed = [
      { tool_name: 'Write', tool_input: { file_path: GUARD_SCRATCH, content: 'notes' } },
      { tool_name: 'Bash', tool_input: { command: 'git status' } },
      { tool_name: 'Bash', tool_input: { command: 'git log --oneline' } },
      { tool_name: 'Read', tool_input: { file_path: join(ROOT, 'notes.txt') } },
      { tool_name: 'Glob', tool_input: { pattern: '**/*.txt', path: 'src' } },
      { tool_name: 'Grep', tool_input: { pattern: 'authenticate', path: 'src' } },
    ];
    for (const event of allowed) {
      const out = await guardStdout(GUARD_SCRATCH, ROOT, event);
      assert.equal(out, '', `${event.tool_name} ${JSON.stringify(event.tool_input)} must be allowed (got: ${out})`);
    }
  });

  it('denies the SDK-contract violations with the documented deny shape', async () => {
    const denied = [
      { event: { tool_name: 'Bash', tool_input: { command: 'git branch -D main' } }, why: 'branch deletion' },
      { event: { tool_name: 'Bash', tool_input: { command: 'git remote add o https://x' } }, why: 'remote mutation' },
      { event: { tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }, why: 'reset' },
      { event: { tool_name: 'Bash', tool_input: { command: 'git log; rm -rf /' } }, why: 'metachar' },
      { event: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, why: 'non-git' },
      { event: { tool_name: 'Read', tool_input: { file_path: OUTSIDE } }, why: 'read escape' },
      { event: { tool_name: 'Glob', tool_input: { pattern: '../**' } }, why: 'glob escape' },
      { event: { tool_name: 'Grep', tool_input: { pattern: 'x', path: '..' } }, why: 'grep escape' },
      { event: { tool_name: 'Write', tool_input: { file_path: join(ROOT, 'evil.txt'), content: 'x' } }, why: 'non-scratch write' },
    ];
    for (const { event, why } of denied) {
      const out = await guardStdout(GUARD_SCRATCH, ROOT, event);
      assert.notEqual(out, '', `${why} must be denied`);
      const parsed = JSON.parse(out);
      assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', why);
      assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse', why);
      assert.ok(parsed.hookSpecificOutput.permissionDecisionReason, why);
    }
  });

  it('denies a search tree that contains an escaping symlink (subprocess-only extra gate)', async () => {
    const out = await guardStdout(GUARD_SCRATCH, ROOT, { tool_name: 'Grep', tool_input: { pattern: 'x' } });
    assert.notEqual(out, '', 'a tree with an escaping symlink must be denied wholesale');
  });

  it('ignores events with malformed input (fails closed)', async () => {
    const out = await guardStdout(GUARD_SCRATCH, ROOT, { tool_name: 'Bash', tool_input: { command: 123 } });
    assert.notEqual(out, '', 'non-string command must be denied');
    const out2 = await guardStdout(GUARD_SCRATCH, ROOT, null);
    assert.notEqual(out2, '', 'null event must be denied');
  });
});

// ---------------------------------------------------------------------------
// 8. Continuation semantics — the SDK tool-use loop
// ---------------------------------------------------------------------------
const FINAL_JSON = JSON.stringify({
  intent: 'debugging',
  summary: 'SDK loop synthesis over the fixture project.',
  relevant_files: [{ path: 'src/app.ts', purpose: 'auth entry point', key_exports: ['authenticate'] }],
  existing_patterns: ['esm exports'],
  recent_changes: 'fixture only',
  tasks: ['inspect authenticate'],
  approach: 'read entry points first',
});

describe('SDK loop continuation semantics', () => {
  it('single final response: one request, text and usage returned', async () => {
    const client = fakeClient([
      { content: [{ type: 'text', text: FINAL_JSON }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    const result = await hook.callHaikuAgenticSDK('explore', 'sk-test', ROOT, client);
    assert.equal(client.calls.length, 1);
    assert.equal(result.text, FINAL_JSON);
    assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
    assert.equal(client.calls[0].tools, hook.AGENTIC_TOOLS, 'must advertise AGENTIC_TOOLS by reference');
    assert.equal(typeof client.calls[0].max_tokens, 'number');
  });

  it('tool_use turn: echoes assistant content verbatim, answers each block by tool_use_id', async () => {
    const turn1 = {
      content: [
        { type: 'text', text: 'thinking...' },
        toolUse('tu_1', 'Read', { path: 'notes.txt' }),
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const turn2 = {
      content: [{ type: 'text', text: FINAL_JSON }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 9 },
    };
    const client = fakeClient([turn1, turn2]);
    const result = await hook.callHaikuAgenticSDK('explore', 'sk-test', ROOT, client);

    assert.equal(client.calls.length, 2);
    const messages = client.calls[1].messages;
    assert.equal(messages.length, 3);
    // 1) original user prompt, 2) verbatim assistant echo, 3) keyed tool_results
    assert.deepEqual(messages[0], { role: 'user', content: 'explore' });
    assert.deepEqual(messages[1], { role: 'assistant', content: turn1.content });
    assert.equal(messages[2].role, 'user');
    assert.deepEqual(messages[2].content, [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'plain project notes\n' },
    ], 'tool_result must be keyed by tool_use_id and carry the real Read output');
    assert.deepEqual(result.usage, { input_tokens: 17, output_tokens: 14 }, 'usage sums across turns');
    assert.equal(result.text, FINAL_JSON);
  });

  it('multiple tool_use blocks in one turn produce ordered, keyed results', async () => {
    const turn1 = {
      content: [
        toolUse('a', 'Glob', { pattern: '**/*.txt' }),
        toolUse('b', 'Bash', { command: 'git status' }),
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const turn2 = { content: [{ type: 'text', text: FINAL_JSON }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    const client = fakeClient([turn1, turn2]);
    const result = await hook.callHaikuAgenticSDK('explore', 'sk-test', ROOT, client);
    const results = client.calls[1].messages[2].content;
    assert.deepEqual(results.map((r) => r.tool_use_id), ['a', 'b'], 'results stay in block order');
    assert.ok(results[0].content.includes('notes.txt'), 'Glob result via real dispatch');
    assert.ok(results[1].content.startsWith('On branch'), 'Bash result via real dispatch');
    assert.equal(results[1].content.startsWith('Error:'), false);
    assert.equal(result.text, FINAL_JSON);
  });

  it('stops at the turn cap (RLM_MAX_TURNS=3) and keeps lastText fallback', async () => {
    const client = fakeClient([
      { content: [{ type: 'text', text: 'partial thoughts' }, toolUse('t1', 'Read', { path: 'notes.txt' })], stop_reason: 'tool_use', usage: { input_tokens: 2, output_tokens: 3 } },
    ]);
    const result = await hook.callHaikuAgenticSDK('explore', 'sk-test', ROOT, client);
    assert.equal(client.calls.length, 3, 'exactly maxTurns requests');
    assert.equal(result.text, 'partial thoughts', 'lastText survives a textless cap');
    assert.deepEqual(result.usage, { input_tokens: 6, output_tokens: 9 });
  });

  it('never throws on a misbehaving dispatch; failures become Error strings', async () => {
    const client = fakeClient([
      { content: [toolUse('x', 'Read', null)], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } },
      { content: [{ type: 'text', text: FINAL_JSON }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    const result = await hook.callHaikuAgenticSDK('explore', 'sk-test', ROOT, client);
    const fr = client.calls[1].messages[2].content[0];
    assert.equal(fr.tool_use_id, 'x');
    assert.equal(fr.content, 'Error: Read requires a path');
    assert.equal(result.text, FINAL_JSON);
  });
});

// ---------------------------------------------------------------------------
// 9. Final preresearch output — identical across modes
// ---------------------------------------------------------------------------
describe('Final preresearch output compatibility', () => {
  it('identical final text yields byte-identical output for SDK {text,usage} and subprocess string', async () => {
    // SDK shape: callHaikuAgenticSDK returns { text, usage }
    const turn1 = { content: [toolUse('tu_9', 'Read', { path: 'notes.txt' })], stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 4 } };
    const turn2 = { content: [{ type: 'text', text: FINAL_JSON }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 6 } };
    const client = fakeClient([turn1, turn2]);
    const sdkResponse = await hook.callHaikuAgenticSDK('explore', 'sk-test', ROOT, client);

    // Subprocess shape: invokeHaiku resolves the raw stdout string.
    const subprocessResponse = FINAL_JSON;

    const viaSDK = hook.formatOutput(hook.parseHaikuResponse(responseText(sdkResponse)));
    const viaSubprocess = hook.formatOutput(hook.parseHaikuResponse(responseText(subprocessResponse)));
    assert.equal(viaSDK, viaSubprocess, 'same final text must produce byte-identical injected output');
    assert.match(viaSDK, /^<rlm_preresearch>/);
    assert.match(viaSDK, /SDK loop synthesis/);
    assert.deepEqual(sdkResponse.usage, { input_tokens: 8, output_tokens: 10 });
  });

  it('subprocess allowedTools expose exactly the SDK Bash allowlist (no drift by construction)', () => {
    const tools = hook.agenticAllowedTools();
    // Byte-identical to the historical hardcoded string (hook-contract.test.mjs pins it too).
    assert.equal(tools,
      'Read,Glob,Grep,Write,Bash(git status:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git branch:*),Bash(git ls-files:*),Bash(git remote:*),Bash(rm .claude/rlm-scratch-*.md)');
    const gitRules = tools.split(',').filter((r) => r.startsWith('Bash(git '))
      .map((r) => r.replace(/^Bash\(git /, '').replace(/:\*\)$/, ''));
    assert.deepEqual(gitRules, [...hook.READ_ONLY_GIT_SUBCOMMANDS]);
    for (const sub of gitRules) {
      assert.equal(hook.isAllowedGitCommand(`git ${sub}`), true, `git ${sub}`);
    }
  });

  it('extractSDKText/extractSDKUsage degrade defensively', () => {
    assert.equal(hook.extractSDKText(null), '');
    assert.equal(hook.extractSDKText({ content: 'nope' }), '');
    assert.equal(hook.extractSDKText({ content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] }), 'ab');
    assert.equal(hook.extractSDKUsage(null), null);
    assert.equal(hook.extractSDKUsage({ usage: { input_tokens: 'x', output_tokens: 1 } }), null);
    assert.deepEqual(hook.extractSDKUsage({ usage: { input_tokens: 0, output_tokens: 0 } }), { input_tokens: 0, output_tokens: 0 });
  });
});
