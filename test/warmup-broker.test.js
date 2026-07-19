'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBroker } = require('../lib/broker');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-warmup-broker-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function configFor(root) {
  const profileDir = path.join(root, 'profile');
  const stateDir = path.join(root, '.osmosis');
  return {
    ambientEnabled: true,
    cardPacingMs: 1,
    codexHome: path.join(root, 'codex-home'),
    cwd: root,
    globalReportQueueCap: 5,
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

function observedExec({ projectId, command, epoch }) {
  return {
    activity_epoch_id: epoch,
    event: {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: JSON.stringify({ cmd: command }),
      },
    },
    observation_id: `observation-${epoch}`,
    report: {
      report_id: `observed-observation-${epoch}`,
      source: 'observed',
      stack_hints: ['node'],
      task: 'Observed local activity',
      what_i_did: 'Observed a safe local activity.',
    },
    rollout_identity: `rollout-${epoch}`,
    route: { project_id: projectId, reason: '', registered: true },
  };
}

test('a routed but unallowlisted event remains on the normal path and still records an honest warmup suppression', async (t) => {
  const root = await temporaryDirectory(t);
  const broker = createBroker({ config: configFor(root), hub: { broadcast() {} } });
  t.after(() => broker.close());
  await broker.startOwner();
  const projectId = broker.defaultProjectId;
  await broker.activateProject(projectId, {
    capture_mode: 'experimental-ambient',
    carry: true,
    lesson_locale: 'en',
  });

  const result = await broker.acceptWarmupCandidate(projectId, observedExec({
    command: 'node build.js',
    epoch: 'unallowlisted',
    projectId,
  }));
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'trigger-not-allowlisted');
  await broker.whenIdle();

  const activity = await broker.activity(projectId, 100);
  assert.equal(
    activity.entries.some((entry) => (
      entry.event === 'warmup_suppressed'
      && entry.observation_id === 'observation-unallowlisted'
      && entry.reason === 'trigger-not-allowlisted'
      && entry.state === 'suppressed'
    )),
    true,
    'the WHY NO CARD drawer explains why this event did not receive a local warmup even though aggregation may continue',
  );
});

test('a delayed warmup callback loses its owner epoch cleanly when the broker closes before its first await resumes', async (t) => {
  const root = await temporaryDirectory(t);
  const broker = createBroker({ config: configFor(root), hub: { broadcast() {} } });
  t.after(() => broker.close());
  await broker.startOwner();
  const projectId = broker.defaultProjectId;
  await broker.activateProject(projectId, {
    capture_mode: 'experimental-ambient',
    carry: true,
    lesson_locale: 'en',
  });

  const pending = broker.acceptWarmupCandidate(projectId, observedExec({
    command: 'rg --files',
    epoch: 'owner-closed',
    projectId,
  }));
  broker.close();
  const result = await pending;
  assert.equal(result.handled, false);
  assert.equal(result.reason, 'not-owner');

  const activity = await broker.activity(projectId, 100);
  assert.equal(
    activity.entries.some((entry) => entry.observation_id === 'observation-owner-closed'),
    false,
    'an old owner never writes a warmup trace after its HTTP-owner epoch ends',
  );
  assert.equal(
    broker.registry.getHydratedProject(projectId),
    null,
    'the losing callback never hydrates a project channel or starts a provider path',
  );
});
