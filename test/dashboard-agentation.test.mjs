import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { DEFAULT_DASHBOARD_HOST, startDashboardServer } from '../bench/dashboard.mjs';

const execFileAsync = promisify(execFile);

function findChromium() {
  const override = process.env.AGENTATION_BROWSER;
  if (override) return existsSync(override) ? override : null;

  const names = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  const store = '/nix/store';
  if (!existsSync(store)) return null;
  return readdirSync(store)
    .filter((name) => /-chromium-\d/.test(name) && !name.endsWith('.drv'))
    .map((name) => join(store, name, 'bin', 'chromium'))
    .filter((candidate) => existsSync(candidate))
    .sort()
    .at(-1) ?? null;
}

async function esmShReachable() {
  try {
    const response = await fetch('https://esm.sh/react@18.3.1', {
      method: 'HEAD',
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

test('live dashboard mounts Agentation in Chromium', async (t) => {
  const browser = findChromium();
  if (!browser) {
    t.skip('no Chromium binary found (set AGENTATION_BROWSER to override)');
    return;
  }
  if (!(await esmShReachable())) {
    t.skip('esm.sh is unreachable; the browser cannot import React and Agentation');
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), 'rlm-dashboard-agentation-'));
  const logPath = join(directory, 'metrics.jsonl');
  const profilePath = join(directory, 'chromium-profile');
  writeFileSync(logPath, '');

  const server = startDashboardServer(logPath, { port: 0 });
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, DEFAULT_DASHBOARD_HOST);

    const { stdout } = await execFileAsync(browser, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--dump-dom',
      `--user-data-dir=${profilePath}`,
      '--virtual-time-budget=20000',
      `http://127.0.0.1:${address.port}/`,
    ], { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });

    assert.ok(
      stdout.includes('id="agentation-root"'),
      '#agentation-root is missing after the browser loaded the live dashboard',
    );
    assert.match(stdout, /data-agentation-/, 'Agentation did not render into its root');
  } finally {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      await closed;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
