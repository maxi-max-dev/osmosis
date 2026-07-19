'use strict';

const { randomUUID } = require('node:crypto');
const nodeFs = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneProfile(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

function integerAtLeastZero(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizedStrength(value) {
  return Number.isInteger(value) ? Math.max(0, Math.min(2, value)) : 0;
}

function latestTimestamp(...values) {
  let latest = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const time = Date.parse(value);
    if (!Number.isNaN(time) && time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

function mergeEntry(onDisk, local, baseline) {
  const disk = isPlainObject(onDisk) ? onDisk : {};
  const next = isPlainObject(local) ? local : {};
  const before = isPlainObject(baseline) ? baseline : {};
  const seenDelta = Math.max(0, integerAtLeastZero(next.seen) - integerAtLeastZero(before.seen));
  const correctDelta = Math.max(0, integerAtLeastZero(next.correct) - integerAtLeastZero(before.correct));
  const merged = {
    ...disk,
    // Only fill incidental fields from a stale caller when the current disk
    // value has none. Counters and mastery are handled explicitly below.
    ...Object.fromEntries(Object.entries(next).filter(([key]) => !(key in disk))),
  };

  if (typeof next.name === 'string' && next.name) {
    merged.name = next.name;
  } else if (typeof disk.name === 'string') {
    merged.name = disk.name;
  }
  merged.strength = Math.max(normalizedStrength(disk.strength), normalizedStrength(next.strength));
  merged.seen = integerAtLeastZero(disk.seen) + seenDelta;
  merged.correct = integerAtLeastZero(disk.correct) + correctDelta;
  const timestamp = latestTimestamp(disk.updated_at, next.updated_at, before.updated_at);
  if (timestamp) {
    merged.updated_at = timestamp;
  }
  return merged;
}

/**
 * Merge a snapshot supplied by an older process into the newest disk profile
 * without losing monotonic mastery or count increments. The baseline is this
 * store's last successfully persisted snapshot, so a second queued save does
 * not repeat the first save's deltas.
 */
function mergeProfiles(onDisk, local, baseline) {
  const disk = cloneProfile(onDisk);
  const snapshot = cloneProfile(local);
  const before = cloneProfile(baseline);
  const merged = {};
  const conceptIds = new Set([...Object.keys(disk), ...Object.keys(snapshot)]);
  for (const conceptId of conceptIds) {
    merged[conceptId] = mergeEntry(disk[conceptId], snapshot[conceptId], before[conceptId]);
  }
  return merged;
}

function replaceObjectInPlace(target, value) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  for (const [key, entry] of Object.entries(value || {})) {
    // defineProperty avoids the special __proto__ setter on normal objects.
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: entry,
      writable: true,
    });
  }
  return target;
}

async function readProfile(profilePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(profilePath, 'utf8'));
    return cloneProfile(parsed);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultNowMs() {
  return Date.now();
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user. It is still a live
    // lock holder; only ESRCH is proof that the pid has exited. Be
    // conservative for every other error too: incorrectly retaining a stale
    // lock is recoverable, but evicting a live writer is not.
    return !error || error.code !== 'ESRCH';
  }
}

function lockRecordIdentity(record) {
  if (!isPlainObject(record)
    || !Number.isInteger(record.pid)
    || record.pid <= 0
    || typeof record.token !== 'string'
    || !record.token) {
    return null;
  }
  return { pid: record.pid, token: record.token };
}

function hasSameLockIdentity(left, right) {
  const leftIdentity = lockRecordIdentity(left);
  const rightIdentity = lockRecordIdentity(right);
  return Boolean(leftIdentity
    && rightIdentity
    && leftIdentity.pid === rightIdentity.pid
    && leftIdentity.token === rightIdentity.token);
}

function lockAcquiredAt(info) {
  const recordedAt = Date.parse(info?.record?.created_at || '');
  return Number.isNaN(recordedAt) ? info?.mtimeMs : recordedAt;
}

async function readLockInfo(lockPath, { fsApi = fs } = {}) {
  try {
    const [text, stat] = await Promise.all([fsApi.readFile(lockPath, 'utf8'), fsApi.stat(lockPath)]);
    let record = null;
    try {
      record = JSON.parse(text);
    } catch {
      // Valid older records without a timestamp may still use the file mtime
      // below. Aged malformed records are reclaimed through inode-checked
      // recovery because new publication can no longer create them publicly.
    }
    return {
      dev: stat.dev,
      ino: stat.ino,
      lockPath,
      record: isPlainObject(record) ? record : null,
      mtimeMs: stat.mtimeMs,
      raw: text,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function isLockInfoStale(info, { now = defaultNowMs, staleMs = 30_000, isProcessAlive = processIsAlive } = {}) {
  const identity = lockRecordIdentity(info?.record);
  // A malformed record cannot authoritatively tell us when it was acquired;
  // use the filesystem timestamp for the old crash-artifact path instead.
  const acquiredAt = identity ? lockAcquiredAt(info) : info?.mtimeMs;
  if (!Number.isFinite(acquiredAt) || now() - acquiredAt <= staleMs) {
    return false;
  }
  if (!identity) {
    // New acquisition publishes a complete record atomically, so an aged
    // incomplete record can only be an interrupted publication from an older
    // build (or an orphaned/corrupt file). It has no holder we can check; once
    // it has aged past the lease, let the ownership-checked recovery path
    // clear it instead of permanently blocking every writer.
    return true;
  }
  // A stale lease alone is never enough: an overloaded but live process must
  // retain its lock. `processIsAlive` treats unknown errors as live, so false
  // here is a confirmed-dead holder.
  return !isProcessAlive(identity.pid);
}

function hasSameMalformedLock(left, right) {
  if (!left || !right || lockRecordIdentity(left.record) || lockRecordIdentity(right.record)) {
    return false;
  }
  // Prefer the filesystem identity so a replacement between the initial read
  // and rename cannot be mistaken for the stale malformed file we observed.
  if (Number.isInteger(left.dev) && Number.isInteger(left.ino)
    && Number.isInteger(right.dev) && Number.isInteger(right.ino)) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  // Node's real Stats exposes dev/ino. This fallback keeps custom test or
  // exotic filesystem adapters conservative enough to restore replacements.
  return left.raw === right.raw && left.mtimeMs === right.mtimeMs;
}

function hasSameLockInfo(left, right) {
  const leftIdentity = lockRecordIdentity(left?.record);
  const rightIdentity = lockRecordIdentity(right?.record);
  if (leftIdentity || rightIdentity) {
    return hasSameLockIdentity(left?.record, right?.record);
  }
  return hasSameMalformedLock(left, right);
}

async function isLockStale(lockPath, options = {}) {
  const { fsApi = fs } = options;
  const info = await readLockInfo(lockPath, { fsApi });
  return isLockInfoStale(info, options);
}

function isMissingFileError(error) {
  return Boolean(error && error.code === 'ENOENT');
}

function isRestoreFallbackError(error) {
  return Boolean(error && ['EPERM', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(error.code));
}

async function removeFileIfPresent(filePath, { fsApi = fs } = {}) {
  try {
    await fsApi.unlink(filePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Put a lock that was moved aside during a failed identity check back without
 * overwriting a contender that acquired the original pathname meanwhile.
 * A hard link is an atomic no-clobber restore within the same directory.
 */
async function restoreMovedLock(lockPath, movedPath, { fsApi = fs } = {}) {
  try {
    await fsApi.link(movedPath, lockPath);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return false;
    }
    if (!isRestoreFallbackError(error)) {
      if (isMissingFileError(error)) {
        return false;
      }
      throw error;
    }

    // `link` is available on the supported desktop platforms, but use a
    // no-clobber copy as a conservative fallback for filesystems that reject
    // hard links. The copied lock has the same token and is re-verified by
    // every acquirer before it can be treated as owned.
    try {
      await fsApi.copyFile(movedPath, lockPath, nodeFs.constants.COPYFILE_EXCL);
    } catch (copyError) {
      if ((copyError && copyError.code === 'EEXIST') || isMissingFileError(copyError)) {
        return false;
      }
      throw copyError;
    }
  }

  try {
    await removeFileIfPresent(movedPath, { fsApi });
  } catch {
    // The restored primary pathname is safe. Leaving an unreachable recovery
    // file is preferable to risking removal of a lock we no longer own.
  }
  return true;
}

/**
 * Atomically detach a particular lock file, then re-read the moved inode.
 * If another process replaced the pathname between our read and rename, the
 * identity check fails and we restore it without clobbering a newer owner.
 */
async function moveLockAsideIfMatches(lockPath, expectedInfo, {
  fsApi = fs,
  label = 'reclaim',
} = {}) {
  const beforeMove = await readLockInfo(lockPath, { fsApi });
  if (!hasSameLockInfo(beforeMove, expectedInfo)) {
    return null;
  }

  const movedPath = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.${label}.${process.pid}.${randomUUID()}`,
  );
  try {
    await fsApi.rename(lockPath, movedPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  let moved;
  try {
    moved = await readLockInfo(movedPath, { fsApi });
  } catch (error) {
    await restoreMovedLock(lockPath, movedPath, { fsApi });
    throw error;
  }
  if (!hasSameLockInfo(moved, expectedInfo)) {
    await restoreMovedLock(lockPath, movedPath, { fsApi });
    return null;
  }
  return { info: moved, movedPath };
}

async function moveLockAsideIfOwned(lockPath, expectedRecord, options = {}) {
  return moveLockAsideIfMatches(lockPath, { record: expectedRecord }, options);
}

async function removeOwnedLock(lockPath, expectedRecord, { fsApi = fs } = {}) {
  const moved = await moveLockAsideIfOwned(lockPath, expectedRecord, { fsApi, label: 'release' });
  if (!moved) {
    return false;
  }
  try {
    // Re-check after the rename too. No normal contender knows this random
    // pathname, but this keeps ownership explicit at every destructive step.
    const finalInfo = await readLockInfo(moved.movedPath, { fsApi });
    if (!hasSameLockIdentity(finalInfo?.record, expectedRecord)) {
      await restoreMovedLock(lockPath, moved.movedPath, { fsApi });
      return false;
    }
    await removeFileIfPresent(moved.movedPath, { fsApi });
    return true;
  } catch (error) {
    await restoreMovedLock(lockPath, moved.movedPath, { fsApi });
    throw error;
  }
}

async function reclaimStaleLock(lockPath, expectedInfo, options = {}) {
  const { fsApi = fs } = options;
  if (!await isLockInfoStale(expectedInfo, options)) {
    return false;
  }
  const moved = await moveLockAsideIfMatches(lockPath, expectedInfo, { fsApi, label: 'reclaim' });
  if (!moved) {
    return false;
  }

  try {
    // PID liveness can change while we contend. Requiring dead-holder status
    // again after the rename ensures a live process is never evicted merely
    // because its timestamp was old.
    if (!await isLockInfoStale(moved.info, options)) {
      await restoreMovedLock(lockPath, moved.movedPath, { fsApi });
      return false;
    }
    const finalInfo = await readLockInfo(moved.movedPath, { fsApi });
    if (!hasSameLockInfo(finalInfo, expectedInfo)
      || !await isLockInfoStale(finalInfo, options)) {
      await restoreMovedLock(lockPath, moved.movedPath, { fsApi });
      return false;
    }
    await removeFileIfPresent(moved.movedPath, { fsApi });
    return true;
  } catch (error) {
    await restoreMovedLock(lockPath, moved.movedPath, { fsApi });
    throw error;
  }
}

/**
 * Publish a fully written lock record without ever creating an empty public
 * pathname. `link` is an atomic no-clobber operation: either the complete
 * temporary file becomes the lock, or an existing contender remains intact.
 */
async function publishLockRecord(lockPath, record, { fsApi = fs } = {}) {
  const temporaryPath = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.publish.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle = null;
  let temporaryCreated = false;
  try {
    handle = await fsApi.open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.close();
    handle = null;

    try {
      await fsApi.link(temporaryPath, lockPath);
      return true;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Keep the acquisition error; the private path is cleaned below.
      }
    }
    if (temporaryCreated) {
      try {
        await fsApi.unlink(temporaryPath);
      } catch {
        // A leftover private hard link cannot block future acquisition. It is
        // safer to leave it than to turn an owned public lock into an error.
      }
    }
  }
}

async function acquireProfileLock({
  lockPath,
  fsApi = fs,
  now = defaultNowMs,
  sleepFn = sleep,
  pid = process.pid,
  staleMs = 30_000,
  retryMs = 25,
  timeoutMs = 5_000,
  isProcessAlive = processIsAlive,
  onStaleLock,
} = {}) {
  if (typeof lockPath !== 'string' || !lockPath) {
    throw new TypeError('acquireProfileLock needs lockPath.');
  }
  await fsApi.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = now() + Math.max(0, timeoutMs);

  while (true) {
    const record = {
      pid,
      created_at: new Date(now()).toISOString(),
      token: randomUUID(),
    };
    const published = await publishLockRecord(lockPath, record, { fsApi });

    if (!published) {
      const current = await readLockInfo(lockPath, { fsApi });
      if (await reclaimStaleLock(lockPath, current, { fsApi, now, staleMs, isProcessAlive })) {
        if (typeof onStaleLock === 'function') {
          onStaleLock(lockPath);
        }
        continue;
      }

      if (now() >= deadline) {
        const timeout = new Error(`Timed out waiting for profile lock: ${lockPath}`);
        timeout.code = 'ELOCKED';
        throw timeout;
      }
      await sleepFn(Math.max(1, retryMs));
      continue;
    }

    try {
      // Publishing the hard link establishes a path-level candidate, not
      // permanent ownership: stale recovery or a replacement race may have
      // moved it before we return. Require our pid/token to still be public.
      const current = await readLockInfo(lockPath, { fsApi });
      if (!hasSameLockIdentity(current?.record, record)) {
        await removeOwnedLock(lockPath, record, { fsApi });
        if (now() >= deadline) {
          const timeout = new Error(`Timed out waiting for profile lock: ${lockPath}`);
          timeout.code = 'ELOCKED';
          throw timeout;
        }
        await sleepFn(Math.max(1, retryMs));
        continue;
      }

      let released = false;
      return {
        lockPath,
        record,
        async release() {
          if (released) {
            return;
          }
          released = true;
          // Never unlink the public path after a separate read: a later owner
          // could have taken it. The release helper moves and verifies our
          // token before removing anything.
          await removeOwnedLock(lockPath, record, { fsApi });
        },
      };
    } catch (error) {
      // If publication left our record behind, remove only that exact token.
      await removeOwnedLock(lockPath, record, { fsApi });
      throw error;
    }
  }
}

/**
 * One process-wide view of the shared mastery profile. `strengths` never
 * changes identity after load(), which lets every hydrated project alias it.
 * update() is the preferred mutation API: its mutator runs against fresh disk
 * state while the cross-process lock is held.
 */
function createProfileStore({
  profilePath,
  lockPath = profilePath && `${profilePath}.lock`,
  lockOptions = {},
  now = defaultNowMs,
} = {}) {
  if (typeof profilePath !== 'string' || !profilePath) {
    throw new TypeError('createProfileStore needs profilePath.');
  }
  const strengths = {};
  let baseline = {};
  let loaded = false;
  let loading = null;
  let writeTail = Promise.resolve();

  async function load() {
    if (loaded) {
      return strengths;
    }
    if (!loading) {
      loading = readProfile(profilePath).then((profile) => {
        replaceObjectInPlace(strengths, profile);
        baseline = cloneProfile(profile);
        loaded = true;
        return strengths;
      });
    }
    return loading;
  }

  function enqueue(work) {
    const next = writeTail.then(work);
    writeTail = next.catch(() => {});
    return next;
  }

  async function withLock(work) {
    const lock = await acquireProfileLock({ lockPath, now, ...lockOptions });
    try {
      return await work();
    } finally {
      await lock.release();
    }
  }

  function update(mutator) {
    if (typeof mutator !== 'function') {
      return Promise.reject(new TypeError('profileStore.update needs a mutator function.'));
    }
    return enqueue(async () => {
      await load();
      return withLock(async () => {
        const fresh = await readProfile(profilePath);
        const result = await mutator(fresh);
        const normalized = cloneProfile(fresh);
        await writeJsonAtomic(profilePath, normalized);
        replaceObjectInPlace(strengths, normalized);
        baseline = cloneProfile(normalized);
        return result;
      });
    });
  }

  function save(nextStrengths = strengths) {
    const snapshot = cloneProfile(nextStrengths);
    return enqueue(async () => {
      await load();
      return withLock(async () => {
        const fresh = await readProfile(profilePath);
        const merged = mergeProfiles(fresh, snapshot, baseline);
        await writeJsonAtomic(profilePath, merged);
        replaceObjectInPlace(strengths, merged);
        baseline = cloneProfile(merged);
        return strengths;
      });
    });
  }

  return {
    get lockPath() {
      return lockPath;
    },
    get strengths() {
      return strengths;
    },
    load,
    save,
    saveProfile: save,
    update,
    whenIdle: () => writeTail,
  };
}

module.exports = {
  acquireProfileLock,
  cloneProfile,
  createProfileStore,
  isLockStale,
  mergeProfiles,
  processIsAlive,
  readLockInfo,
  readProfile,
  replaceObjectInPlace,
  writeJsonAtomic,
};
