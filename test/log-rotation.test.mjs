import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { appendRotating, ERROR_LOG_LIMIT, METRICS_LOG_LIMIT, readRotatedLog } from '../rotating-log.mjs';
import { aggregate, parseLog, readLog } from '../bench/parse-log.mjs';

const run = promisify(execFile);

describe('bounded hook logs', () => {
  it('keeps the latest metrics and dashboard totals across multiple rotations', async () => {
    const root = await mkdtemp(join(process.cwd(), '.rotation-test-'));
    try {
      const path = join(root, 'custom', 'metrics.jsonl');
      const records = Array.from({ length: 7 }, (_, i) => ({
        ts: Date.parse('2026-06-23T01:00:00Z') + i,
        event: i % 2 ? 'cache_hit' : 'complete',
        cache_hit: Boolean(i % 2),
      }));
      const lines = records.map((record) => `${JSON.stringify(record)}\n`);
      const maxBytes = Math.max(...lines.map((line) => Buffer.byteLength(line))) + 1;
      for (const line of lines) {
        assert.equal(await appendRotating(path, line, { maxBytes, backups: 3 }), true);
      }

      for (const segment of [path, `${path}.1`, `${path}.2`, `${path}.3`]) {
        assert.ok((await stat(segment)).size <= maxBytes, `${segment} exceeded the byte limit`);
      }
      const retained = parseLog(await readLog(path));
      assert.deepEqual(retained, records.slice(-4));
      assert.equal(aggregate(retained).overall.total, 4);
      assert.equal(aggregate(retained).overall.hits, 2);

      const output = join(root, 'dashboard.html');
      await run(process.execPath, ['bench/dashboard.mjs', path, '--out', output]);
      const html = await readFile(output, 'utf8');
      assert.match(html, /<div class="label">Events<\/div><div class="value">4<\/div>/);
      assert.match(html, /<div class="label">Hit rate<\/div><div class="value">50\.0%<\/div>/);

      const { stdout: summary } = await run(process.execPath, ['rlm-hook.mjs', '--stats'], {
        env: { ...process.env, RLM_METRICS_FILE: path },
      });
      assert.match(summary, /Total events: 4/);
      assert.match(summary, /Cache hit rate: 50\.0%/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds the error log, trims an oversized legacy file, and drops overlong entries', async () => {
    const root = await mkdtemp(join(process.cwd(), '.rotation-test-'));
    try {
      const path = join(root, 'custom', 'hook.log');
      const limits = { maxBytes: 36, backups: 2 };
      await appendRotating(path, 'old line\n'.repeat(10), { maxBytes: 1000, backups: 2 });
      assert.equal(await appendRotating(path, 'new line\n', limits), true);
      assert.ok((await stat(`${path}.1`)).size <= limits.maxBytes);
      assert.match(await readFile(`${path}.1`, 'utf8'), /^old line\n/);
      assert.equal(await appendRotating(path, 'x'.repeat(37), limits), false);
      for (let i = 0; i < 10; i++) await appendRotating(path, `entry ${i}\n`, limits);
      const files = (await readdir(join(root, 'custom'))).filter((name) => name.startsWith('hook.log'));
      assert.deepEqual(files.sort(), ['hook.log', 'hook.log.1', 'hook.log.2']);
      for (const name of files) assert.ok((await stat(join(root, 'custom', name))).size <= limits.maxBytes);
      assert.match(await readRotatedLog(path, 2), /entry 9/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent hook processes through a rotation boundary', async () => {
    const root = await mkdtemp(join(process.cwd(), '.rotation-test-'));
    try {
      const path = join(root, 'metrics.jsonl');
      const source = `import { appendRotating } from './rotating-log.mjs';
await appendRotating(process.argv[1], JSON.stringify({ ts: 1, id: Number(process.argv[2]) }) + '\\n',
  { maxBytes: 16, backups: 9 });`;
      await Promise.all(Array.from({ length: 10 }, (_, i) =>
        run(process.execPath, ['--input-type=module', '-e', source, path, String(i)])));
      const records = parseLog(await readRotatedLog(path, 9));
      assert.deepEqual(records.map((record) => record.id).sort((a, b) => a - b),
        Array.from({ length: 10 }, (_, i) => i));
      for (let i = 0; i <= 9; i++) {
        const segment = i ? `${path}.${i}` : path;
        assert.ok((await stat(segment)).size <= 16);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the real hook rotates both configured files without changing its exit behavior', async () => {
    const root = await mkdtemp(join(process.cwd(), '.rotation-test-'));
    try {
      const metricsPath = join(root, 'metrics.jsonl');
      const errorPath = join(root, 'hook.log');
      const prefix = `{"ts":${Date.parse('2026-06-23T01:00:00Z')},"event":"skip","padding":"`;
      const suffix = '"}\n';
      await writeFile(metricsPath, prefix + 'x'.repeat(METRICS_LOG_LIMIT.maxBytes - prefix.length - suffix.length) + suffix);
      await writeFile(errorPath, 'x'.repeat(ERROR_LOG_LIMIT.maxBytes - 1) + '\n');

      const result = spawnSync(process.execPath, ['rlm-hook.mjs'], {
        cwd: process.cwd(),
        env: { ...process.env, RLM_METRICS_FILE: metricsPath, RLM_LOG_FILE: errorPath },
        input: '{',
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.ok((await stat(metricsPath)).size <= METRICS_LOG_LIMIT.maxBytes);
      assert.ok((await stat(`${metricsPath}.1`)).size <= METRICS_LOG_LIMIT.maxBytes);
      assert.ok((await stat(errorPath)).size <= ERROR_LOG_LIMIT.maxBytes);
      assert.ok((await stat(`${errorPath}.1`)).size <= ERROR_LOG_LIMIT.maxBytes);
      assert.deepEqual(parseLog(await readLog(metricsPath)).map((record) => record.event), ['skip', 'error']);
      assert.match(await readFile(errorPath, 'utf8'), /Invalid hook input/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns empty history when the metrics path has no segments', async () => {
    const root = await mkdtemp(join(process.cwd(), '.rotation-test-'));
    try {
      assert.equal(await readLog(join(root, 'missing.jsonl')), '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
