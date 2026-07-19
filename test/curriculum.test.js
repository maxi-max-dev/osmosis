'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createCurriculumService } = require('../lib/curriculum-service');
const { createTreeService } = require('../lib/tree-service');

function initialNodes() {
  return [
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
  ];
}

function pendingCard(conceptId) {
  return { concept_id: conceptId, state: { answered: false } };
}

function createHarness({ cards = [], strengths = {}, studio = null, cardPacingMs = 12_000, sleep = async () => {}, clock = () => 1_000 } = {}) {
  const state = { cards, strengths, studio, tree: { meta: {}, nodes: [] } };
  const events = [];
  const savedTrees = [];
  let treeCalls = 0;
  const provider = {
    name: 'codex',
    supportsLiveCurriculum: true,
    async generateInitialTree() {
      treeCalls += 1;
      return { nodes: initialNodes() };
    },
  };
  const hub = { broadcast: (type, payload) => events.push({ type, payload: JSON.parse(JSON.stringify(payload)) }) };
  const persistence = { saveTree: async (tree) => savedTrees.push(JSON.parse(JSON.stringify(tree))) };
  const treeService = createTreeService({ state, persistence, hub, provider });
  const curriculum = createCurriculumService({
    config: { cardPacingMs, mode: 'live', unansweredCardCap: 5 },
    hub,
    provider,
    state,
    treeService,
    clock,
    sleep,
  });
  return { curriculum, events, savedTrees, state, treeCalls: () => treeCalls };
}

test('the initial curriculum tree is validated, persisted, and never regenerated', async () => {
  const harness = createHarness();
  const report = { task: 'UI', what_i_did: 'Built HTML structure and CSS styling.', stack_hints: ['HTML', 'CSS'] };

  const first = await harness.curriculum.prepare(report);
  const second = await harness.curriculum.prepare({ ...report, task: 'Data' });

  assert.equal(harness.treeCalls(), 1);
  assert.equal(harness.state.tree.nodes.length, 13);
  assert.equal(harness.savedTrees.length, 1);
  assert.equal(typeof harness.state.tree.meta.created_at, 'string');
  assert.equal(first.concepts.length, 9);
  assert.equal(second.concepts.length, 9);
});

test('the curriculum filters mastered concepts and marks a direct concept when the queue is full', async () => {
  const harness = createHarness({
    cards: [pendingCard('one'), pendingCard('two'), pendingCard('three'), pendingCard('four'), pendingCard('five')],
  });
  const report = { task: 'HTTP route', what_i_did: 'Added HTTP request routing.', stack_hints: ['HTTP'] };

  const prepared = await harness.curriculum.prepare(report);

  assert.equal(prepared.skip.state, 'queue-full');
  assert.equal(harness.state.tree.meta.surfaced_concept_ids.includes('http'), true);
  assert.equal(harness.events.some((event) => event.type === 'tree'), true);

  const masteredHarness = createHarness({ strengths: { http: { strength: 2 } } });
  const available = await masteredHarness.curriculum.prepare(report);
  assert.equal(available.concepts.some((concept) => concept.concept_id === 'http'), false);
});

test('live curriculum pacing waits 12 seconds after the first delivered card and rechecks mastery', async () => {
  let now = 1_000;
  const waits = [];
  const harness = createHarness({
    clock: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  const report = { task: 'HTTP', what_i_did: 'Added an HTTP route.', stack_hints: ['HTTP'] };
  await harness.curriculum.prepare(report);

  const first = { concept_id: 'http', concept_name: 'HTTP' };
  assert.deepEqual(await harness.curriculum.beforeDelivery(first), { deliver: true });
  await harness.curriculum.markDelivered(first.concept_id);

  now = 2_000;
  const second = { concept_id: 'json', concept_name: 'JSON data' };
  assert.deepEqual(await harness.curriculum.beforeDelivery(second), { deliver: true });
  assert.deepEqual(waits, [11_000]);

  now = 20_000;
  const masteredDuringWait = { concept_id: 'dom', concept_name: 'The document tree' };
  harness.state.strengths.dom = { strength: 2 };
  const skipped = await harness.curriculum.beforeDelivery(masteredDuringWait);
  assert.equal(skipped.deliver, false);
  assert.equal(skipped.state, 'skipped');
});

test('a deliberate Studio Next bypasses pacing, while a restarted channel restores its unsolicited cadence', async () => {
  let now = 2_000;
  const waits = [];
  const restored = createHarness({
    clock: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
    studio: { last_unsolicited_delivery_at: 1_000 },
  });

  const next = { concept_id: 'json', concept_name: 'JSON data' };
  assert.deepEqual(await restored.curriculum.beforeDelivery(next, { solicited: true }), { deliver: true });
  assert.deepEqual(waits, [], 'an explicit Next click must never wait behind background pacing');

  now = 2_000;
  const unsolicited = { concept_id: 'state', concept_name: 'App state' };
  assert.deepEqual(await restored.curriculum.beforeDelivery(unsolicited), { deliver: true });
  assert.deepEqual(waits, [11_000], 'a restarted channel keeps the previous unsolicited delivery gap');
});

test('separate project channels keep independent pacing clocks and unanswered caps', async () => {
  let now = 1_000;
  const waitsA = [];
  const waitsB = [];
  const a = createHarness({
    clock: () => now,
    sleep: async (milliseconds) => {
      waitsA.push(milliseconds);
      now += milliseconds;
    },
  });
  const b = createHarness({
    clock: () => now,
    sleep: async (milliseconds) => {
      waitsB.push(milliseconds);
      now += milliseconds;
    },
  });

  await a.curriculum.markDelivered('a-first');
  now = 2_000;
  assert.deepEqual(await b.curriculum.beforeDelivery({ concept_id: 'b-first', concept_name: 'Project B first card' }), { deliver: true });
  assert.deepEqual(waitsB, [], 'a delivery must not pace b');

  assert.deepEqual(await a.curriculum.beforeDelivery({ concept_id: 'a-second', concept_name: 'Project A second card' }), { deliver: true });
  assert.deepEqual(waitsA, [11_000]);
  assert.deepEqual(waitsB, []);
});
