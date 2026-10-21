const fs = require('fs').promises;
const path = require('path');
const { randomUUID } = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { canonicalPath } = require('./allowedPaths');
const transactions = new AsyncLocalStorage();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

// Link a fully written owner file so a contender never sees a half-written PID.
async function claimLock(lock) {
  const ownerPath = `${lock}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(ownerPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    await fs.link(ownerPath, lock);
    return await fs.stat(ownerPath);
  } finally {
    await fs.unlink(ownerPath).catch(() => {});
  }
}

async function releaseOwnedLock(lock, owner) {
  try {
    const current = await fs.lstat(lock);
    if (current.dev === owner.dev && current.ino === owner.ino) await fs.unlink(lock);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function withFileTransaction(filePath, action, { timeoutMs = 10000, createDirectory = true, canonicalizeTarget = true } = {}) {
  const resolved = canonicalizeTarget
    ? await canonicalPath(filePath)
    : path.join(await canonicalPath(path.dirname(filePath)), path.basename(filePath));
  const lock = `${resolved}.sb-lock`;
  const held = transactions.getStore();
  if (held && held.has(lock)) return action();
  if (createDirectory) await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let identity;
  while (true) {
    try {
      identity = await claimLock(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const entry = await fs.lstat(lock).catch(failure => {
        if (failure.code !== 'ENOENT') throw failure;
        return null;
      });
      if (!entry) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        const invalid = new Error(`Invalid Signboard lock entry: ${lock}`);
        invalid.code = 'SIGNBOARD_INVALID_LOCK';
        throw invalid;
      }
      // Recovery itself is serialized. An orphaned recovery guard deliberately
      // fails closed; do not guess that a live process is merely slow.
      let reaper = false;
      try {
        await claimLock(`${lock}.reap`);
        reaper = true;
        const owner = Number(await fs.readFile(lock, 'utf8'));
        if (Number.isInteger(owner) && owner > 0 && !alive(owner)) await fs.unlink(lock);
      } catch (failure) {
        if (!['EEXIST', 'ENOENT'].includes(failure.code)) throw failure;
      } finally {
        if (reaper) await fs.unlink(`${lock}.reap`).catch(() => {});
      }
      if (Date.now() >= deadline) {
        const error = new Error(`Another Signboard process is saving ${path.basename(filePath)}. Retry shortly. If this persists after all Signboard processes stop, inspect the .sb-lock and .sb-lock.reap owner files.`);
        error.code = 'SIGNBOARD_LOCK_TIMEOUT';
        throw error;
      }
      await pause(20);
    }
  }
  try {
    return await transactions.run(new Set([...(held || []), lock]), action);
  } finally {
    await releaseOwnedLock(lock, identity);
  }
}

// Board scope also protects filenames changed by moves, archive and reordering.
// The non-Markdown lock is outside list directories and never a card.
function withBoardTransaction(boardRoot, action, options) {
  return withFileTransaction(path.join(boardRoot, '.signboard-write'), action, { createDirectory: false, ...options, canonicalizeTarget: false });
}

// The lock travels with a renamed board. New-path writers wait on that same
// inode; old-path waiters fail if the directory disappears. Only remove our own
// inode, even if another board was created at the original path in the meantime.
async function withBoardRelocationTransaction(sourceRoot, destinationRoot, action) {
  const sourceLock = path.join(await canonicalPath(sourceRoot), '.signboard-write.sb-lock');
  const destinationLock = path.join(await canonicalPath(destinationRoot), '.signboard-write.sb-lock');
  const existing = transactions.getStore();
  if (existing && existing.has(sourceLock) && existing.has(destinationLock)) return action();
  return withBoardTransaction(sourceRoot, async () => {
    const identity = await fs.stat(sourceLock);
    const held = transactions.getStore();
    try {
      return await transactions.run(new Set([...held, destinationLock]), action);
    } finally {
      if (destinationLock !== sourceLock) await releaseOwnedLock(destinationLock, identity);
    }
  });
}

module.exports = { withFileTransaction, withBoardTransaction, withBoardRelocationTransaction };
