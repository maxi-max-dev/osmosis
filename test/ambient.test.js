'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ACTIVE_FILE_AGE_MS,
  createAmbientWatcher,
  dateDirectories,
  signalsFromEvent,
  workdirFromEvent,
} = require('../lib/ambient');

function execEvent(cmd, workdir) {
  return {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: JSON.stringify({ cmd, workdir }),
    },
  };
}

function patchEvent(changes, success = true) {
  return {
    type: 'event_msg',
    payload: { type: 'patch_apply_end', changes, success },
  };
}

function mcpEvent(server, tool) {
  return {
    type: 'event_msg',
    payload: { type: 'mcp_tool_call_end', invocation: { server, tool } },
  };
}

function ignoredExecEvent(cmd, workdir) {
  const event = execEvent(cmd, workdir);
  event.payload.metadata = { OSMOSIS_AMBIENT_IGNORE: '1' };
  return event;
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-ambient-'));
  const sessionsDir = path.join(root, 'sessions');
  const projectDir = path.join(root, 'project-a');
  const otherProjectDir = path.join(root, 'project-b');
  await Promise.all([fs.mkdir(projectDir), fs.mkdir(otherProjectDir)]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { otherProjectDir, projectDir, sessionsDir };
}

async function createRollout(sessionsDir, timestamp, { events = [], name = 'ambient-test', raw = '' } = {}) {
  const directory = dateDirectories(sessionsDir, timestamp)[0];
  const filePath = path.join(directory, 'rollout-' + name + '.jsonl');
  const serializedEvents = events.map((event) => JSON.stringify(event)).join('\n');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, raw || (serializedEvents ? serializedEvents + '\n' : ''));
  await fs.utimes(filePath, new Date(timestamp), new Date(timestamp));
  return filePath;
}

async function appendEvents(filePath, timestamp, events) {
  await fs.appendFile(filePath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  await fs.utimes(filePath, new Date(timestamp), new Date(timestamp));
}

function watcherOptions({ clock, projectDir, reports, sessionsDir, ...config }) {
  return {
    config: {
      ambientEnabled: true,
      ambientEmitIntervalMs: 45_000,
      cwd: projectDir,
      sessionsDir,
      ...config,
    },
    now: () => clock.value,
    onReport: (report) => reports.push(report),
  };
}

test('Ambient Watch keeps observed metadata on a strict allowlist', () => {
  const exec = signalsFromEvent(execEvent('npx vite --host local-secret.example', '/tmp/sydney-harbour'))[0];
  assert.equal(exec.label, 'ran npm and vite');
  assert.deepEqual(exec.hints, ['npm', 'vite']);
  assert.equal(exec.workdir, '/tmp/sydney-harbour');
  assert.equal(workdirFromEvent(execEvent('pwd', '/tmp/sydney-harbour')), '/tmp/sydney-harbour');

  const patch = signalsFromEvent(
    patchEvent({
      '/private/project/src/scene.ts': 'this must never be read',
      '/private/project/public/map.css': 'nor this',
    }),
  )[0];
  assert.equal(patch.label, 'applied a file change');
  assert.deepEqual(patch.hints, ['.ts', '.css']);
  assert.equal(patch.kind, 'patch');
  assert.doesNotMatch(JSON.stringify(patch), /scene\.ts|map\.css|private/);

  const knownMcp = signalsFromEvent(mcpEvent('github', 'search_code'))[0];
  assert.equal(knownMcp.label, 'used github');
  assert.deepEqual(knownMcp.hints, ['github']);
  assert.doesNotMatch(JSON.stringify(knownMcp), /search_code/);

  const unknownMcp = signalsFromEvent(mcpEvent('internal-secret-server', 'proprietary_tool'))[0];
  assert.equal(unknownMcp.label, 'used an MCP tool');
  assert.deepEqual(unknownMcp.hints, ['mcp']);
  assert.doesNotMatch(JSON.stringify(unknownMcp), /internal-secret|proprietary/);

  assert.deepEqual(signalsFromEvent(execEvent('pwd', '/tmp/sydney-harbour')), []);
  assert.deepEqual(signalsFromEvent(mcpEvent('osmosis', 'osmosis_report')), []);
  assert.deepEqual(signalsFromEvent(ignoredExecEvent('node build.js', '/tmp/sydney-harbour')), []);
});

test('Ambient Watch offers an eligible event to the warmup fast path before normal 45-second aggregation', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  const observations = [];
  const canonicalProject = await fs.realpath(projectDir);
  const watcher = createAmbientWatcher({
    config: {
      ambientEnabled: true,
      ambientEmitIntervalMs: 45_000,
      cwd: projectDir,
      sessionsDir,
    },
    now: () => clock.value,
    resolveProject(cwd) {
      return cwd === canonicalProject
        ? { project_id: 'project-a-0123456789', root: canonicalProject }
        : { registered: false, root: cwd };
    },
    onReport(report) {
      reports.push(report);
    },
    onWarmupCandidate(observation) {
      observations.push(observation);
      // This models the broker's strict catalog check: only the exact `rg`
      // argv is claimed by the no-generator warmup path. Every other signal
      // remains on the ordinary aggregation path.
      return {
        handled: observation.event?.payload?.input === JSON.stringify({ cmd: 'rg harbour src', workdir: projectDir }),
      };
    },
  });
  t.after(() => watcher.stop());

  await watcher.poll();
  const rollout = await createRollout(sessionsDir, clock.value, { name: 'warmup-fast-path' });

  // The callback runs in this poll, before the configured 45-second cadence.
  // Its handled result must prevent this event from entering the old bucket.
  await appendEvents(rollout, clock.value, [execEvent('rg harbour src', projectDir)]);
  await watcher.poll();
  assert.equal(observations.length, 1);
  assert.equal(reports.length, 0);

  const eligible = observations[0];
  assert.equal(eligible.activity_epoch_id, eligible.observation_id);
  assert.match(eligible.observation_id, /^[a-f0-9]{48}$/);
  assert.match(eligible.rollout_identity, /^[a-f0-9]{48}$/);
  assert.deepEqual(eligible.route, {
    project_id: 'project-a-0123456789',
    reason: '',
    registered: true,
  });
  assert.deepEqual(eligible.report.stack_hints, ['rg']);
  assert.match(eligible.report.what_i_did, /ran rg/);
  assert.doesNotMatch(JSON.stringify(eligible.report), /project-a|warmup-fast-path|harbour|src/);
  assert.equal(Object.hasOwn(eligible.route, 'root'), false);

  // A command outside the catalog still reaches the callback, but an
  // unhandled result falls through to the normal aggregation/delivery path.
  clock.value += 1;
  await appendEvents(rollout, clock.value, [execEvent('node build.js', projectDir)]);
  await watcher.poll();
  assert.equal(observations.length, 2);
  assert.equal(reports.length, 1, 'the first unhandled signal follows the normal immediate bucket delivery');
  assert.deepEqual(reports[0].stack_hints, ['node']);

  // Subsequent ordinary signals retain the original 45-second pace; fast
  // path handling did not create or poison a normal aggregation bucket.
  clock.value += 1;
  await appendEvents(rollout, clock.value, [execEvent('npm test', projectDir)]);
  await watcher.poll();
  assert.equal(reports.length, 1);
  clock.value += 45_000;
  await fs.utimes(rollout, new Date(clock.value), new Date(clock.value));
  await watcher.poll();
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1].stack_hints, ['npm']);
});

test('Ambient Watch attaches existing files at EOF, emits sanitized cards, and paces each session', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  const rollout = await createRollout(sessionsDir, clock.value, {
    events: [execEvent('node old-history.js', projectDir)],
  });
  const watcher = createAmbientWatcher(watcherOptions({ clock, projectDir, reports, sessionsDir }));

  // A rollout already present at startup is history, not a new lesson.
  await watcher.poll();
  assert.deepEqual(reports, []);

  await appendEvents(rollout, clock.value, [
    execEvent('npx vite --host local-secret.example', projectDir),
    patchEvent({ '/private/sydney-map/src/scene.ts': 'private source contents' }),
    mcpEvent('browser', 'open_page'),
    mcpEvent('osmosis', 'osmosis_report'),
    execEvent('ls', projectDir),
  ]);
  await watcher.poll();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, 'observed');
  assert.equal(reports[0].observed_kind, 'change');
  assert.equal(reports[0].task, 'Observed local activity');
  assert.match(reports[0].what_i_did, /ran npm and vite/);
  assert.match(reports[0].what_i_did, /applied a file change/);
  assert.match(reports[0].what_i_did, /used browser/);
  assert.doesNotMatch(JSON.stringify(reports[0]), /local-secret|private source|sydney-map|scene\.ts|open_page/);
  assert.deepEqual(reports[0].stack_hints, ['npm', 'vite', '.ts', 'browser']);

  // Several later signals are held together until the configured per-session
  // interval expires, then become one second observed report.
  clock.value += 1_000;
  await appendEvents(rollout, clock.value, [
    execEvent('node build.js', projectDir),
    patchEvent({ '/private/sydney-map/src/route.css': 'private source contents' }),
    mcpEvent('github', 'search_issues'),
  ]);
  await watcher.poll();
  assert.equal(reports.length, 1);

  clock.value += 45_000;
  await fs.utimes(rollout, new Date(clock.value), new Date(clock.value));
  await watcher.poll();
  assert.equal(reports.length, 2);
  assert.equal(reports[1].observed_kind, 'change');
  assert.deepEqual(reports[1].stack_hints, ['node', '.css', 'github']);
  watcher.stop();
});

test('Ambient Watch requires a canonical target-project cwd before accepting inherited activity', async (t) => {
  const { otherProjectDir, projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  const rollout = await createRollout(sessionsDir, clock.value);
  const watcher = createAmbientWatcher(watcherOptions({
    clock,
    projectDir,
    reports,
    sessionsDir,
    ambientEmitIntervalMs: 1,
  }));
  await watcher.poll();

  // Patch/MCP events do not have their own cwd and must remain silent until an
  // exec event establishes a matching session cwd.
  await appendEvents(rollout, clock.value, [patchEvent({ '/outside/secret.ts': 'nope' }), mcpEvent('github', 'search_code')]);
  await watcher.poll();
  assert.equal(reports.length, 0);

  clock.value += 2;
  await appendEvents(rollout, clock.value, [
    execEvent('pwd', projectDir),
    patchEvent({ '/outside/secret.ts': 'nope' }),
  ]);
  await watcher.poll();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].observed_kind, 'change');

  // A later exec that moves the same session elsewhere clears its inherited
  // context; subsequent patch and MCP events cannot create a card.
  clock.value += 2;
  await appendEvents(rollout, clock.value, [
    // An exec without a current workdir cannot inherit the earlier matching
    // cwd. Only patch/MCP events inherit a session's last-known cwd.
    execEvent('node unknown-workdir.js', ''),
  ]);
  await watcher.poll();
  assert.equal(reports.length, 1);

  clock.value += 2;
  await appendEvents(rollout, clock.value, [
    execEvent('node other-project-build.js', otherProjectDir),
    patchEvent({ '/outside/other.ts': 'nope' }),
    mcpEvent('github', 'search_code'),
  ]);
  await watcher.poll();
  assert.equal(reports.length, 1);
  watcher.stop();
});

test('Ambient Watch keeps rollout buckets by registered project and sends unknown roots only to suppression', async (t) => {
  const { otherProjectDir, projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const delivered = [];
  const suppressed = [];
  const rollout = await createRollout(sessionsDir, clock.value);
  const canonicalA = await fs.realpath(projectDir);
  const canonicalB = await fs.realpath(otherProjectDir);
  const watcher = createAmbientWatcher({
    config: {
      ambientEnabled: true,
      ambientEmitIntervalMs: 45_000,
      cwd: projectDir,
      sessionsDir,
    },
    now: () => clock.value,
    resolveProject(cwd) {
      if (cwd === canonicalA) return { project_id: 'project-a-0123456789', root: canonicalA };
      if (cwd === canonicalB) return { project_id: 'project-b-0123456789', root: canonicalB };
      return { registered: false, root: cwd };
    },
    onReport(report, project) {
      delivered.push({ project, report });
    },
    onSuppressed(entry) {
      suppressed.push(entry);
    },
  });
  await watcher.poll();

  await appendEvents(rollout, clock.value, [execEvent('node first-a.js', projectDir)]);
  await watcher.poll();
  assert.deepEqual(delivered.map((item) => item.project.project_id), ['project-a-0123456789']);

  // A later A signal is held by A's pacing bucket. Moving the same rollout to
  // B must not discard it; B gets its own first immediate bucket instead.
  clock.value += 1;
  await appendEvents(rollout, clock.value, [execEvent('npm test', projectDir), execEvent('git status', otherProjectDir)]);
  await watcher.poll();
  assert.deepEqual(delivered.map((item) => item.project.project_id), ['project-a-0123456789', 'project-b-0123456789']);

  clock.value += 45_000;
  await fs.utimes(rollout, new Date(clock.value), new Date(clock.value));
  await watcher.poll();
  assert.deepEqual(delivered.map((item) => item.project.project_id), [
    'project-a-0123456789',
    'project-b-0123456789',
    'project-a-0123456789',
  ]);

  const unregistered = path.join(path.dirname(projectDir), 'unregistered');
  await fs.mkdir(unregistered);
  clock.value += 45_000;
  await appendEvents(rollout, clock.value, [execEvent('node secret-work.js', unregistered)]);
  await watcher.poll();
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].state, 'suppressed');
  assert.equal(suppressed[0].reason, 'unregistered-project');
  assert.doesNotMatch(JSON.stringify(suppressed[0]), /secret-work|"root"/);
  watcher.stop();
});

test('Ambient Watch silently ignores newly appended signals while Learning Studio is paused', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const delivered = [];
  const suppressed = [];
  const canonicalProject = await fs.realpath(projectDir);
  const watcher = createAmbientWatcher({
    config: {
      ambientEnabled: true,
      ambientEmitIntervalMs: 1,
      cwd: projectDir,
      sessionsDir,
    },
    now: () => clock.value,
    resolveProject(cwd) {
      assert.equal(cwd, canonicalProject);
      return { reason: 'learning-paused', registered: false, root: canonicalProject };
    },
    onReport(report) {
      delivered.push(report);
    },
    onSuppressed(entry) {
      suppressed.push(entry);
    },
  });
  t.after(() => watcher.stop());

  const rollout = await createRollout(sessionsDir, clock.value);
  await watcher.poll();
  await appendEvents(rollout, clock.value, [
    execEvent('node build.js', projectDir),
    patchEvent({ '/private/project/src/scene.ts': 'ignored while paused' }),
  ]);
  await watcher.poll();

  assert.deepEqual(delivered, []);
  assert.deepEqual(suppressed, []);
  assert.equal(watcher.getDebugState().pendingSignals, 0);
});

test('Ambient Watch discards queued signals when Learning Studio pauses before their flush', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const delivered = [];
  const suppressed = [];
  const canonicalProject = await fs.realpath(projectDir);
  let paused = false;
  const watcher = createAmbientWatcher({
    config: {
      ambientEnabled: true,
      ambientEmitIntervalMs: 45_000,
      cwd: projectDir,
      sessionsDir,
    },
    now: () => clock.value,
    resolveProject(cwd) {
      assert.equal(cwd, canonicalProject);
      return paused
        ? { reason: 'learning-paused', registered: false, root: canonicalProject }
        : { project_id: 'project-a-0123456789', root: canonicalProject };
    },
    onReport(report) {
      delivered.push(report);
    },
    onSuppressed(entry) {
      suppressed.push(entry);
    },
  });
  t.after(() => watcher.stop());

  const rollout = await createRollout(sessionsDir, clock.value);
  await watcher.poll();

  await appendEvents(rollout, clock.value, [execEvent('node first.js', projectDir)]);
  await watcher.poll();
  assert.equal(delivered.length, 1, 'the first active signal delivers immediately');

  clock.value += 1;
  await appendEvents(rollout, clock.value, [execEvent('npm test', projectDir)]);
  await watcher.poll();
  assert.equal(delivered.length, 1, 'the second signal waits behind the per-session pace');
  assert.equal(watcher.getDebugState().pendingSignals, 1);

  paused = true;
  clock.value += 45_000;
  await fs.utimes(rollout, new Date(clock.value), new Date(clock.value));
  await watcher.poll();

  assert.equal(delivered.length, 1, 'a paused Studio never flushes pre-pause observations');
  assert.deepEqual(suppressed, []);
  assert.equal(watcher.getDebugState().pendingSignals, 0);
});

test('Ambient Watch snapshots startup EOFs but reads a rollout created before first discovery from byte zero', { timeout: 3_000 }, async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  await createRollout(sessionsDir, clock.value, {
    name: 'present-at-start',
    events: [execEvent('npm old-history.js', projectDir)],
  });
  let releaseDiscovery;
  let discoveryStarted;
  const discoveryGate = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  const discoveryStartedGate = new Promise((resolve) => {
    discoveryStarted = resolve;
  });
  let delayFirstDiscovery = true;
  const fsApi = {
    open: fs.open,
    realpath: fs.realpath,
    stat: fs.stat,
    async readdir(...args) {
      if (delayFirstDiscovery) {
        delayFirstDiscovery = false;
        discoveryStarted();
        await discoveryGate;
      }
      return fs.readdir(...args);
    },
  };
  let resolveReport;
  const firstReport = new Promise((resolve) => {
    resolveReport = resolve;
  });
  const timer = { unref() {} };
  const watcher = createAmbientWatcher({
    ...watcherOptions({ clock, projectDir, reports, sessionsDir }),
    fsApi,
    onReport(report) {
      reports.push(report);
      resolveReport();
    },
    timers: { clearInterval() {}, setInterval: () => timer },
  });
  t.after(() => watcher.stop());

  watcher.start();
  await discoveryStartedGate;
  await createRollout(sessionsDir, clock.value, {
    name: 'created-after-start',
    events: [execEvent('node build.js', projectDir)],
  });
  releaseDiscovery();
  await firstReport;

  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].stack_hints, ['node']);
});

test('Ambient Watch reads a rollout created after startup from byte zero and resets replaced files', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  const watcher = createAmbientWatcher(watcherOptions({
    clock,
    projectDir,
    reports,
    sessionsDir,
  }));

  // Establish the startup baseline before this rollout exists.
  await watcher.poll();
  const rollout = await createRollout(sessionsDir, clock.value, {
    name: 'new-file-race',
    events: [execEvent('node build.js', projectDir)],
  });
  await watcher.poll();
  assert.equal(reports.length, 1, 'the first event in a newly created file is not lost');
  assert.equal(reports[0].observed_kind, 'activity');

  // Replacing the same pathname creates a new session identity. Its contents
  // are read from zero rather than compared to the old file offset.
  clock.value += 2;
  const replacement = rollout + '.replacement';
  const paddedReplacement = execEvent('npm test', projectDir);
  paddedReplacement.payload.padding = 'x'.repeat(500);
  await fs.writeFile(replacement, JSON.stringify(paddedReplacement) + '\n');
  await fs.utimes(replacement, new Date(clock.value), new Date(clock.value));
  await fs.rename(replacement, rollout);
  await watcher.poll();
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1].stack_hints, ['npm']);

  // Truncation preserves an inode but creates a new byte stream. The next
  // event must likewise be read from zero rather than from the old offset.
  clock.value += 2;
  await fs.writeFile(rollout, JSON.stringify(execEvent('node truncated.js', projectDir)) + '\n');
  await fs.utimes(rollout, new Date(clock.value), new Date(clock.value));
  await watcher.poll();
  assert.equal(reports.length, 3);
  assert.deepEqual(reports[2].stack_hints, ['node']);
  watcher.stop();
});

test('Ambient Watch resumes an idle rollout from its identity cursor without replaying history', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  const watcher = createAmbientWatcher(watcherOptions({
    clock,
    projectDir,
    reports,
    sessionsDir,
    ambientEmitIntervalMs: 1,
  }));

  await watcher.poll();
  const rollout = await createRollout(sessionsDir, clock.value, {
    name: 'idle-cursor',
    events: [execEvent('node first-pass.js', projectDir)],
  });
  await watcher.poll();
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].stack_hints, ['node']);

  // The file falls out of the active discovery window. Its complete-line
  // cursor moves to a bounded identity-keyed tombstone instead of resetting
  // to byte zero on the next write.
  clock.value += ACTIVE_FILE_AGE_MS + 2;
  await watcher.poll();
  assert.deepEqual(watcher.getDebugState(), {
    cursorTombstones: 1,
    pendingSignals: 0,
    trackedFiles: 0,
  });

  await appendEvents(rollout, clock.value, [execEvent('npm test', projectDir)]);
  await watcher.poll();
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1].stack_hints, ['npm'], 'the old node event is not replayed');
  assert.equal(watcher.getDebugState().cursorTombstones, 0);
  watcher.stop();
});

test('Ambient Watch restores a tombstoned session route for inherited patch and MCP events', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const delivered = [];
  const canonicalProject = await fs.realpath(projectDir);
  const watcher = createAmbientWatcher({
    config: {
      ambientEnabled: true,
      ambientEmitIntervalMs: 1,
      cwd: projectDir,
      sessionsDir,
    },
    now: () => clock.value,
    resolveProject(cwd) {
      return cwd === canonicalProject
        ? { project_id: 'project-a-0123456789', root: canonicalProject }
        : { registered: false, root: cwd };
    },
    onReport(report, project) {
      delivered.push({ project, report });
    },
  });
  t.after(() => watcher.stop());

  await watcher.poll();
  const rollout = await createRollout(sessionsDir, clock.value, {
    name: 'tombstone-route',
    events: [execEvent('node first-pass.js', projectDir)],
  });
  await watcher.poll();
  assert.deepEqual(delivered.map(({ project }) => project.project_id), ['project-a-0123456789']);

  // Pruning removes the active file state but retains its cursor and the
  // session route learned from the exec event.
  clock.value += ACTIVE_FILE_AGE_MS + 2;
  await watcher.poll();
  assert.equal(watcher.getDebugState().cursorTombstones, 1);

  // Neither patch nor MCP events carry a workdir. They must inherit the
  // revalidated route after this dormant rollout resumes, without replaying
  // the earlier node event.
  await appendEvents(rollout, clock.value, [
    patchEvent({ '/private/project/src/resumed.css': 'not displayed' }),
    mcpEvent('github', 'search_code'),
  ]);
  await watcher.poll();

  assert.deepEqual(delivered.map(({ project }) => project.project_id), [
    'project-a-0123456789',
    'project-a-0123456789',
  ]);
  assert.deepEqual(delivered[1].report.stack_hints, ['.css', 'github']);
  assert.equal(delivered[1].report.observed_kind, 'change');
  assert.equal(watcher.getDebugState().cursorTombstones, 0);
});

test('Ambient Watch suppresses a resumed tombstoned route that is no longer carried', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const delivered = [];
  const suppressed = [];
  const canonicalProject = await fs.realpath(projectDir);
  let carried = true;
  const watcher = createAmbientWatcher({
    config: {
      ambientEnabled: true,
      ambientEmitIntervalMs: 1,
      cwd: projectDir,
      sessionsDir,
    },
    now: () => clock.value,
    resolveProject(cwd) {
      if (cwd !== canonicalProject) {
        return { registered: false, root: cwd };
      }
      return carried
        ? { project_id: 'project-a-0123456789', root: canonicalProject }
        : { registered: false, root: canonicalProject };
    },
    onReport(report, project) {
      delivered.push({ project, report });
    },
    onSuppressed(entry) {
      suppressed.push(entry);
    },
  });
  t.after(() => watcher.stop());

  await watcher.poll();
  const rollout = await createRollout(sessionsDir, clock.value, {
    name: 'tombstone-unregistered',
    events: [execEvent('node first-pass.js', projectDir)],
  });
  await watcher.poll();
  assert.equal(delivered.length, 1);

  clock.value += ACTIVE_FILE_AGE_MS + 2;
  await watcher.poll();
  carried = false;

  await appendEvents(rollout, clock.value, [
    patchEvent({ '/private/project/src/unregistered.css': 'not displayed' }),
  ]);
  await watcher.poll();

  assert.equal(delivered.length, 1, 'a stale route cannot deliver into its old project');
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].state, 'suppressed');
  assert.equal(suppressed[0].reason, 'unregistered-project');
  assert.deepEqual(suppressed[0].stack_hints, ['.css']);
});

test('Ambient Watch bounds cursor tombstones, evicts the oldest, and keeps partial records live', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  const watcher = createAmbientWatcher(watcherOptions({
    clock,
    projectDir,
    reports,
    sessionsDir,
    ambientEmitIntervalMs: 1,
    ambientMaxCursorTombstones: 2,
  }));

  await watcher.poll();
  const first = await createRollout(sessionsDir, clock.value, {
    name: 'tombstone-a',
    events: [execEvent('node first.js', projectDir)],
  });
  await watcher.poll();
  clock.value += 2;
  const second = await createRollout(sessionsDir, clock.value, {
    name: 'tombstone-b',
    events: [execEvent('npm second.js', projectDir)],
  });
  await watcher.poll();
  clock.value += 2;
  const third = await createRollout(sessionsDir, clock.value, {
    name: 'tombstone-c',
    events: [execEvent('git third.js', projectDir)],
  });
  await watcher.poll();
  assert.equal(reports.length, 3);

  clock.value += ACTIVE_FILE_AGE_MS + 2;
  await watcher.poll();
  assert.deepEqual(watcher.getDebugState(), {
    cursorTombstones: 2,
    pendingSignals: 0,
    trackedFiles: 0,
  });

  // The latest identities resume at their cursor. The oldest identity was
  // evicted, so attaching it is intentionally the same as a new file.
  await appendEvents(third, clock.value, [execEvent('git resumed.js', projectDir)]);
  await watcher.poll();
  assert.deepEqual(reports.at(-1).stack_hints, ['git']);

  clock.value += 2;
  await appendEvents(first, clock.value, [execEvent('npm resumed.js', projectDir)]);
  await watcher.poll();
  assert.deepEqual(reports.at(-1).stack_hints, ['node', 'npm']);

  clock.value += 2;
  await appendEvents(second, clock.value, [execEvent('git resumed.js', projectDir)]);
  await watcher.poll();
  assert.deepEqual(reports.at(-1).stack_hints, ['git'], 'the retained middle identity resumes without replay');
  watcher.stop();

  // A retained partial JSONL record cannot safely be represented by a byte
  // cursor alone. It therefore remains live across the idle window and is
  // completed exactly once when its newline arrives.
  const partialReports = [];
  const partialSessionsDir = path.join(path.dirname(sessionsDir), 'partial-tombstone-sessions');
  const partialWatcher = createAmbientWatcher(watcherOptions({
    clock,
    projectDir,
    reports: partialReports,
    sessionsDir: partialSessionsDir,
    ambientEmitIntervalMs: 1,
  }));
  await partialWatcher.poll();
  const serialized = JSON.stringify(execEvent('node completed-after-idle.js', projectDir));
  const partial = await createRollout(partialSessionsDir, clock.value, {
    name: 'partial-tombstone',
    raw: serialized.slice(0, 24),
  });
  await partialWatcher.poll();
  assert.equal(partialWatcher.getDebugState().trackedFiles, 1);

  clock.value += ACTIVE_FILE_AGE_MS + 2;
  await partialWatcher.poll();
  assert.deepEqual(partialWatcher.getDebugState(), {
    cursorTombstones: 0,
    pendingSignals: 0,
    trackedFiles: 1,
  });

  await fs.appendFile(partial, serialized.slice(24) + '\n');
  await fs.utimes(partial, new Date(clock.value), new Date(clock.value));
  await partialWatcher.poll();
  assert.equal(partialReports.length, 1);
  assert.deepEqual(partialReports[0].stack_hints, ['node']);
  partialWatcher.stop();
});

test('Ambient Watch bounds tracked files, polling bytes, lines, partial data, and pending signals', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  const logs = [];
  const watcher = createAmbientWatcher({
    ...watcherOptions({
      clock,
      projectDir,
      reports,
      sessionsDir,
      ambientEmitIntervalMs: 999_999,
      ambientMaxBytesPerPoll: 256,
      ambientMaxJsonlLineBytes: 512,
      ambientMaxPartialLineBytes: 128,
      ambientMaxPendingSignals: 1,
      ambientMaxTrackedFiles: 2,
    }),
    log: (...parts) => logs.push(parts.join(' ')),
  });
  await watcher.poll();

  for (let index = 0; index < 5; index += 1) {
    await createRollout(sessionsDir, clock.value, {
      name: 'concurrent-' + index,
      events: [execEvent('node build.js', projectDir)],
    });
  }
  await watcher.poll();
  assert.equal(reports.length, 1, 'the small byte budget permits only one normal line per poll');
  assert.equal(watcher.getDebugState().trackedFiles <= 2, true);
  assert.equal(logs.some((entry) => entry.includes('tracked-file limit')), true);
  assert.equal(logs.some((entry) => entry.includes('per-poll byte limit')), true);
  watcher.stop();

  // A huge complete line is dropped, and an oversized partial line is dropped
  // until its terminating newline. Neither can be retained indefinitely.
  const lineSessionsDir = path.join(path.dirname(sessionsDir), 'line-limits-sessions');
  const lineReports = [];
  const lineLogs = [];
  const lineWatcher = createAmbientWatcher({
    ...watcherOptions({
      clock,
      projectDir,
      reports: lineReports,
      sessionsDir: lineSessionsDir,
      ambientEmitIntervalMs: 999_999,
      ambientMaxBytesPerPoll: 4_096,
      ambientMaxJsonlLineBytes: 512,
      ambientMaxPartialLineBytes: 128,
      ambientMaxPendingSignals: 1,
      ambientMaxTrackedFiles: 2,
    }),
    log: (...parts) => lineLogs.push(parts.join(' ')),
  });
  await lineWatcher.poll();
  clock.value += 2;
  const oversized = await createRollout(lineSessionsDir, clock.value, {
    name: 'oversized',
    raw: JSON.stringify({ ignored: 'x'.repeat(2_000) }) + '\n',
  });
  await lineWatcher.poll();
  await fs.appendFile(oversized, 'z'.repeat(512));
  await fs.utimes(oversized, new Date(clock.value), new Date(clock.value));
  await lineWatcher.poll();
  await fs.appendFile(oversized, '\n' + JSON.stringify(execEvent('node after-limit.js', projectDir)) + '\n');
  await fs.utimes(oversized, new Date(clock.value), new Date(clock.value));
  await lineWatcher.poll();
  assert.equal(lineLogs.some((entry) => entry.includes('oversized JSONL line')), true);
  assert.equal(lineLogs.some((entry) => entry.includes('oversized partial JSONL line')), true);

  // The first card emitted immediately; later distinct signals are pending
  // behind the long interval and cannot exceed one retained item.
  assert.equal(lineReports.length, 1);
  clock.value += 2;
  await appendEvents(oversized, clock.value, [
    patchEvent({ '/private/a.ts': 'nope' }),
    mcpEvent('github', 'search_code'),
  ]);
  await lineWatcher.poll();
  assert.equal(lineWatcher.getDebugState().pendingSignals <= 1, true);
  assert.equal(lineLogs.some((entry) => entry.includes('pending-signal limit')), true);
  lineWatcher.stop();
});

test('Ambient Watch caps pending signals across concurrent rollout sessions', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  const logs = [];
  const watcher = createAmbientWatcher({
    ...watcherOptions({
      clock,
      projectDir,
      reports,
      sessionsDir,
      ambientEmitIntervalMs: 999_999,
      ambientMaxPendingSignals: 1,
      ambientMaxTrackedFiles: 2,
    }),
    log: (...parts) => logs.push(parts.join(' ')),
  });
  await watcher.poll();
  const first = await createRollout(sessionsDir, clock.value, {
    name: 'global-a',
    events: [execEvent('node first.js', projectDir)],
  });
  await watcher.poll();
  assert.equal(reports.length, 1);

  const second = await createRollout(sessionsDir, clock.value, {
    name: 'global-b',
    events: [execEvent('npm test', projectDir)],
  });
  await watcher.poll();
  assert.equal(reports.length, 2);

  clock.value += 1;
  await appendEvents(first, clock.value, [execEvent('node later.js', projectDir)]);
  await appendEvents(second, clock.value, [execEvent('npm run build', projectDir)]);
  await watcher.poll();

  assert.equal(watcher.getDebugState().pendingSignals, 1);
  assert.equal(logs.some((entry) => entry.includes('pending-signal limit')), true);
  watcher.stop();
});

test('Ambient Watch permanently excludes rollout sessions marked for the isolated generator', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  const reports = [];
  const watcher = createAmbientWatcher(watcherOptions({ clock, projectDir, reports, sessionsDir }));
  await watcher.poll();
  const rollout = await createRollout(sessionsDir, clock.value, {
    name: 'generator-marker',
    events: [
      ignoredExecEvent('node generator.js', projectDir),
      execEvent('node should-stay-excluded.js', projectDir),
      patchEvent({ '/private/also-excluded.ts': 'nope' }),
    ],
  });
  await watcher.poll();
  assert.equal(reports.length, 0);

  clock.value += 2;
  await appendEvents(rollout, clock.value, [execEvent('npm test', projectDir)]);
  await watcher.poll();
  assert.equal(reports.length, 0);
  watcher.stop();
});

test('Ambient Watch refuses record and replay modes even when an environment opts in', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const clock = { value: Date.now() };
  for (const mode of ['record', 'replay']) {
    let scheduled = 0;
    const watcher = createAmbientWatcher({
      ...watcherOptions({ clock, projectDir, reports: [], sessionsDir, mode }),
      timers: {
        clearInterval() {},
        setInterval() {
          scheduled += 1;
          return { unref() {} };
        },
      },
    });
    watcher.start();
    await watcher.poll();
    assert.equal(scheduled, 0);
    assert.deepEqual(watcher.getDebugState(), { cursorTombstones: 0, pendingSignals: 0, trackedFiles: 0 });
    watcher.stop();
  }
});

test('Ambient Watch contains parse, delivery, and timer failures without retaining a polling timer after stop', async (t) => {
  const { projectDir, sessionsDir } = await setup(t);
  const logs = [];
  const clock = { value: Date.now() };
  const rollout = await createRollout(sessionsDir, clock.value);
  const interval = { unref() {} };
  let scheduled = 0;
  let cleared = 0;
  const watcher = createAmbientWatcher({
    config: { ambientEnabled: true, ambientEmitIntervalMs: 1, cwd: projectDir, sessionsDir },
    now: () => clock.value,
    onReport() {
      throw new Error('delivery failure');
    },
    log: (...args) => logs.push(args.join(' ')),
    timers: {
      setInterval() {
        scheduled += 1;
        return interval;
      },
      clearInterval(value) {
        assert.equal(value, interval);
        cleared += 1;
      },
    },
  });

  await watcher.poll();
  await fs.appendFile(rollout, '{not valid json}\n' + JSON.stringify(execEvent('node build.js', projectDir)) + '\n');
  await fs.utimes(rollout, new Date(clock.value), new Date(clock.value));
  await watcher.poll();
  assert.equal(logs.some((entry) => entry.includes('ambient watcher could not deliver a report')), true);

  watcher.start();
  watcher.stop();
  assert.equal(scheduled, 1);
  assert.equal(cleared, 1);
  clock.value += 1_000;
  await appendEvents(rollout, clock.value, [execEvent('node after-stop.js', projectDir)]);
  await watcher.poll();
  assert.equal(cleared, 1);
});
