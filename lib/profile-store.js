'use strict';

const { randomUUID } = require('node:crypto');
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
    // lock holder; only ESRCH is proof that the pid has exited.
    return Boolean(error && error.code === 'EPERM');
  }
}

async function readLockInfo(lockPath, { fsApi = fs } = {}) {
  try {
    const [text, stat] = await Promise.all([fsApi.readFile(lockPath, 'utf8'), fsApi.stat(lockPath)]);
    let record = null;
    try {
      record = JSON.parse(text);
    } catch {
      // An interrupted lock write is unsafe to trust. Its mtime is still a
      // useful lease deadline for staleness handling.
    }
    return {
      lockPath,
      record: isPlainObject(record) ? record : null,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function isLockStale(lockPath, { fsApi = fs, now = defaultNowMs, staleMs = 30_000, isProcessAlive = processIsAlive } = {}) {
  const info = await readLockInfo(lockPath, { fsApi });
  if (!info) {
    return false;
  }
  const recordedAt = Date.parse(info.record?.created_at || '');
  const acquiredAt = Number.isNaN(recordedAt) ? info.mtimeMs : recordedAt;
  if (now() - acquiredAt > staleMs) {
    return true;
  }
  return !isProcessAlive(info.record?.pid);
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
    const token = randomUUID();
    try {
      const handle = await fsApi.open(lockPath, 'wx', 0o600);
      const record = { pid, created_at: new Date(now()).toISOString(), token };
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      let released = false;
      return {
        lockPath,
        record,
        async release() {
          if (released) {
            return;
          }
          released = true;
          await handle.close();
          const current = await readLockInfo(lockPath, { fsApi });
          if (current?.record?.token === token) {
            try {
              await fsApi.unlink(lockPath);
            } catch (error) {
              if (!error || error.code !== 'ENOENT') {
                throw error;
              }
            }
          }
        },
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }

      if (await isLockStale(lockPath, { fsApi, now, staleMs, isProcessAlive })) {
        if (typeof onStaleLock === 'function') {
          onStaleLock(lockPath);
        }
        try {
          await fsApi.unlink(lockPath);
        } catch (unlinkError) {
          if (!unlinkError || unlinkError.code !== 'ENOENT') {
            throw unlinkError;
          }
        }
        continue;
      }

      if (now() >= deadline) {
        const timeout = new Error(`Timed out waiting for profile lock: ${lockPath}`);
        timeout.code = 'ELOCKED';
        throw timeout;
      }
      await sleepFn(Math.max(1, retryMs));
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
