/** Bounded, best-effort append for files written by concurrent hook processes. */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { setTimeout as delay } from 'timers/promises';

export const METRICS_LOG_LIMIT = Object.freeze({ maxBytes: 8 * 1024 * 1024, backups: 3 });
export const ERROR_LOG_LIMIT = Object.freeze({ maxBytes: 2 * 1024 * 1024, backups: 2 });

async function withLock(path, work) {
  const lockPath = `${path}.lock`;
  let lock;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      lock = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A killed hook can leave a lock behind. Its normal lifetime is a few ms.
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) await rm(lockPath);
      } catch (checkError) {
        if (checkError.code !== 'ENOENT') throw checkError;
      }
      await delay(10);
    }
  }
  if (!lock) throw new Error(`Timed out waiting for log lock: ${lockPath}`);
  try {
    return await work();
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

async function renameIfPresent(from, to) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function rotate(path, { maxBytes, backups }, oldSize) {
  await rm(`${path}.${backups}`, { force: true });
  for (let i = backups - 1; i >= 1; i--) {
    await renameIfPresent(`${path}.${i}`, `${path}.${i + 1}`);
  }
  await renameIfPresent(path, `${path}.1`);

  // A legacy file can already exceed the limit. Retain only complete recent
  // lines so its first backup is bounded and JSONL remains parseable.
  if (oldSize > maxBytes) {
    const file = await open(`${path}.1`, 'r');
    const tail = Buffer.alloc(maxBytes);
    try {
      await file.read(tail, 0, maxBytes, oldSize - maxBytes);
    } finally {
      await file.close();
    }
    const firstNewline = tail.indexOf(10);
    await writeFile(`${path}.1`, firstNewline < 0 ? '' : tail.subarray(firstNewline + 1));
  }
}

/** Append one complete line; overlong individual entries are dropped. */
export async function appendRotating(path, line, limits) {
  const bytes = Buffer.byteLength(line);
  if (bytes > limits.maxBytes) return false;
  await mkdir(dirname(path), { recursive: true });
  return withLock(path, async () => {
    let oldSize = 0;
    try {
      oldSize = (await stat(path)).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (oldSize + bytes > limits.maxBytes) await rotate(path, limits, oldSize);
    await writeFile(path, line, { flag: 'a' });
    return true;
  });
}

/** Read oldest backup through current file as one newline-separated snapshot. */
export async function readRotatedLog(path, backups) {
  await mkdir(dirname(path), { recursive: true });
  return withLock(path, async () => {
    const parts = [];
    for (let i = backups; i >= 0; i--) {
      try {
        parts.push(await readFile(i ? `${path}.${i}` : path, 'utf-8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return parts.join('\n');
  });
}
