'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBroker } = require('../lib/broker');
const { createHttpHandler } = require('../lib/http');
const { resolveProjectIdentity } = require('../lib/project-identity');
const {
  CAPTURE_AGENT_REPORTS_ONLY,
  CAPTURE_EXPERIMENTAL_AMBIENT,
  GLOBAL_LEARNING_PAUSED,
  LESSON_LOCALE_SIMPLIFIED_CHINESE,
  createSettingsStore,
} = require('../lib/settings-store');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-studio-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function makeConfig(root, profileDir) {
  return {
    ambientEnabled: true,
    cardPacingMs: 1,
    codexHome: path.join(root, 'codex'),
    cwd: root,
    globalReportQueueCap: 5,
    host: '127.0.0.1',
    mode: 'live',
    port: 4321,
    profileDir,
    profilePath: path.join(profileDir, 'profile.json'),
    provider: 'none',
    replayPath: path.join(root, '.osmosis', 'replay.json'),
    settingsPath: path.join(profileDir, 'settings.json'),
    stateDir: path.join(root, '.osmosis'),
    templateDelayMs: 60_000,
    treePath: path.join(root, '.osmosis', 'tree.json'),
    unansweredCardCap: 5,
  };
}

function report(task = 'Activation milestone') {
  return {
    stack_hints: ['Node.js', 'HTTP'],
    task,
    what_i_did: `Completed ${task} without needing a hidden project channel.`,
  };
}

async function startHttp(t, handler) {
  const server = http.createServer((request, response) => void handler(request, response));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('Learning Studio settings persist all three controls and keep auto-advance opt-in', async (t) => {
  const directory = await temporaryDirectory(t);
  const settingsPath = path.join(directory, 'profile', 'settings.json');
  const projectId = 'studio-settings-0123456789';
  const store = createSettingsStore({ settingsPath });

  assert.deepEqual(await store.load(), {
    global_learning: 'on',
    lesson_locale: 'en',
    pending_activation_counts: {},
    projects: {},
    version: 1,
  });
  assert.deepEqual(store.activationFor(projectId), {
    auto_advance: false,
    capture_mode: CAPTURE_AGENT_REPORTS_ONLY,
    carry: null,
    lesson_locale: 'en',
    project_id: projectId,
    state: 'activation-pending',
  });

  await store.setGlobalLearning(GLOBAL_LEARNING_PAUSED);
  await store.setLessonLocale(LESSON_LOCALE_SIMPLIFIED_CHINESE);
  await store.setProject(projectId, {
    auto_advance: true,
    capture_mode: CAPTURE_EXPERIMENTAL_AMBIENT,
    carry: true,
  });

  const restarted = createSettingsStore({ settingsPath });
  await restarted.load();
  assert.deepEqual(restarted.activationFor(projectId), {
    auto_advance: true,
    capture_mode: CAPTURE_EXPERIMENTAL_AMBIENT,
    carry: true,
    lesson_locale: LESSON_LOCALE_SIMPLIFIED_CHINESE,
    project_id: projectId,
    state: 'carried',
  });
  assert.equal(restarted.isPaused(), true);
  const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.equal(persisted.projects[projectId].auto_advance, true);
  assert.equal(persisted.lesson_locale, LESSON_LOCALE_SIMPLIFIED_CHINESE);
});

test('unknown startup reports wait for activation, then Carry creates state and releases them', async (t) => {
  const root = await temporaryDirectory(t);
  const profileDir = path.join(root, 'profile');
  const broker = createBroker({ config: makeConfig(root, profileDir), hub: { broadcast() {} } });
  await broker.initialize();
  const projectId = broker.defaultProjectId;

  assert.equal(broker.activation().state, 'activation-pending');
  assert.deepEqual(await broker.listProjects(), []);
  assert.equal(await fs.stat(path.join(root, '.osmosis')).then(() => true, () => false), false);

  assert.equal(await broker.acceptLocalReport(report()), true, 'an explicit agent milestone is held, not dropped');
  await broker.whenIdle();
  assert.equal(broker.activation().pending_report_count, 1);
  assert.deepEqual(await broker.listProjects(), []);
  const pendingTrace = (await broker.activity('unregistered', 10));
  assert.equal(pendingTrace, null, 'unregistered activity remains separate from a project ledger');
  const unregistered = await broker.settingsStore.load();
  assert.equal(unregistered.pending_activation_counts[projectId], 1);
  const ledgerText = await fs.readFile(path.join(profileDir, 'ledger', 'unregistered.jsonl'), 'utf8');
  assert.match(ledgerText, /activation-pending/);
  assert.match(ledgerText, /"state":"waiting"/);

  const activated = await broker.activateProject(projectId, {
    capture_mode: CAPTURE_AGENT_REPORTS_ONLY,
    carry: true,
    lesson_locale: 'en',
  });
  await broker.whenIdle();
  assert.equal(activated.released, 1);
  assert.equal(broker.activation().state, 'carried');
  assert.equal(broker.activation().pending_report_count, 0);
  assert.equal((await broker.listProjects()).length, 1);
  const channel = await broker.ensureChannel(projectId);
  assert.equal(channel.state.cards.length, 1, 'the held report reaches the normal lesson pipeline only after Carry');
  broker.close();
});

test('uncarried projects never become ambient channels, while carried experimental ambient can route', async (t) => {
  const root = await temporaryDirectory(t);
  const profileDir = path.join(root, 'profile');
  const broker = createBroker({ config: makeConfig(root, profileDir), hub: { broadcast() {} } });
  await broker.initialize();
  const projectId = broker.defaultProjectId;

  // Ambient observation may inspect another local cwd for isolation, but it
  // must not turn that observation into a browser activation prompt. Only a
  // runner/MCP registration is allowed to ask the person to Carry a project.
  const ambientOnlyRoot = path.join(root, 'ambient-only');
  await fs.mkdir(ambientOnlyRoot);
  const ambientOnly = await resolveProjectIdentity(ambientOnlyRoot);
  await broker.resolveAmbientProject(ambientOnlyRoot);
  assert.equal(broker.activations().some((activation) => activation.project_id === ambientOnly.project_id), false);

  assert.deepEqual(await broker.resolveAmbientProject(root), {
    reason: 'activation-pending',
    registered: false,
    root: await fs.realpath(root),
  });
  await broker.activateProject(projectId, {
    capture_mode: CAPTURE_EXPERIMENTAL_AMBIENT,
    carry: false,
    lesson_locale: 'en',
  });
  assert.equal((await broker.listProjects()).length, 0);
  assert.equal((await broker.resolveAmbientProject(root)).registered, false);
  assert.equal((await broker.resolveAmbientProject(root)).reason, 'project-not-carried');

  await broker.updateProjectSettings(projectId, {
    capture_mode: CAPTURE_EXPERIMENTAL_AMBIENT,
    carry: true,
  });
  const route = await broker.resolveAmbientProject(root);
  assert.equal(route.project_id, projectId);
  assert.equal(route.root, await fs.realpath(root));
  assert.equal((await broker.listProjects()).length, 1);

  await broker.updateSettings({ global_learning: GLOBAL_LEARNING_PAUSED });
  const pausedRoute = await broker.resolveAmbientProject(root);
  assert.equal(pausedRoute.registered, false);
  assert.equal(pausedRoute.reason, 'learning-paused');
  broker.close();
});

test('a global Learning Studio pause drops new reports before they can become activation-pending work', async (t) => {
  const root = await temporaryDirectory(t);
  const profileDir = path.join(root, 'profile');
  const broker = createBroker({ config: makeConfig(root, profileDir), hub: { broadcast() {} } });
  await broker.initialize();
  t.after(() => broker.close());
  const projectId = broker.defaultProjectId;

  await broker.updateSettings({ global_learning: GLOBAL_LEARNING_PAUSED });
  assert.equal(await broker.acceptLocalReport(report('Paused milestone')), true);
  await broker.whenIdle();

  assert.equal(broker.activation().state, 'activation-pending');
  assert.equal(broker.activation().pending_report_count, 0);
  assert.deepEqual(await broker.listProjects(), []);
  assert.equal((await broker.resolveAmbientProject(root)).reason, 'learning-paused');
  assert.equal(await fs.stat(path.join(root, '.osmosis')).then(() => true, () => false), false);
  assert.equal(projectId, broker.defaultProjectId);
});

test('settings and activation HTTP APIs expose a concise persisted Studio contract', async (t) => {
  const root = await temporaryDirectory(t);
  const profileDir = path.join(root, 'profile');
  const config = makeConfig(root, profileDir);
  const broker = createBroker({ config, hub: { broadcast() {} } });
  await broker.initialize();
  t.after(() => broker.close());
  const handler = createHttpHandler({
    broker,
    config: { ...config, publicDir: path.join(__dirname, '..', 'public') },
    hub: { connect() {} },
    snapshot: () => ({ cards: [], strengths: {}, tree: { meta: {}, nodes: [] } }),
  });
  const origin = await startHttp(t, handler);

  const settings = await (await fetch(`${origin}/settings`)).json();
  assert.equal(settings.global_learning, 'on');
  assert.equal(settings.activation.state, 'activation-pending');
  assert.equal('root' in settings.activation, false);

  const activationResponse = await fetch(`${origin}/activation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      auto_advance: false,
      capture_mode: CAPTURE_AGENT_REPORTS_ONLY,
      carry: true,
      lesson_locale: LESSON_LOCALE_SIMPLIFIED_CHINESE,
    }),
  });
  assert.equal(activationResponse.status, 200);
  const activation = await activationResponse.json();
  assert.equal(activation.activation.state, 'carried');

  const projectId = broker.defaultProjectId;
  const projectResponse = await fetch(`${origin}/projects/${encodeURIComponent(projectId)}/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auto_advance: true }),
  });
  assert.equal(projectResponse.status, 200);
  assert.equal((await projectResponse.json()).activation.auto_advance, true);

  const pausedResponse = await fetch(`${origin}/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ global_learning: GLOBAL_LEARNING_PAUSED }),
  });
  assert.equal(pausedResponse.status, 200);
  assert.equal((await pausedResponse.json()).global_learning, GLOBAL_LEARNING_PAUSED);
});
