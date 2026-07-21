'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBroker, createFairReportScheduler } = require('../lib/broker');
const { selectableLeaves } = require('../lib/concepts');
const { namespaceConceptId } = require('../lib/project-concepts');
const { resolveProjectIdentity } = require('../lib/project-identity');
const { strengthFor } = require('../lib/mastery');

function report(task) {
  return { task, what_i_did: `Completed ${task}.`, stack_hints: ['Node.js'] };
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-broker-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function studioConfig(root, { ambientEnabled = false, cwd = root, globalReportQueueCap = 5 } = {}) {
  const profileDir = path.join(root, 'profile');
  const stateDir = path.join(cwd, '.osmosis');
  return {
    ambientEnabled,
    cardPacingMs: 1,
    codexHome: path.join(root, 'codex'),
    cwd,
    globalReportQueueCap,
    host: '127.0.0.1',
    mode: 'live',
    port: 4321,
    profileDir,
    profilePath: path.join(profileDir, 'profile.json'),
    provider: 'none',
    replayPath: path.join(stateDir, 'replay.json'),
    settingsPath: path.join(profileDir, 'settings.json'),
    stateDir,
    templateDelayMs: 60_000,
    treePath: path.join(stateDir, 'tree.json'),
    unansweredCardCap: 5,
  };
}

async function waitFor(check, message, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

async function carryProject(broker, projectId) {
  await broker.activateProject(projectId, {
    capture_mode: 'agent-reports-only',
    carry: true,
    lesson_locale: 'en',
  });
}

test('the broker keeps project channels lazy, dual-emits snapshots, and routes registered relay work by token', async (t) => {
  const root = await temporaryDirectory(t);
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const projectC = path.join(root, 'project-c');
  await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB), fs.mkdir(projectC)]);
  const events = [];
  const config = {
    ambientEnabled: false,
    cardPacingMs: 1,
    codexHome: path.join(root, 'codex'),
    cwd: projectA,
    globalReportQueueCap: 5,
    host: '127.0.0.1',
    mode: 'live',
    port: 4321,
    profileDir: path.join(root, 'profile'),
    profilePath: path.join(root, 'profile', 'profile.json'),
    provider: 'none',
    replayPath: path.join(projectA, '.osmosis', 'replay.json'),
    stateDir: path.join(projectA, '.osmosis'),
    templateDelayMs: 60_000,
    treePath: path.join(projectA, '.osmosis', 'tree.json'),
    unansweredCardCap: 5,
  };
  const hub = { broadcast(type, payload) { events.push({ type, payload }); } };
  const broker = createBroker({ config, hub });
  await broker.startOwner();
  const defaultId = broker.defaultProjectId;
  assert.ok(defaultId);

  await broker.activateProject(defaultId, {
    capture_mode: 'agent-reports-only',
    carry: true,
    lesson_locale: 'en',
  });

  const pendingB = await broker.register(projectB);
  await broker.activateProject(pendingB.project_id, {
    capture_mode: 'agent-reports-only',
    carry: true,
    lesson_locale: 'en',
  });
  const registration = await broker.register(projectB);
  const pendingC = await broker.register(projectC);
  await broker.activateProject(pendingC.project_id, {
    capture_mode: 'agent-reports-only',
    carry: true,
    lesson_locale: 'en',
  });
  const quietRegistration = await broker.register(projectC);
  assert.equal(typeof registration.token, 'string');
  assert.equal(broker.registry.getHydratedProject(registration.project_id), null, 'registration stores only a summary');
  assert.equal(broker.registry.getHydratedProject(quietRegistration.project_id), null, 'an inactive tab remains summary-only');
  assert.equal(await broker.acceptRelayReport(registration.project_id, 'bad-token', report('not accepted')), false);
  assert.equal(await broker.acceptRelayReport(registration.project_id, registration.token, report('B milestone')), true);
  await broker.whenIdle();

  const bChannel = broker.registry.getHydratedProject(registration.project_id);
  assert.ok(bChannel);
  assert.equal(bChannel.state.cards.length, 1);
  const defaultChannel = await broker.ensureChannel(defaultId);
  assert.equal(defaultChannel.state.cards.length, 0);
  assert.equal(bChannel.state.strengths, defaultChannel.state.strengths, 'hydrated channels alias one shared profile object');
  assert.equal(events.some((event) => event.type === 'project-card' && event.payload.project_id === registration.project_id), true);
  assert.equal(events.some((event) => event.type === 'card' && event.payload.source?.task === 'B milestone'), false, 'background cards stay v2-only');

  const snapshots = await broker.initialEvents();
  assert.deepEqual(snapshots.map((event) => event.type), ['snapshot', 'snapshot-v2']);
  assert.equal(snapshots[0].payload.cards.length, 0);
  assert.equal(snapshots[1].payload.channels[defaultId].project_id, defaultId);
  assert.equal(quietRegistration.project_id in snapshots[1].payload.channels, false, 'v2 sends a quiet channel as a summary, not a hydrated payload');
  assert.equal(snapshots[1].payload.projects.some((project) => project.project_id === quietRegistration.project_id), true);
  assert.equal((await broker.projectSnapshot(registration.project_id)).project_id, registration.project_id);
  await broker.whenIdle();
  broker.close();
});

test('the broker scheduler gives a newly active project a fair slot under its global ceiling', async () => {
  const scheduler = createFairReportScheduler({ maxPending: 3 });
  const ran = [];
  let releaseA;
  const holdA = new Promise((resolve) => { releaseA = resolve; });
  assert.equal(scheduler.enqueue('a', { run: async () => { ran.push('a1'); await holdA; } }), true);
  assert.equal(scheduler.enqueue('a', { run: async () => { ran.push('a2'); } }), true);
  let dropped = 0;
  assert.equal(scheduler.enqueue('a', { onDropped: () => { dropped += 1; }, run: async () => { ran.push('a3'); } }), true);
  assert.equal(scheduler.enqueue('b', { run: async () => { ran.push('b1'); } }), true);
  releaseA();
  await scheduler.whenIdle();
  assert.equal(dropped, 1);
  assert.equal(ran.includes('b1'), true);
  assert.equal(ran.includes('a3'), false);
});

test('provider concepts are project-scoped while old unsalted mastery remains readable', () => {
  const scoped = namespaceConceptId('harbour-a-1234567890', 'animation-loop');
  assert.equal(scoped, 'harbour-a-1234567890:animation-loop');
  assert.equal(namespaceConceptId('harbour-a-1234567890', 'feedback-loop'), 'feedback-loop');
  assert.equal(strengthFor({ 'animation-loop': { strength: 2 } }, scoped), 2);
  assert.equal(strengthFor({ [scoped]: { strength: 1 }, 'animation-loop': { strength: 2 } }, scoped), 1);
});

test('channel hydration namespaces a legacy tree while its unsalted mastery record remains readable', async (t) => {
  const root = await temporaryDirectory(t);
  const project = path.join(root, 'legacy-tree');
  const stateDir = path.join(project, '.osmosis');
  const profileDir = path.join(root, 'profile');
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, 'tree.json'),
    `${JSON.stringify({
      meta: { surfaced_concept_ids: ['animation-loop', 'feedback-loop'] },
      nodes: [
        { concept_id: 'project-map', concept_name: 'Project map', parent_id: null },
        { concept_id: 'http', concept_name: 'HTTP', parent_id: 'project-map' },
        { concept_id: 'animation-loop', concept_name: 'Animation loop', parent_id: 'project-map' },
        { concept_id: 'feedback-loop', concept_name: 'The feedback loop', parent_id: 'project-map' },
      ],
    }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(profileDir, 'profile.json'),
    `${JSON.stringify({ http: { name: 'HTTP', strength: 2, seen: 1, correct: 1 } }, null, 2)}\n`,
    'utf8',
  );

  const config = {
    cardPacingMs: 1,
    codexCommand: path.join(root, 'not-called-codex'),
    codexHome: path.join(root, 'codex'),
    codexTimeoutMs: 1_000,
    cwd: project,
    globalReportQueueCap: 5,
    host: '127.0.0.1',
    mode: 'live',
    port: 4321,
    profileDir,
    profilePath: path.join(profileDir, 'profile.json'),
    provider: 'codex',
    replayPath: path.join(stateDir, 'replay.json'),
    stateDir,
    templateDelayMs: 1,
    treePath: path.join(stateDir, 'tree.json'),
    unansweredCardCap: 5,
  };
  const broker = createBroker({ config, hub: { broadcast() {} } });
  await broker.initialize();
  const projectId = broker.defaultProjectId;
  const channel = await broker.ensureChannel(projectId);
  const scoped = (conceptId) => namespaceConceptId(projectId, conceptId);

  assert.deepEqual(channel.state.tree.nodes.map((node) => node.concept_id), [
    scoped('project-map'),
    scoped('http'),
    scoped('animation-loop'),
    'feedback-loop',
  ]);
  assert.deepEqual(channel.state.tree.nodes.map((node) => node.parent_id), [
    null,
    scoped('project-map'),
    scoped('project-map'),
    scoped('project-map'),
  ]);
  assert.equal(channel.state.tree.meta.concept_namespace, projectId);
  assert.deepEqual(channel.state.tree.meta.surfaced_concept_ids, [scoped('animation-loop'), 'feedback-loop']);
  assert.equal(strengthFor(channel.state.strengths, scoped('http')), 2, 'old profile keys are a read-only compatibility path');
  assert.equal(selectableLeaves(channel.state.tree, channel.state.strengths, []).some((node) => node.concept_id === scoped('http')), false);

  // No Codex process is needed to prepare a card. The map proves a subsequent
  // provider result using its local id will be written with the project salt.
  const curriculum = await channel.curriculumService.prepare(report('legacy tree migration'));
  assert.equal(curriculum.conceptIdMap.get('animation-loop'), scoped('animation-loop'));
  assert.equal(curriculum.conceptIdMap.get('feedback-loop'), 'feedback-loop');

  channel.provider.generateCard = async () => ({
    concept_id: 'animation-loop',
    concept_name: 'Animation loop',
    lesson: 'The loop redraws the scene repeatedly so movement can appear smooth.',
    question: 'What does the animation loop keep doing?',
    options: ['Redraw the scene', 'Delete old files', 'Send email'],
    correct_index: 0,
    explanation: 'Each redraw is the next frame.',
  });
  assert.equal(await broker.acceptLocalReport(report('first scoped provider card'), projectId), true);
  await broker.whenIdle();
  assert.equal(channel.state.cards.at(-1).concept_id, scoped('animation-loop'));

  const persisted = JSON.parse(await fs.readFile(path.join(stateDir, 'tree.json'), 'utf8'));
  assert.deepEqual(persisted, channel.state.tree, 'the migration survives restart before any provider call');
  broker.close();
});

test('a running broker periodically archives inactive background channels with a fake clock', async (t) => {
  const root = await temporaryDirectory(t);
  const projectA = path.join(root, 'active-project');
  const projectB = path.join(root, 'quiet-project');
  await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB)]);
  let milliseconds = Date.parse('2026-07-19T00:00:00.000Z');
  let scheduledSweep = null;
  let intervalHandle = null;
  let timerWasUnrefed = false;
  let clearedHandle = null;
  const events = [];
  const profileDir = path.join(root, 'profile');
  const config = {
    cardPacingMs: 1,
    codexHome: path.join(root, 'codex'),
    cwd: projectA,
    globalReportQueueCap: 5,
    host: '127.0.0.1',
    mode: 'live',
    port: 4321,
    profileDir,
    profilePath: path.join(profileDir, 'profile.json'),
    projectArchiveAfterMs: 1_000,
    projectArchiveSweepMs: 60,
    provider: 'none',
    replayPath: path.join(projectA, '.osmosis', 'replay.json'),
    stateDir: path.join(projectA, '.osmosis'),
    templateDelayMs: 60_000,
    treePath: path.join(projectA, '.osmosis', 'tree.json'),
    unansweredCardCap: 5,
  };
  const broker = createBroker({
    archiveSweepMs: config.projectArchiveSweepMs,
    clearIntervalFn(handle) {
      clearedHandle = handle;
    },
    config,
    hub: { broadcast(type, payload) { events.push({ payload, type }); } },
    now: () => new Date(milliseconds).toISOString(),
    setIntervalFn(callback, delay) {
      assert.equal(delay, config.projectArchiveSweepMs);
      scheduledSweep = callback;
      intervalHandle = { unref() { timerWasUnrefed = true; } };
      return intervalHandle;
    },
  });

  await broker.initialize();
  await broker.activateProject(broker.defaultProjectId, {
    capture_mode: 'agent-reports-only',
    carry: true,
    lesson_locale: 'en',
  });
  const pending = await broker.register(projectB);
  await broker.activateProject(pending.project_id, {
    capture_mode: 'agent-reports-only',
    carry: true,
    lesson_locale: 'en',
  });
  const registration = await broker.register(projectB);
  assert.equal(broker.registry.getProject(registration.project_id).archived, false);
  assert.equal(typeof scheduledSweep, 'function', 'initialization schedules a continuous archival sweep');
  assert.equal(timerWasUnrefed, true, 'the wall lifecycle timer cannot hold the process open');

  milliseconds += 1_001;
  await scheduledSweep();
  assert.equal(broker.registry.getProject(registration.project_id).archived, true);
  assert.equal(broker.registry.getProject(broker.defaultProjectId).archived, false, 'the current project stays visible');
  assert.equal(
    events.some((event) => event.type === 'projects' && event.payload.projects.some((project) => project.project_id === registration.project_id && project.archived)),
    true,
    'the wall receives a fresh tab summary after the periodic sweep',
  );

  broker.close();
  assert.equal(clearedHandle, intervalHandle, 'shutdown clears the archival timer');
});

test('a durable Studio candidate resumes after the broker hydrates it on restart', async (t) => {
  const root = await temporaryDirectory(t);
  const config = studioConfig(root);
  const brokerBeforeRestart = createBroker({ config, hub: { broadcast() {} } });
  t.after(() => brokerBeforeRestart.close());

  await brokerBeforeRestart.initialize();
  const projectId = brokerBeforeRestart.defaultProjectId;
  await carryProject(brokerBeforeRestart, projectId);
  const interruptedChannel = await brokerBeforeRestart.ensureChannel(projectId);
  const neverSettles = new Promise(() => {});
  let providerStarted = false;
  interruptedChannel.provider.generateCard = async () => {
    providerStarted = true;
    return neverSettles;
  };

  const interruptedReport = { ...report('Restart-safe Studio candidate'), report_id: 'restart-safe-candidate' };
  assert.equal(await brokerBeforeRestart.acceptLocalReport(interruptedReport, projectId), true);
  await waitFor(() => providerStarted, 'the first provider request to begin', 2_000);

  const cardsPath = path.join(root, '.osmosis', 'cards.json');
  const durableCandidate = await waitFor(async () => {
    try {
      const document = JSON.parse(await fs.readFile(cardsPath, 'utf8'));
      return document.studio?.candidates?.some((candidate) => candidate.report?.report_id === interruptedReport.report_id)
        ? document
        : null;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }, 'the interrupted Studio signal to be persisted');
  assert.equal(durableCandidate.studio.generation.in_flight, false, 'the durable document never restores a stale provider request');
  assert.equal(interruptedChannel.state.studio.generation.in_flight, true, 'the first process really was interrupted mid-generation');

  brokerBeforeRestart.close();
  const brokerAfterRestart = createBroker({ config: studioConfig(root), hub: { broadcast() {} } });
  t.after(() => brokerAfterRestart.close());
  await brokerAfterRestart.initialize();
  const passivelyHydratedChannel = await brokerAfterRestart.ensureChannel(projectId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passivelyHydratedChannel.state.cards.length, 0, 'a port loser can hydrate without running a provider');
  assert.equal(passivelyHydratedChannel.state.studio.candidates.length, 1, 'the durable candidate stays intact until exclusive ownership');
  await brokerAfterRestart.startOwner();
  // Durable candidates resume only after the exclusive owner lifecycle, not
  // merely because a passive broker hydrated a project state file.
  await new Promise((resolve) => setImmediate(resolve));
  const resumedChannel = await brokerAfterRestart.ensureChannel(projectId);
  await waitFor(
    () => resumedChannel.state.cards.length === 1 && resumedChannel.studio.currentCard()?.source?.report_id === interruptedReport.report_id,
    'the restored candidate to become the Studio Now question',
  );
  await brokerAfterRestart.whenIdle();
  assert.equal(resumedChannel.state.studio.candidates.length, 0);
  assert.equal(resumedChannel.studio.status().generation_in_flight, false);
});

test('pre-Studio background registry summaries migrate to Carry instead of activation-pending', async (t) => {
  const root = await temporaryDirectory(t);
  const projectA = path.join(root, 'new-studio-project');
  const projectB = path.join(root, 'legacy-background-project');
  const profileDir = path.join(root, 'profile');
  await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB), fs.mkdir(profileDir, { recursive: true })]);
  const identityB = await resolveProjectIdentity(projectB);
  await fs.writeFile(
    path.join(profileDir, 'projects.json'),
    `${JSON.stringify({
      version: 1,
      projects: [{
        archived: false,
        last_activity_at: '2026-07-19T00:00:00.000Z',
        name: 'Legacy background project',
        project_id: identityB.project_id,
        root: identityB.root,
        unanswered_count: 2,
      }],
    }, null, 2)}\n`,
    'utf8',
  );

  const broker = createBroker({ config: studioConfig(root, { cwd: projectA }), hub: { broadcast() {} } });
  t.after(() => broker.close());
  await broker.initialize();

  const activation = broker.activation(identityB.project_id);
  assert.equal(activation.state, 'carried');
  assert.equal(activation.carry, true);
  assert.equal(activation.pending_report_count, 0);
  assert.equal(activation.capture_mode, 'agent-reports-only');
  const settings = await broker.getSettings();
  assert.equal(settings.projects[identityB.project_id].carry, true, 'the migration is durable in user-facing settings');
  assert.equal(
    (await broker.initialEvents()).at(-1).payload.activations.find((item) => item.project_id === identityB.project_id).state,
    'carried',
    'the first v2 snapshot cannot mislabel pre-existing background state as undecided',
  );

  const registration = await broker.register(projectB);
  assert.equal(registration.project_id, identityB.project_id);
  assert.equal(typeof registration.token, 'string');
  assert.equal(Object.hasOwn(registration, 'activation_pending'), false, 'the relay takes the normal carried-project handshake');
});

test('an Ambient-enabled owner preserves legacy carried capture and respects a later explicit reports-only choice', async (t) => {
  const root = await temporaryDirectory(t);
  const projectA = path.join(root, 'new-project');
  const projectB = path.join(root, 'legacy-ambient-project');
  const profileDir = path.join(root, 'profile');
  await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB), fs.mkdir(profileDir, { recursive: true })]);
  const identityB = await resolveProjectIdentity(projectB);
  await fs.writeFile(
    path.join(profileDir, 'projects.json'),
    `${JSON.stringify({
      version: 1,
      projects: [{
        archived: false,
        last_activity_at: '2026-07-19T00:00:00.000Z',
        name: 'Legacy ambient project',
        project_id: identityB.project_id,
        root: identityB.root,
        unanswered_count: 0,
      }],
    }, null, 2)}\n`,
    'utf8',
  );
  // This is the bad state created by the old migration: the learner was
  // already carrying the project while this machine had Ambient enabled, but
  // capture was silently forced to reports-only.
  await fs.writeFile(
    path.join(profileDir, 'settings.json'),
    `${JSON.stringify({
      global_learning: 'on',
      lesson_locale: 'en',
      pending_activation: {},
      projects: {
        [identityB.project_id]: {
          auto_advance: false,
          capture_mode: 'agent-reports-only',
          carry: true,
        },
      },
      version: 1,
    }, null, 2)}\n`,
    'utf8',
  );

  const config = studioConfig(root, { ambientEnabled: true, cwd: projectA });
  const firstOwner = createBroker({ config, hub: { broadcast() {} } });
  t.after(() => firstOwner.close());
  await firstOwner.startOwner();

  const expectedNotice = [{
    code: 'ambient-watch-preserved',
    message: 'Ambient Watch preserved — review settings',
    project_id: identityB.project_id,
  }];
  const firstSettings = await firstOwner.getSettings();
  assert.equal(firstSettings.projects[identityB.project_id].capture_mode, 'experimental-ambient');
  assert.deepEqual(firstSettings.notices, expectedNotice);
  assert.equal(Object.hasOwn(firstSettings, 'migration'), false, 'migration bookkeeping stays private to disk');
  const firstV2 = (await firstOwner.initialEvents()).at(-1).payload;
  assert.deepEqual(firstV2.notices, expectedNotice, 'the first Studio snapshot carries the non-blocking notice');
  assert.equal(firstV2.settings.projects[identityB.project_id].capture_mode, 'experimental-ambient');
  assert.deepEqual(await firstOwner.resolveAmbientProject(projectB), {
    project_id: identityB.project_id,
    root: identityB.root,
  }, 'the preserved project is available to the experimental ambient route');

  const migratedOnDisk = JSON.parse(await fs.readFile(path.join(profileDir, 'settings.json'), 'utf8'));
  assert.equal(migratedOnDisk.projects[identityB.project_id].capture_mode, 'experimental-ambient');
  assert.equal(migratedOnDisk.migration.ambient_capture_reviewed[identityB.project_id], true);
  firstOwner.close();

  const restartedOwner = createBroker({ config: studioConfig(root, { ambientEnabled: true, cwd: projectA }), hub: { broadcast() {} } });
  t.after(() => restartedOwner.close());
  await restartedOwner.startOwner();
  const restartedSettings = await restartedOwner.getSettings();
  assert.equal(restartedSettings.projects[identityB.project_id].capture_mode, 'experimental-ambient', 'restart is idempotent');
  assert.deepEqual(restartedSettings.notices, [], 'the preservation notice is emitted only for the migration owner epoch');

  // A later settings action is an explicit learner decision, not another
  // legacy entry. A later Ambient-enabled owner must keep it untouched.
  await restartedOwner.activateProject(identityB.project_id, {
    capture_mode: 'agent-reports-only',
    carry: true,
    lesson_locale: 'en',
  });
  assert.equal((await restartedOwner.getSettings()).projects[identityB.project_id].capture_mode, 'agent-reports-only');
  restartedOwner.close();

  const explicitChoiceOwner = createBroker({ config: studioConfig(root, { ambientEnabled: true, cwd: projectA }), hub: { broadcast() {} } });
  t.after(() => explicitChoiceOwner.close());
  await explicitChoiceOwner.startOwner();
  assert.equal((await explicitChoiceOwner.getSettings()).projects[identityB.project_id].capture_mode, 'agent-reports-only');
  assert.deepEqual(await explicitChoiceOwner.resolveAmbientProject(projectB), {
    reason: 'ambient-not-enabled-for-project',
    registered: false,
    root: identityB.root,
  }, 'an explicit reports-only choice remains outside Ambient Watch');
});

test('a Studio candidate rejected at the global ceiling resumes fairly when its slot frees', async (t) => {
  const root = await temporaryDirectory(t);
  const projectA = path.join(root, 'slot-holder-project');
  const projectB = path.join(root, 'waiting-project');
  await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB)]);
  const broker = createBroker({
    config: studioConfig(root, { cwd: projectA, globalReportQueueCap: 1 }),
    hub: { broadcast() {} },
  });
  let releaseHolder;
  t.after(() => {
    releaseHolder?.();
    broker.close();
  });

  await broker.startOwner();
  const projectAId = broker.defaultProjectId;
  await carryProject(broker, projectAId);
  const pendingB = await broker.register(projectB);
  await carryProject(broker, pendingB.project_id);
  const projectBId = pendingB.project_id;
  const holderChannel = await broker.ensureChannel(projectAId);
  const waitingChannel = await broker.ensureChannel(projectBId);
  const templateCard = holderChannel.provider.generateCard.bind(holderChannel.provider);
  let beginHolder;
  const holderStarted = new Promise((resolve) => { beginHolder = resolve; });
  const holderGate = new Promise((resolve) => { releaseHolder = resolve; });
  holderChannel.provider.generateCard = async (...args) => {
    beginHolder();
    await holderGate;
    return templateCard(...args);
  };

  assert.equal(await broker.acceptLocalReport(report('Occupy the one global provider slot'), projectAId), true);
  await holderStarted;
  assert.equal(broker.scheduler.getDebugState().active, 1);

  assert.equal(await broker.acceptLocalReport(report('Wait for the fair Studio retry'), projectBId), true);
  await waitFor(
    () => waitingChannel.state.studio.candidates.length === 1 && !waitingChannel.studio.status().generation_in_flight,
    'the second channel to retain its rejected candidate',
  );
  assert.equal(waitingChannel.studio.status().waiting.reason, 'queued');
  assert.equal(waitingChannel.state.cards.length, 0);

  releaseHolder();
  await waitFor(
    () => waitingChannel.state.cards.length === 1 && waitingChannel.studio.currentCard()?.source?.task === 'Wait for the fair Studio retry',
    'the freed global slot to wake the waiting channel',
    // Outbox delivery intentionally adds two durable writes (state+outbox,
    // then its cleared acknowledgement) before the learner can see a card.
    // Keep this polling assertion about fairness rather than local disk speed.
    600,
  );
  await broker.whenIdle();
  assert.equal(waitingChannel.state.studio.candidates.length, 0);
  assert.equal(waitingChannel.studio.status().generation_in_flight, false);
});
