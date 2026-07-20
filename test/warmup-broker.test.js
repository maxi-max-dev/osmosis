'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createBroker } = require('../lib/broker');
const { namespaceConceptId } = require('../lib/project-concepts');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-warmup-broker-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function configFor(root, overrides = {}) {
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
    ...overrides,
  };
}

async function writeTargetAwareCodexShim(directory) {
  const shimPath = path.join(directory, 'target-aware-fake-codex.js');
  const promptPath = path.join(directory, 'target-aware-fake-codex-prompt.txt');
  // Deliberately omit `search-with-rg`: this proves the real provider path
  // can use its one-shot synthetic target mapping without mutating a live
  // project tree merely to make an epoch replacement possible.
  const tree = JSON.stringify({
    nodes: [
      { concept_id: 'project', concept_name: 'Your project', parent_id: null },
      { concept_id: 'interface', concept_name: 'The interface', parent_id: 'project' },
      { concept_id: 'data', concept_name: 'Data flow', parent_id: 'project' },
      { concept_id: 'automation', concept_name: 'Automation', parent_id: 'project' },
      { concept_id: 'html', concept_name: 'HTML structure', parent_id: 'interface' },
      { concept_id: 'css', concept_name: 'CSS styling', parent_id: 'interface' },
      { concept_id: 'dom', concept_name: 'The document tree', parent_id: 'interface' },
      { concept_id: 'http', concept_name: 'HTTP', parent_id: 'data' },
      { concept_id: 'json', concept_name: 'JSON data', parent_id: 'data' },
      { concept_id: 'state', concept_name: 'App state', parent_id: 'data' },
      { concept_id: 'mcp', concept_name: 'MCP reporting', parent_id: 'automation' },
      { concept_id: 'tests', concept_name: 'Automated tests', parent_id: 'automation' },
      { concept_id: 'deploy', concept_name: 'Deployment', parent_id: 'automation' },
    ],
  });
  const targetCard = JSON.stringify({
    concept_id: 'search-with-rg',
    concept_name: 'Search with rg',
    lesson: 'Searching narrows a large project to the few places that may matter, like using an index before opening every page in a book.',
    question: 'What is the main value of a focused code search?',
    options: ['It narrows where to inspect.', 'It automatically changes every result.', 'It removes the need to test changes.'],
    correct_index: 0,
    explanation: 'A search points to relevant places; it does not make the later decision for you.',
  });
  const unrelatedCard = JSON.stringify({
    concept_id: 'http',
    concept_name: 'HTTP',
    lesson: 'HTTP carries a request to a server and brings a response back, like a labeled envelope moving between two places.',
    question: 'What does HTTP help an app do?',
    options: ['Send a request and receive a response.', 'Draw every screen pixel.', 'Store passwords in a browser tab.'],
    correct_index: 0,
    explanation: 'HTTP carries a request to a server and brings a response back.',
  });
  await fs.writeFile(
    shimPath,
    `#!/usr/bin/env node\n'use strict';\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst outputPath = args[args.indexOf('--output-last-message') + 1];\nconst schemaPath = args[args.indexOf('--output-schema') + 1];\nconst prompt = args.at(-1) || '';\nconst tree = ${JSON.stringify(tree)};\nconst targetCard = ${JSON.stringify(targetCard)};\nconst unrelatedCard = ${JSON.stringify(unrelatedCard)};\nlet result = tree;\nif (!schemaPath.endsWith('tree-output.schema.json')) {\n  fs.writeFileSync(${JSON.stringify(promptPath)}, prompt, 'utf8');\n  const targetWasCarried = /REQUIRED_CANONICAL_CONCEPT_ID="search-with-rg"/.test(prompt) && /AVAILABLE_CONCEPTS=\\[\\{"concept_id":"search-with-rg"/.test(prompt);\n  result = targetWasCarried ? targetCard : unrelatedCard;\n}\nfs.writeFileSync(outputPath, result);\nprocess.stdout.write(result);\n`,
    { mode: 0o755 },
  );
  return { promptPath, shimPath };
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

test('a real Codex provider path carries a warmup target through a synthetic tree mapping and replaces the same-epoch warmup', { timeout: 15_000 }, async (t) => {
  const root = await temporaryDirectory(t);
  const { promptPath, shimPath } = await writeTargetAwareCodexShim(root);
  const broker = createBroker({
    config: configFor(root, {
      cardPacingMs: 0,
      codexCommand: shimPath,
      codexTimeoutMs: 5_000,
      provider: 'codex',
    }),
    hub: { broadcast() {} },
  });
  t.after(() => broker.close());
  await broker.startOwner();
  const projectId = broker.defaultProjectId;
  await broker.activateProject(projectId, {
    capture_mode: 'experimental-ambient',
    carry: true,
    lesson_locale: 'en',
  });

  const observation = observedExec({
    command: 'rg --files',
    epoch: 'provider-target',
    projectId,
  });
  const result = await broker.acceptWarmupCandidate(projectId, observation);
  assert.equal(result.handled, true);
  assert.equal(result.state, 'warmup-served');
  await new Promise((resolve) => setImmediate(resolve));
  await broker.whenIdle();

  const channel = await broker.ensureChannel(projectId);
  assert.equal(
    channel.state.tree.nodes.some((node) => node.concept_id.endsWith(':search-with-rg') || node.concept_id === 'search-with-rg'),
    false,
    'the initial live tree intentionally has no catalog leaf for this observed command',
  );
  assert.deepEqual(channel.state.studio.now.kind, 'real');
  assert.equal(channel.state.studio.ready_card, null);
  const trueCard = channel.state.cards.find((card) => card.card_id === channel.state.studio.now.card_ref);
  assert.ok(trueCard);
  assert.equal(trueCard.concept_id, namespaceConceptId(projectId, 'search-with-rg'));
  assert.equal(trueCard.source.activity_epoch_id, observation.observation_id);

  const prompt = await fs.readFile(promptPath, 'utf8');
  assert.match(prompt, /REQUIRED_CANONICAL_CONCEPT_ID="search-with-rg"/);
  assert.match(prompt, /AVAILABLE_CONCEPTS=\[{"concept_id":"search-with-rg"/);

  const activity = await broker.activity(projectId, 100);
  const trace = activity.entries.filter((entry) => entry.activity_epoch_id === observation.observation_id);
  assert.deepEqual(
    trace.map((entry) => entry.event).filter((event) => ['observed', 'warmup_served', 'provider-result', 'warmup_replaced', 'delivery'].includes(event)),
    ['observed', 'warmup_served', 'provider-result', 'warmup_replaced', 'delivery'],
  );
  const replaced = trace.find((entry) => entry.event === 'warmup_replaced');
  const delivered = trace.find((entry) => entry.event === 'delivery');
  assert.equal(replaced.warmup_id, `warmup-${observation.observation_id}`);
  assert.equal(replaced.card_id, trueCard.card_id);
  assert.equal(delivered.card_id, trueCard.card_id);
  assert.equal(replaced.report_id, `observed-${observation.observation_id}`);
});
