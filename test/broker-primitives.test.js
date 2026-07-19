'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createLedger } = require('../lib/ledger');
const {
  acquireProfileLock,
  createProfileStore,
  isLockStale,
} = require('../lib/profile-store');
const { projectIdForRoot, resolveProjectIdentity } = require('../lib/project-identity');
const { createProjectRegistry } = require('../lib/project-registry');

async function temporaryDirectory(t, prefix = 'osmosis-broker-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function entry({ strength = 2, seen = 1, correct = 1, updatedAt = '2026-07-19T00:00:00.000Z' } = {}) {
  return { name: 'A concept', strength, seen, correct, updated_at: updatedAt };
}

test('project identity walks to git roots, preserves legacy subdirectory state, and canonicalizes symlinks', async (t) => {
  const directory = await temporaryDirectory(t);
  const root = path.join(directory, 'my repository');
  const nested = path.join(root, 'packages', 'web');
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const canonicalNested = await fs.realpath(nested);

  const repoIdentity = await resolveProjectIdentity(nested);
  assert.equal(repoIdentity.root, canonicalRoot);
  assert.equal(repoIdentity.project_id, projectIdForRoot(canonicalRoot));
  assert.match(repoIdentity.project_id, /^my-repository-[a-f0-9]{10}$/);
  assert.equal(repoIdentity.legacy_state_root, false);

  await fs.mkdir(path.join(nested, '.osmosis'));
  const legacyIdentity = await resolveProjectIdentity(nested);
  assert.equal(legacyIdentity.root, canonicalNested);
  assert.equal(legacyIdentity.legacy_state_root, true);

  await fs.rm(path.join(nested, '.osmosis'), { recursive: true });
  const alias = path.join(directory, 'repo-alias');
  await fs.symlink(root, alias, 'dir');
  const viaAlias = await resolveProjectIdentity(path.join(alias, 'packages', 'web'));
  assert.equal(viaAlias.root, canonicalRoot);
  assert.equal(viaAlias.project_id, repoIdentity.project_id);
});

test('registry persists cheap summaries, keeps tokens ephemeral, and hydrates channels only on demand', async (t) => {
  const directory = await temporaryDirectory(t);
  const profileDir = path.join(directory, 'profile');
  let tick = 0;
  let tokenNumber = 0;
  const registry = createProjectRegistry({
    profileDir,
    now: () => `2026-07-19T00:00:0${++tick}.000Z`,
    tokenFactory: () => `a-safe-test-registration-token-${++tokenNumber}`,
  });
  await registry.load();
  const identity = {
    project_id: 'alpha-0123456789',
    root: path.join(directory, 'alpha'),
    name: 'Alpha',
  };

  const registration = await registry.registerProject(identity);
  assert.equal(registration.project_id, identity.project_id);
  assert.equal(registry.validateToken(identity.project_id, registration.token), true);
  assert.equal(registry.validateToken(identity.project_id, 'not-the-token'), false);
  const secondRegistration = await registry.registerProject(identity);
  assert.equal(registry.validateToken(identity.project_id, registration.token), true);
  assert.equal(registry.validateToken(identity.project_id, secondRegistration.token), true);
  await registry.setUnansweredCount(identity.project_id, 3);
  await registry.setArchived(identity.project_id, true);
  const active = await registry.markActivity(identity.project_id, { unansweredCount: 2 });
  assert.equal(active.archived, false);
  assert.equal(active.unanswered_count, 2);

  let builds = 0;
  const [first, second] = await Promise.all([
    registry.hydrateProject(identity.project_id, async (summary) => {
      builds += 1;
      return { root: summary.root, marker: 'channel' };
    }),
    registry.hydrateProject(identity.project_id, async () => {
      builds += 1;
      return { marker: 'should-not-build' };
    }),
  ]);
  assert.equal(builds, 1);
  assert.equal(first, second);
  assert.equal(registry.getHydratedProject(identity.project_id).marker, 'channel');

  const document = JSON.parse(await fs.readFile(path.join(profileDir, 'projects.json'), 'utf8'));
  assert.equal(document.version, 1);
  assert.deepEqual(Object.keys(document.projects[0]).sort(), [
    'archived',
    'last_activity_at',
    'name',
    'project_id',
    'root',
    'unanswered_count',
  ]);
  assert.equal(JSON.stringify(document).includes(registration.token), false);
  assert.equal(JSON.stringify(document).includes(secondRegistration.token), false);

  const restarted = createProjectRegistry({ profileDir });
  await restarted.load();
  assert.equal(restarted.getHydratedProject(identity.project_id), null);
  assert.equal(restarted.validateToken(identity.project_id, registration.token), false);
  assert.deepEqual(restarted.getProject(identity.project_id), registry.getProject(identity.project_id));
});

test('inactive channels collapse without deletion and new activity restores their summary', async (t) => {
  const directory = await temporaryDirectory(t);
  let milliseconds = Date.parse('2026-07-19T00:00:00.000Z');
  const registry = createProjectRegistry({
    archiveAfterMs: 1_000,
    now: () => new Date(milliseconds).toISOString(),
    profileDir: path.join(directory, 'profile'),
  });
  const active = {
    project_id: 'active-0123456789',
    root: path.join(directory, 'active'),
    name: 'Active',
  };
  const dormant = {
    project_id: 'dormant-0123456789',
    root: path.join(directory, 'dormant'),
    name: 'Dormant',
  };
  await Promise.all([registry.ensureProject(active), registry.ensureProject(dormant)]);
  milliseconds += 1_001;

  const archived = await registry.archiveInactive({ exceptProjectId: active.project_id });
  assert.deepEqual(archived.map((summary) => summary.project_id), [dormant.project_id]);
  assert.equal(registry.getProject(active.project_id).archived, false);
  assert.equal(registry.getProject(dormant.project_id).archived, true);

  const restored = await registry.markActivity(dormant.project_id, { unansweredCount: 1 });
  assert.equal(restored.archived, false);
  assert.equal(restored.unanswered_count, 1);
  const persisted = JSON.parse(await fs.readFile(path.join(directory, 'profile', 'projects.json'), 'utf8'));
  assert.equal(persisted.projects.find((summary) => summary.project_id === dormant.project_id).archived, false);
});

test('user-level ledgers retain explicit trace context, rotate bounded JSONL, and reconcile dangling reports', async (t) => {
  const directory = await temporaryDirectory(t);
  const projectId = 'alpha-0123456789';
  const ledger = createLedger({ profileDir: path.join(directory, 'profile'), maxBytes: 350, ringSize: 20 });
  const projectLedger = ledger.forProject(projectId);

  await projectLedger.append({
    event: 'accept',
    report_id: 'report-1',
    state: 'observed',
    message: 'The broker accepted the report.',
  });
  await ledger.append(projectId, {
    event: 'provider-result',
    report_id: 'report-2',
    card_id: 'card-2',
    concept_id: 'alpha-0123456789:rendering',
    state: 'delivered',
    message: 'x'.repeat(250),
  });
  const entries = await ledger.list(projectId, { limit: 10 });
  assert.deepEqual(entries.map((item) => item.report_id), ['report-1', 'report-2']);
  assert.deepEqual(entries.map((item) => item.state), ['observed', 'delivered']);
  assert.equal(await fs.stat(ledger.rotationPathFor(projectId)).then(() => true), true);
  assert.equal(await fs.stat(ledger.filePathFor(projectId)).then(() => true), true);

  await ledger.append(projectId, { event: 'accept', report_id: 'report-dangling', state: 'waiting' });
  const reconciled = await ledger.reconcileDangling(projectId);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].report_id, 'report-dangling');
  assert.equal(reconciled[0].state, 'skipped');

  await ledger.append(undefined, {
    event: 'ambient-unregistered',
    state: 'suppressed',
    reason: 'unregistered',
  });
  assert.equal((await ledger.list('unregistered')).at(-1).reason, 'unregistered');
  assert.equal(path.basename(ledger.filePathFor()), 'unregistered.jsonl');
});

test('profile store update serializes cross-process-style mutations and keeps its loaded object stable', async (t) => {
  const directory = await temporaryDirectory(t);
  const profilePath = path.join(directory, 'profile', 'profile.json');
  const first = createProfileStore({ profilePath, lockOptions: { retryMs: 1, timeoutMs: 1_000 } });
  const second = createProfileStore({ profilePath, lockOptions: { retryMs: 1, timeoutMs: 1_000 } });
  const stable = await first.load();
  await second.load();

  const [leftResult, rightResult] = await Promise.all([
    first.update((fresh) => {
      fresh.alpha = entry();
      return 'alpha-written';
    }),
    second.update((fresh) => {
      fresh.beta = entry();
      return 'beta-written';
    }),
  ]);
  assert.deepEqual([leftResult, rightResult].sort(), ['alpha-written', 'beta-written']);
  const disk = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  assert.ok(disk.alpha);
  assert.ok(disk.beta);
  assert.equal(await first.load(), stable);
  assert.ok(stable.alpha);

  // save() is compatibility for existing answer-service callers that mutate
  // their shared strengths object before persisting it. Two stale snapshots
  // still preserve both increments under the O_EXCL lock.
  const third = createProfileStore({ profilePath: path.join(directory, 'compat.json'), lockOptions: { retryMs: 1, timeoutMs: 1_000 } });
  const fourth = createProfileStore({ profilePath: path.join(directory, 'compat.json'), lockOptions: { retryMs: 1, timeoutMs: 1_000 } });
  await Promise.all([third.load(), fourth.load()]);
  third.strengths.topic = entry();
  fourth.strengths.topic = entry();
  await Promise.all([third.save(), fourth.save()]);
  const compatibilityDisk = JSON.parse(await fs.readFile(path.join(directory, 'compat.json'), 'utf8'));
  assert.equal(compatibilityDisk.topic.strength, 2);
  assert.equal(compatibilityDisk.topic.seen, 2);
  assert.equal(compatibilityDisk.topic.correct, 2);
});

test('profile lock waits for a live owner and recovers stale lockfiles', async (t) => {
  const directory = await temporaryDirectory(t);
  const lockPath = path.join(directory, 'profile.json.lock');
  const first = await acquireProfileLock({ lockPath, retryMs: 1, timeoutMs: 1_000 });
  const waiting = acquireProfileLock({ lockPath, retryMs: 1, timeoutMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await first.release();
  const second = await waiting;
  await second.release();

  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ pid: 999999, created_at: '2000-01-01T00:00:00.000Z', token: 'abandoned' })}\n`,
    'utf8',
  );
  assert.equal(await isLockStale(lockPath, { staleMs: 1 }), true);
  const store = createProfileStore({
    profilePath: path.join(directory, 'profile.json'),
    lockOptions: { staleMs: 1, retryMs: 1, timeoutMs: 1_000 },
  });
  await store.update((fresh) => {
    fresh.recovered = entry();
  });
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  assert.equal(store.strengths.recovered.strength, 2);
});

test('profile lock never evicts a live holder just because its lease is old', async (t) => {
  const directory = await temporaryDirectory(t);
  const lockPath = path.join(directory, 'profile.json.lock');
  const liveRecord = {
    pid: process.pid,
    created_at: '2000-01-01T00:00:00.000Z',
    token: 'live-owner-token',
  };
  await fs.writeFile(lockPath, `${JSON.stringify(liveRecord)}\n`, 'utf8');

  let milliseconds = Date.parse('2026-07-19T00:00:00.000Z');
  let livenessChecks = 0;
  const lockOptions = {
    lockPath,
    now: () => milliseconds,
    staleMs: 1,
    retryMs: 1,
    timeoutMs: 2,
    sleepFn: async () => {
      milliseconds += 1;
    },
    isProcessAlive(pid) {
      assert.equal(pid, process.pid);
      livenessChecks += 1;
      return true;
    },
  };

  assert.equal(await isLockStale(lockPath, lockOptions), false);
  await assert.rejects(acquireProfileLock(lockOptions), { code: 'ELOCKED' });
  assert.equal(livenessChecks > 0, true);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), liveRecord);
});

test('profile lock recovers an aged incomplete publication without breaking a complete live lock', async (t) => {
  const directory = await temporaryDirectory(t);
  const lockPath = path.join(directory, 'profile.json.lock');
  const oldDate = new Date('2000-01-01T00:00:00.000Z');
  const nowMs = Date.parse('2026-07-19T00:00:00.000Z');
  const staleOptions = {
    lockPath,
    now: () => nowMs,
    staleMs: 1,
    retryMs: 1,
    timeoutMs: 100,
    isProcessAlive: () => false,
  };

  // Simulate the old open('wx') -> write crash window. The new temp + link
  // publication path never creates a public lock in this state.
  await fs.writeFile(lockPath, '', 'utf8');
  await fs.utimes(lockPath, oldDate, oldDate);
  assert.equal(await isLockStale(lockPath, staleOptions), true);
  const recovered = await acquireProfileLock(staleOptions);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), recovered.record);
  await recovered.release();
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });

  const liveRecord = {
    pid: process.pid,
    created_at: oldDate.toISOString(),
    token: 'complete-live-owner-token',
  };
  await fs.writeFile(lockPath, `${JSON.stringify(liveRecord)}\n`, 'utf8');
  let elapsed = nowMs;
  let livenessChecks = 0;
  await assert.rejects(
    acquireProfileLock({
      ...staleOptions,
      now: () => elapsed,
      timeoutMs: 2,
      sleepFn: async () => {
        elapsed += 1;
      },
      isProcessAlive(pid) {
        assert.equal(pid, process.pid);
        livenessChecks += 1;
        return true;
      },
    }),
    { code: 'ELOCKED' },
  );
  assert.equal(livenessChecks > 0, true);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), liveRecord);
});

test('profile lock reclaims a dead holder and restores a replacement that races stale recovery', async (t) => {
  const directory = await temporaryDirectory(t);
  const lockPath = path.join(directory, 'profile.json.lock');
  const deadRecord = {
    pid: 999999,
    created_at: '2000-01-01T00:00:00.000Z',
    token: 'dead-owner-token',
  };
  const now = () => Date.parse('2026-07-19T00:00:00.000Z');
  const deadHolderOptions = {
    lockPath,
    now,
    staleMs: 1,
    retryMs: 1,
    timeoutMs: 100,
    isProcessAlive: () => false,
  };

  await fs.writeFile(lockPath, `${JSON.stringify(deadRecord)}\n`, 'utf8');
  const recovered = await acquireProfileLock(deadHolderOptions);
  assert.notEqual(recovered.record.token, deadRecord.token);
  await recovered.release();
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });

  await fs.writeFile(lockPath, `${JSON.stringify(deadRecord)}\n`, 'utf8');
  const racedReplacement = {
    pid: process.pid,
    created_at: '2000-01-01T00:00:00.000Z',
    token: 'replacement-live-owner-token',
  };
  let raced = false;
  const fsApi = Object.create(fs);
  fsApi.rename = async (from, to) => {
    if (!raced && from === lockPath && path.basename(to).includes('.reclaim.')) {
      raced = true;
      // Simulate a different writer installing a valid lock after our last
      // read but before the stale-recovery rename. The implementation must
      // detect the token mismatch and restore it without clobbering it.
      await fs.unlink(from);
      await fs.writeFile(from, `${JSON.stringify(racedReplacement)}\n`, 'utf8');
    }
    return fs.rename(from, to);
  };

  let milliseconds = now();
  await assert.rejects(
    acquireProfileLock({
      ...deadHolderOptions,
      fsApi,
      now: () => milliseconds,
      timeoutMs: 2,
      sleepFn: async () => {
        milliseconds += 1;
      },
      isProcessAlive(pid) {
        return pid !== deadRecord.pid;
      },
    }),
    { code: 'ELOCKED' },
  );
  assert.equal(raced, true);
  assert.deepEqual(JSON.parse(await fs.readFile(lockPath, 'utf8')), racedReplacement);
  const remaining = await fs.readdir(directory);
  assert.equal(remaining.some((name) => name.includes('.reclaim.')), false);
});
