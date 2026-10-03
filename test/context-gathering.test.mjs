#!/usr/bin/env node
/**
 * Context-gathering coverage for project metadata and recent transcript turns.
 *
 * The hook is intentionally a single executable module, so these tests keep
 * faithful local copies of the two context collectors, matching unit.test.mjs.
 * The fixtures use real temporary directories and JSONL transcripts to cover
 * the filesystem and transcript-shape boundaries that prompt-only tests miss.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const CONTEXT_WINDOW = 5;

async function gatherProjectContext(cwd) {
  if (!cwd || !existsSync(cwd)) return null;

  const context = {
    projectRoot: cwd,
    projectName: basename(cwd),
    projectType: null,
    techStack: [],
    recentFiles: [],
    gitBranch: null,
    gitStatus: null,
  };

  try {
    const manifestFiles = {
      'package.json': 'node',
      'Cargo.toml': 'rust',
      'go.mod': 'go',
      'pyproject.toml': 'python',
      'requirements.txt': 'python',
      'pom.xml': 'java',
      'build.gradle': 'java',
      'Gemfile': 'ruby',
      'composer.json': 'php',
    };

    for (const [file, type] of Object.entries(manifestFiles)) {
      if (existsSync(join(cwd, file))) {
        context.projectType = type;
        context.techStack.push(type);

        if (file === 'package.json') {
          try {
            const pkg = JSON.parse(await readFile(join(cwd, file), 'utf-8'));
            const deps = Object.keys(pkg.dependencies || {}).slice(0, 10);
            const devDeps = Object.keys(pkg.devDependencies || {}).slice(0, 5);
            context.techStack.push(...deps, ...devDeps);
          } catch {}
        }
        break;
      }
    }

    try {
      context.gitBranch = execSync('git branch --show-current 2>/dev/null', { cwd, timeout: 1000 })
        .toString().trim();
      context.gitStatus = execSync('git status --porcelain 2>/dev/null', { cwd, timeout: 1000 })
        .toString().trim().split('\n').slice(0, 5).join(', ');
    } catch {}

    try {
      const found = execSync(
        'find . -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.mjs" -o -name "*.py" -o -name "*.rs" -o -name "*.go" \\) 2>/dev/null | grep -v node_modules | head -20',
        { cwd, timeout: 2000 },
      ).toString().trim().split('\n').filter(Boolean);
      context.recentFiles = found.slice(0, 10);
    } catch {}
  } catch {}

  return context;
}

function normalizeIntent(analysis) {
  const intent = analysis?.intent;
  if (typeof intent === 'string') return intent || null;
  if (intent && typeof intent === 'object' && typeof intent.primary === 'string') {
    return intent.primary || null;
  }
  return null;
}

function normalizeRelevantFiles(analysis) {
  const raw = Array.isArray(analysis?.relevant_files)
    ? analysis.relevant_files
    : (Array.isArray(analysis?.files) ? analysis.files : []);
  const files = [];
  for (const file of raw) {
    if (typeof file === 'string' && file) files.push(file);
    else if (file && typeof file === 'object' && typeof file.path === 'string' && file.path) {
      files.push(file.path);
    }
  }
  return files;
}

function extractPriorRLMBlocks(transcriptText, { window = CONTEXT_WINDOW, ts } = {}) {
  if (typeof transcriptText !== 'string' || transcriptText.length === 0) return [];

  const stamp = typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
  const tagRe = /<rlm_(?:preresearch|analysis)>([\s\S]*?)<\/rlm_(?:preresearch|analysis)>/g;
  const blocks = [];
  let match;
  while ((match = tagRe.exec(transcriptText)) !== null) {
    let parsed;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    blocks.push({
      intent: normalizeIntent(parsed),
      relevant_files: normalizeRelevantFiles(parsed),
      ts: stamp,
      raw: parsed,
    });
  }

  blocks.reverse();
  const limit = Number.isFinite(window) && window > 0 ? window : blocks.length;
  return blocks.slice(0, limit);
}

function extractPriorBlocksFromTranscript(transcriptText, { window = CONTEXT_WINDOW } = {}) {
  if (typeof transcriptText !== 'string' || transcriptText.length === 0) return [];

  const all = [];
  for (const line of transcriptText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    const raw = entry.message?.content ?? entry.content ?? '';
    const text = Array.isArray(raw)
      ? raw.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text).join('\n')
      : (typeof raw === 'string' ? raw : '');
    if (!text) continue;

    let ts;
    if (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)) {
      ts = entry.timestamp;
    } else if (typeof entry.timestamp === 'string') {
      const parsedTimestamp = Date.parse(entry.timestamp);
      ts = Number.isFinite(parsedTimestamp) ? parsedTimestamp : undefined;
    }

    const blocks = extractPriorRLMBlocks(text, { window: Infinity, ts });
    blocks.reverse();
    all.push(...blocks);
  }

  all.reverse();
  const limit = Number.isFinite(window) && window > 0 ? window : all.length;
  return all.slice(0, limit);
}

async function gatherConversationContext(transcriptPath, maxMessages = CONTEXT_WINDOW) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  try {
    const content = await readFile(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').slice(-maxMessages * 2);
    const messages = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user' && entry.type !== 'assistant') continue;
        const raw = entry.message?.content || entry.content || '';
        const text = Array.isArray(raw)
          ? raw.filter((block) => block.type === 'text').map((block) => block.text).join(' ')
          : (typeof raw === 'string' ? raw : '');
        if (text) {
          messages.push({
            role: entry.type,
            preview: text.slice(0, 200) + (text.length > 200 ? '...' : ''),
          });
        }
      } catch {}
    }

    return {
      messages: messages.slice(-maxMessages),
      priorBlocks: extractPriorBlocksFromTranscript(content, { window: maxMessages }),
    };
  } catch {
    return null;
  }
}

function jsonlRecord(type, content, timestamp) {
  const record = { type, message: { content } };
  if (timestamp !== undefined) record.timestamp = timestamp;
  return JSON.stringify(record);
}

describe('project context gathering', () => {
  let projectDir;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'rlm-project-context-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns null for a missing directory', async () => {
    const context = await gatherProjectContext(join(projectDir, 'missing'));
    assert.equal(context, null);
  });

  it('detects every supported manifest project type', async () => {
    const manifests = [
      ['package.json', 'node'],
      ['Cargo.toml', 'rust'],
      ['go.mod', 'go'],
      ['pyproject.toml', 'python'],
      ['requirements.txt', 'python'],
      ['pom.xml', 'java'],
      ['build.gradle', 'java'],
      ['Gemfile', 'ruby'],
      ['composer.json', 'php'],
    ];

    for (const [manifest, expectedType] of manifests) {
      const fixture = await mkdtemp(join(projectDir, 'type-'));
      await writeFile(join(fixture, manifest), manifest === 'package.json' ? '{}' : 'fixture');
      const context = await gatherProjectContext(fixture);
      assert.equal(context.projectType, expectedType, manifest);
    }
  });

  it('handles a non-git project, package dependencies, and source file collection', async () => {
    await mkdir(join(projectDir, 'src'), { recursive: true });
    await mkdir(join(projectDir, 'node_modules', 'ignored'), { recursive: true });
    await writeFile(join(projectDir, 'package.json'), JSON.stringify({
      dependencies: { express: '^5.0.0', zod: '^4.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    }));
    await writeFile(join(projectDir, 'src', 'index.ts'), 'export const app = true;');
    await writeFile(join(projectDir, 'node_modules', 'ignored', 'package.js'), 'ignored');

    const context = await gatherProjectContext(projectDir);

    assert.equal(context.projectName, basename(projectDir));
    assert.equal(context.projectType, 'node');
    assert.deepEqual(context.techStack, ['node', 'express', 'zod', 'typescript']);
    assert.equal(context.gitBranch, null);
    assert.equal(context.gitStatus, null);
    assert.ok(context.recentFiles.includes('./src/index.ts'));
    assert.ok(!context.recentFiles.some((file) => file.includes('node_modules')));
  });

  it('returns an unknown type and empty metadata when context files are absent', async () => {
    const context = await gatherProjectContext(projectDir);

    assert.deepEqual(context, {
      projectRoot: projectDir,
      projectName: basename(projectDir),
      projectType: null,
      techStack: [],
      recentFiles: [],
      gitBranch: null,
      gitStatus: null,
    });
  });

  it('reports the current branch and dirty git status', async () => {
    execSync('git init -q -b context-test', { cwd: projectDir });
    await writeFile(join(projectDir, 'dirty.ts'), 'export const changed = true;');

    const context = await gatherProjectContext(projectDir);

    assert.equal(context.gitBranch, 'context-test');
    assert.match(context.gitStatus, /\?\? dirty\.ts/);
    assert.ok(context.recentFiles.includes('./dirty.ts'));
  });

  it('limits the source file list to ten entries', async () => {
    for (let i = 0; i < 12; i += 1) {
      await writeFile(join(projectDir, `file-${i}.js`), `export const file${i} = ${i};`);
    }

    const context = await gatherProjectContext(projectDir);

    assert.equal(context.recentFiles.length, 10);
  });

  it('does not fail project detection when package.json is malformed', async () => {
    await writeFile(join(projectDir, 'package.json'), '{ not valid json');

    const context = await gatherProjectContext(projectDir);

    assert.equal(context.projectType, 'node');
    assert.deepEqual(context.techStack, ['node']);
  });
});

describe('conversation context gathering', () => {
  let transcriptDir;
  let transcriptPath;

  beforeEach(async () => {
    transcriptDir = await mkdtemp(join(tmpdir(), 'rlm-transcript-context-'));
    transcriptPath = join(transcriptDir, 'conversation.jsonl');
  });

  afterEach(async () => {
    await rm(transcriptDir, { recursive: true, force: true });
  });

  it('returns null when the transcript path is missing', async () => {
    assert.equal(await gatherConversationContext(join(transcriptPath, 'missing')), null);
  });

  it('returns empty message and block arrays for an empty transcript', async () => {
    await writeFile(transcriptPath, '');

    assert.deepEqual(await gatherConversationContext(transcriptPath), {
      messages: [],
      priorBlocks: [],
    });
  });

  it('extracts only recent user and assistant turns and accepts text blocks', async () => {
    const records = [
      jsonlRecord('user', 'turn one'),
      jsonlRecord('assistant', 'turn two'),
      jsonlRecord('system', 'ignore this system record'),
      jsonlRecord('user', 'turn three'),
      jsonlRecord('assistant', [{ type: 'image' }, { type: 'text', text: 'turn four' }]),
      jsonlRecord('user', 'turn five'),
    ];
    await writeFile(transcriptPath, records.join('\n'));

    const context = await gatherConversationContext(transcriptPath, 2);

    assert.deepEqual(context.messages, [
      { role: 'assistant', preview: 'turn four' },
      { role: 'user', preview: 'turn five' },
    ]);
  });

  it('truncates long previews to 200 characters with a marker', async () => {
    const text = 'x'.repeat(240);
    await writeFile(transcriptPath, jsonlRecord('user', text));

    const context = await gatherConversationContext(transcriptPath);

    assert.equal(context.messages[0].preview, `${'x'.repeat(200)}...`);
    assert.equal(context.messages[0].preview.length, 203);
  });

  it('skips malformed JSONL records without losing valid turns', async () => {
    await writeFile(transcriptPath, [
      'not json',
      jsonlRecord('user', 'valid turn'),
      '{"type":"assistant"',
    ].join('\n'));

    const context = await gatherConversationContext(transcriptPath);

    assert.deepEqual(context.messages, [{ role: 'user', preview: 'valid turn' }]);
  });

  it('extracts prior RLM blocks newest-first with per-record timestamps', async () => {
    const older = '<rlm_preresearch>\n' + JSON.stringify({
      intent: 'learning',
      relevant_files: [{ path: 'old.js', purpose: 'old' }],
    }) + '\n</rlm_preresearch>';
    const newer = '<rlm_analysis>\n' + JSON.stringify({
      intent: { primary: 'debugging' },
      files: ['new.js'],
    }) + '\n</rlm_analysis>';
    await writeFile(transcriptPath, [
      jsonlRecord('user', older, '2026-10-03T10:00:00.000Z'),
      jsonlRecord('assistant', newer, '2026-10-03T11:00:00.000Z'),
    ].join('\n'));

    const context = await gatherConversationContext(transcriptPath, 2);

    assert.deepEqual(context.priorBlocks.map((block) => ({
      intent: block.intent,
      files: block.relevant_files,
      ts: block.ts,
    })), [
      { intent: 'debugging', files: ['new.js'], ts: Date.parse('2026-10-03T11:00:00.000Z') },
      { intent: 'learning', files: ['old.js'], ts: Date.parse('2026-10-03T10:00:00.000Z') },
    ]);
  });

  it('caps recovered prior blocks to the requested window', async () => {
    const records = [1, 2, 3].map((number) => jsonlRecord(
      'user',
      `<rlm_preresearch>${JSON.stringify({ intent: 'debugging', files: [`file-${number}.js`] })}</rlm_preresearch>`,
      `2026-10-03T1${number}:00:00.000Z`,
    ));
    await writeFile(transcriptPath, records.join('\n'));

    const context = await gatherConversationContext(transcriptPath, 2);

    assert.deepEqual(context.priorBlocks.map((block) => block.relevant_files[0]), [
      'file-3.js',
      'file-2.js',
    ]);
  });
});
