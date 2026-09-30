#!/usr/bin/env node
/**
 * Process-boundary correctness tests for the semantic cache.
 *
 * The unit suite covers the individual embedding and scoring helpers. These
 * tests exercise the real hook with a local embedding endpoint so cache-hit
 * formatting, index fallback, and threshold behavior cannot drift apart.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../rlm-hook.mjs', import.meta.url));

const CACHED_ANALYSIS = {
  intent: 'code_writing',
  summary: 'Cached semantic context for authentication.',
  relevant_files: [
    { path: 'src/auth/session.js', purpose: 'validates session tokens' },
  ],
  tasks: ['Reuse the cached authentication context'],
  approach: 'Continue from the previously explored session flow',
};

const FALLBACK_ANALYSIS = {
  intent: 'debugging',
  summary: 'The embedding was not close enough, so the model was consulted.',
  relevant_files: [],
  tasks: ['Investigate the request'],
  approach: 'Analyze the request from scratch',
};

function cacheKey(prompt, cwd) {
  return createHash('sha256').update(`${prompt}\0${cwd}`).digest('hex');
}

function floatBytes(values) {
  const vector = Float32Array.from(values);
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

async function writeCacheEntry(cacheDir, prompt, cwd, analysis, vector) {
  const key = cacheKey(prompt, cwd);
  await writeFile(join(cacheDir, `${key}.json`), JSON.stringify(analysis));
  await writeFile(join(cacheDir, `${key}.embedding`), floatBytes(vector));
  return key;
}

async function writeFakeClaude(binDir, invokedPath, analysis = FALLBACK_ANALYSIS) {
  const script = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
if (process.env.RLM_FAKE_CLAUDE_INVOKED) {
  appendFileSync(process.env.RLM_FAKE_CLAUDE_INVOKED, 'invoked\\n');
}
process.stdout.write(${JSON.stringify(JSON.stringify(analysis))});
`;
  await writeFile(join(binDir, 'claude'), script, { mode: 0o755 });
}

function startEmbeddingServer(vector) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      method: request.method,
      url: request.url,
      body: JSON.parse(body),
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ embedding: vector }] }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function runHook(input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: env.projectDir,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));

    child.stdin.end(JSON.stringify(input));
  });
}

describe('semantic cache process contract', { timeout: 10000 }, () => {
  let root;
  let cacheDir;
  let projectDir;
  let binDir;
  let invokedPath;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rlm-semantic-contract-'));
    cacheDir = join(root, 'cache');
    projectDir = join(root, 'project');
    binDir = join(root, 'bin');
    invokedPath = join(root, 'claude-invoked');
    await mkdir(cacheDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function hookEnv(baseUrl) {
    return {
      projectDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      RLM_CACHE_DIR: cacheDir,
      RLM_LOG_FILE: join(root, 'hook.log'),
      RLM_METRICS_FILE: join(root, 'metrics.jsonl'),
      RLM_GATHER_CONTEXT: 'false',
      RLM_SEMANTIC_CACHE: 'true',
      RLM_SEMANTIC_THRESHOLD: '0.92',
      RLM_EMBED_BASE_URL: baseUrl,
      OPENAI_API_KEY: 'semantic-test-key',
      RLM_FAKE_CLAUDE_INVOKED: invokedPath,
    };
  }

  it('generates an embedding and formats an actual semantic cache hit', async () => {
    const cachedPrompt = 'Explain how the authentication middleware validates session tokens.';
    const queryPrompt = 'Please explain how the authentication middleware validates session tokens.';
    const embedding = await startEmbeddingServer([1, 0, 0]);
    try {
      await writeFakeClaude(binDir, invokedPath);
      await writeCacheEntry(cacheDir, cachedPrompt, projectDir, CACHED_ANALYSIS, [1, 0, 0]);

      const result = await runHook(
        { prompt: queryPrompt, cwd: projectDir },
        hookEnv(embedding.baseUrl),
      );

      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /<rlm_preresearch>/);
      assert.match(result.stdout, /Cached semantic context for authentication\./);
      assert.match(result.stdout, /src\/auth\/session\.js \(validates session tokens\)/);
      assert.match(result.stdout, /PRERESEARCH COMPLETE:/);
      assert.equal(result.stdout.includes(FALLBACK_ANALYSIS.summary), false);
      assert.equal(await readFile(invokedPath, 'utf8').catch(() => ''), '');

      assert.equal(embedding.requests.length, 1);
      assert.equal(embedding.requests[0].method, 'POST');
      assert.equal(embedding.requests[0].url, '/v1/embeddings');
      assert.equal(embedding.requests[0].body.input, `${queryPrompt}\0${projectDir}`);
      assert.equal(embedding.requests[0].body.model, 'text-embedding-3-small');
    } finally {
      await embedding.close();
    }
  });

  it('falls back to sidecars when the index is missing or corrupt and skips bad dimensions', async () => {
    const cachedPrompt = 'Find the session validation implementation in this project.';
    const embedding = await startEmbeddingServer([1, 0, 0]);
    try {
      await writeFakeClaude(binDir, invokedPath);
      const goodKey = await writeCacheEntry(
        cacheDir,
        cachedPrompt,
        projectDir,
        CACHED_ANALYSIS,
        [0.99, 0.1, 0],
      );
      await writeFile(join(cacheDir, 'index.json'), '{corrupt index');
      await writeFile(join(cacheDir, `${'b'.repeat(64)}.embedding`), Buffer.from([1, 2, 3]));
      await writeFile(join(cacheDir, `${'c'.repeat(64)}.embedding`), floatBytes([1, 0]));

      const result = await runHook(
        { prompt: 'Locate the session validation implementation in this project.', cwd: projectDir },
        hookEnv(embedding.baseUrl),
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Cached semantic context for authentication\./);
      assert.equal(await readFile(invokedPath, 'utf8').catch(() => ''), '');
      assert.ok(goodKey, 'the valid sidecar was written under its derived key');
    } finally {
      await embedding.close();
    }
  });

  it('does not return zero-vector or below-threshold matches', async () => {
    const cachedPrompt = 'Explain the unrelated deployment configuration details.';
    const embedding = await startEmbeddingServer([1, 0, 0]);
    try {
      await writeFakeClaude(binDir, invokedPath);
      await writeCacheEntry(cacheDir, cachedPrompt, projectDir, CACHED_ANALYSIS, [0, 0, 0]);

      const result = await runHook(
        { prompt: 'Explain the unrelated deployment configuration details now.', cwd: projectDir },
        hookEnv(embedding.baseUrl),
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout, /The embedding was not close enough/);
      assert.equal(result.stdout.includes(CACHED_ANALYSIS.summary), false);
      assert.equal(await readFile(invokedPath, 'utf8'), 'invoked\n');
    } finally {
      await embedding.close();
    }
  });
});
