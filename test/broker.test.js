'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBroker, createFairReportScheduler } = require('../lib/broker');
const { namespaceConceptId } = require('../lib/project-concepts');
const { strengthFor } = require('../lib/mastery');

function report(task) {
  return { task, what_i_did: `Completed ${task}.`, stack_hints: ['Node.js'] };
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-broker-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
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
  await broker.initialize();
  const defaultId = broker.defaultProjectId;
  assert.ok(defaultId);

  const registration = await broker.register(projectB);
  const quietRegistration = await broker.register(projectC);
  assert.equal(typeof registration.token, 'string');
  assert.equal(broker.registry.getHydratedProject(registration.project_id), null, 'registration stores only a summary');
  assert.equal(broker.registry.getHydratedProject(quietRegistration.project_id), null, 'an inactive tab remains summary-only');
  assert.equal(await broker.acceptRelayReport(registration.project_id, 'bad-token', report('not accepted')), false);
  assert.equal(await broker.acceptRelayReport(registration.project_id, registration.token, report('B milestone')), true);
  await broker.scheduler.whenIdle();

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
