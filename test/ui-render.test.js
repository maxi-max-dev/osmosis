'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const studioState = require('../public/studio-state');
const mapCoverage = require('../public/map-coverage');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const HAN = /[\u3400-\u9fff]/u;

function fakeNode() {
  return {
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    hidden: false,
    innerHTML: '',
    textContent: '',
    addEventListener() {},
    close() {},
    querySelector() { return fakeNode(); },
    querySelectorAll() { return []; },
    removeAttribute() {},
    setAttribute() {},
    showModal() {},
  };
}

function loadRenderedApp({ answer = null } = {}) {
  const nodes = new Map();
  const nodeFor = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, fakeNode());
    return nodes.get(selector);
  };
  const mascotCalls = [];
  const timers = [];
  const document = {
    documentElement: { lang: 'zh-CN' },
    title: '',
    querySelector: nodeFor,
    querySelectorAll() { return []; },
  };
  const window = {
    __OSMOSIS_APP_TEST_HOOKS__: true,
    location: { hash: '' },
    OsmosisMascot: {
      mount(_container, options) { mascotCalls.push({ ...options }); },
      stateForPresentation(phase) {
        return phase === 'observed' ? 'observing' : phase === 'preparing' ? 'preparing' : 'idle';
      },
    },
    OsmosisMapCoverage: mapCoverage,
    OsmosisStudioState: studioState,
    addEventListener() {},
    clearTimeout() {},
    setTimeout(callback) { timers.push(callback); return timers.length; },
  };
  const context = {
    EventSource: class { addEventListener() {} },
    URLSearchParams,
    console,
    document,
    fetch: answer || (async () => ({ ok: true, status: 200, json: async () => ({}) })),
    window,
  };
  vm.runInNewContext(APP_SOURCE, context, { filename: 'public/app.js' });
  return { hooks: window.__OsmosisAppTest, mascotCalls, nodes, timers };
}

function warmupProject() {
  const card = {
    activity_epoch_id: 'epoch-en',
    concept_name: 'Search files',
    correct_index: 0,
    explanation: 'The command searches tracked files.',
    lesson: 'Use a focused search before inspecting files.',
    options: ['Search all files', 'Delete all files', 'Start a server'],
    question: 'What does this command help you do?',
    source: { kind: 'observed-activity' },
    state: { answered: true, chosen_index: 0, correct: true },
    title: 'Search with rg',
    warmup_id: 'warmup-en',
  };
  return {
    cards: [],
    project_id: 'project-en',
    studio: {
      current: card,
      current_warmup: card,
      next_ready: true,
      now: { kind: 'warmup', card_ref: card.warmup_id },
      presentation: { epoch_id: 'epoch-en', phase: 'preparing', reason: 'formal-lesson', stable_id: 'observation-en' },
      progress: { phase: 'preparing', observation_id: 'observation-en', reason: 'formal-lesson' },
      waiting: { reason: 'preparing', source_provenance: null },
    },
    summary: { archived: false, name: 'English project', project_id: 'project-en', unanswered_count: 0 },
    tree: { meta: {}, nodes: [] },
  };
}

function coverageTree({ surfaced = [] } = {}) {
  return {
    meta: { surfaced_concept_ids: surfaced },
    nodes: [
      { concept_id: 'project-map:root', concept_name: 'Project map', parent_id: null },
      { concept_id: 'project-map:namespaced', concept_name: 'Namespaced', parent_id: 'project-map:root' },
      { concept_id: 'project-map:legacy', concept_name: 'Legacy', parent_id: 'project-map:root' },
      { concept_id: 'feedback-loop', concept_name: 'Feedback loop', parent_id: 'project-map:root' },
      { concept_id: 'project-map:direct-zero', concept_name: 'Direct zero', parent_id: 'project-map:root' },
      { concept_id: 'project-map:latest', concept_name: 'Latest', parent_id: 'project-map:root' },
    ],
  };
}

function carriedActivation(projectId) {
  return { carry: true, project_id: projectId, state: 'carried' };
}

test('the actual English renderer has no Chinese UI fragments in warmup and activity paths', () => {
  const { hooks, nodes } = loadRenderedApp();
  hooks.applySettings({ ui_locale: 'en' });
  const project = warmupProject();
  hooks.store.projects.set(project.project_id, project);
  hooks.store.activeProjectId = project.project_id;

  const warmupHtml = hooks.renderWarmupNow(project, project.studio.current_warmup);
  hooks.renderPipeline();
  const pipelineHtml = nodes.get('#activity-pipeline').innerHTML;

  assert.doesNotMatch(warmupHtml, HAN, 'the real warmup renderer must not leak Chinese control copy in English UI mode');
  assert.doesNotMatch(pipelineHtml, HAN, 'the real activity-strip renderer must use locale-specific detail copy');
  assert.match(warmupHtml, />A<.*>B<.*>C</s);
  assert.match(warmupHtml, />Next lesson </);
  assert.match(warmupHtml, /aria-label="Answer choices"/);
  assert.match(pipelineHtml, /Preparing a lesson from this activity\./);
});

test('Project map coverage renders derived Chinese and English map evidence without a fake empty state', () => {
  const { hooks, nodes } = loadRenderedApp();
  const projectId = 'project-map';
  const project = {
    cards: [{ card_id: 'card-surfaced', concept_id: 'project-map:latest' }],
    project_id: projectId,
    studio: { current: null, next_ready: false, now: { kind: null, card_ref: null } },
    summary: { archived: false, name: 'Map project', project_id: projectId, unanswered_count: 0 },
    tree: coverageTree({ surfaced: ['project-map:direct-zero'] }),
  };
  hooks.store.projects.set(projectId, project);
  hooks.store.activeProjectId = projectId;
  hooks.store.activations.set(projectId, carriedActivation(projectId));
  hooks.store.strengths = {
    'project-map:namespaced': { strength: 2 },
    'project-map:direct-zero': { strength: 0 },
    'direct-zero': { strength: 2 },
    legacy: { strength: 2 },
  };

  hooks.renderMapCoverage();
  const panel = nodes.get('#map-coverage');
  assert.equal(panel.hidden, false);
  assert.match(panel.innerHTML, /项目理解地图覆盖/);
  assert.match(panel.innerHTML, /已掌握 2/);
  assert.match(panel.innerHTML, /已浮现 2/);
  assert.match(panel.innerHTML, /待浮现 1/);

  hooks.applySettings({ ui_locale: 'en' });
  hooks.renderMapCoverage();
  assert.match(panel.innerHTML, /Project map coverage/);
  assert.match(panel.innerHTML, /2 mastered/);
  assert.match(panel.innerHTML, /2 surfaced/);
  assert.match(panel.innerHTML, /1 remaining/);
  assert.doesNotMatch(panel.innerHTML, HAN, 'coverage copy follows the selected interface locale');

  const trail = nodes.get('#learning-trail');
  trail.innerHTML = '<li>existing empty state</li>';
  hooks.store.activeProjectId = null;
  hooks.renderMapCoverage();
  assert.equal(panel.hidden, true, 'no active carried project must show no 0/0 coverage');
  assert.equal(panel.innerHTML, '');
  assert.equal(trail.innerHTML, '<li>existing empty state</li>', 'hiding coverage never changes the existing empty trail');

  hooks.store.activeProjectId = projectId;
  hooks.store.activations.set(projectId, { carry: true, project_id: projectId, state: 'activation-pending' });
  hooks.renderMapCoverage();
  assert.equal(panel.hidden, true, 'an unactivated project must hide coverage');
  hooks.store.activations.set(projectId, carriedActivation(projectId));
  project.tree = { meta: {}, nodes: [] };
  hooks.renderMapCoverage();
  assert.equal(panel.hidden, true, 'a carried project without card-generating leaves must hide coverage');
});

test('the actual browser strength reader keeps direct zero, global, and invalid namespace fallbacks aligned with the server', () => {
  const { hooks } = loadRenderedApp();
  hooks.store.strengths = {
    'project-map:direct-zero': { strength: 0 },
    'direct-zero': { strength: 2 },
    legacy: { strength: 2 },
    local: { strength: 2 },
    many: { strength: 2 },
  };
  assert.equal(hooks.strengthFor('project-map:direct-zero'), 0);
  assert.equal(hooks.strengthFor('project-map:legacy'), 2);
  assert.equal(hooks.strengthFor('feedback-loop'), 0);
  assert.equal(hooks.strengthFor('Project-map:local'), 0);
  assert.equal(hooks.strengthFor('project-map:too:many'), 0);
});

test('tree SSE writes back into the coverage view and a reconnect preserves namespaced, global, and legacy mastery', () => {
  const { hooks, nodes } = loadRenderedApp();
  const projectId = 'project-map';
  hooks.applySettings({ ui_locale: 'en' });
  hooks.store.activeProjectId = projectId;
  hooks.store.activations.set(projectId, carriedActivation(projectId));

  hooks.applySnapshot(projectId, {
    cards: [],
    strengths: {
      'project-map:direct-zero': { strength: 0 },
      'project-map:namespaced': { strength: 2 },
      'direct-zero': { strength: 2 },
      'feedback-loop': { strength: 2 },
      legacy: { strength: 2 },
    },
    studio: { current: null, next_ready: false, now: { kind: null, card_ref: null } },
    tree: coverageTree(),
  });
  hooks.renderMapCoverage();
  const panel = nodes.get('#map-coverage');
  assert.match(panel.innerHTML, /3 mastered/);
  assert.match(panel.innerHTML, /2 remaining/);

  const sseTree = coverageTree({ surfaced: ['project-map:direct-zero'] });
  hooks.applyProjectEvent('tree', { ...sseTree, project_id: projectId });
  assert.equal(JSON.stringify(hooks.store.projects.get(projectId).tree), JSON.stringify(sseTree), 'the tree event must update the in-memory channel tree');
  assert.match(panel.innerHTML, /1 surfaced/);
  assert.match(panel.innerHTML, /1 remaining/);

  hooks.applyProjectEvent('strength', { concept_id: 'project-map:latest', project_id: projectId, strength: 2 });
  assert.match(panel.innerHTML, /4 mastered/, 'a live namespaced strength event updates coverage immediately');

  hooks.applySnapshot(projectId, {
    cards: [],
    strengths: hooks.store.strengths,
    studio: { current: null, next_ready: false, now: { kind: null, card_ref: null } },
    tree: coverageTree({ surfaced: ['project-map:direct-zero', 'project-map:latest'] }),
  });
  hooks.renderMapCoverage();
  assert.match(panel.innerHTML, /4 mastered/);
  assert.match(panel.innerHTML, /1 surfaced/, 'the reconnect snapshot restores tree-derived coverage');
});

test('a correct real tree-card answer advances map mastery, while a warmup answer leaves map coverage unchanged', async () => {
  const projectId = 'project-map';
  const realCard = {
    card_id: 'real-card', concept_id: 'project-map:real-card', concept_name: 'Real card', correct_index: 0,
    explanation: 'Correct.', lesson: 'A real lesson.', options: ['Yes', 'No', 'Maybe'], question: 'Choose.',
    source: { kind: 'agent' }, state: { answered: false, chosen_index: null, correct: null },
  };
  const realTree = {
    meta: { surfaced_concept_ids: [] },
    nodes: [
      { concept_id: 'project-map:root', concept_name: 'Root', parent_id: null },
      { concept_id: 'project-map:real-card', concept_name: 'Real card', parent_id: 'project-map:root' },
    ],
  };
  const real = loadRenderedApp({
    answer: async () => ({ ok: true, status: 200, json: async () => ({ correct: true, explanation: 'Correct.', strength: 2 }) }),
  });
  real.hooks.applySettings({ ui_locale: 'en' });
  real.hooks.store.projects.set(projectId, {
    cards: [realCard], project_id: projectId,
    studio: { current: realCard, current_warmup: null, next_ready: false, now: { kind: 'real', card_ref: realCard.card_id } },
    summary: { archived: false, name: 'Map project', project_id: projectId, unanswered_count: 1 }, tree: realTree,
  });
  real.hooks.store.activeProjectId = projectId;
  real.hooks.store.activations.set(projectId, carriedActivation(projectId));
  real.hooks.renderMapCoverage();
  assert.match(real.nodes.get('#map-coverage').innerHTML, /0 mastered.*1 surfaced/s);

  await real.hooks.submitAnswer(projectId, realCard.card_id, 0);
  assert.match(real.nodes.get('#map-coverage').innerHTML, /1 mastered.*0 surfaced/s, 'a real, tree-backed correct answer is the only M + 1 path');

  const warmupId = 'warmup-only';
  const warmupCard = {
    concept_id: 'project-map:warmup-only', concept_name: 'Warmup only', correct_index: 0,
    explanation: 'Warmup.', lesson: 'Orientation only.', options: ['Yes', 'No', 'Maybe'], question: 'Choose.',
    state: { answered: false, chosen_index: null, correct: null }, title: 'Warmup only', warmup_id: warmupId,
  };
  const warmup = loadRenderedApp({
    answer: async () => ({ ok: true, status: 200, json: async () => ({ correct: true, explanation: 'Warmup.', strength: 2, warmup: true }) }),
  });
  warmup.hooks.applySettings({ ui_locale: 'en' });
  warmup.hooks.store.projects.set(projectId, {
    cards: [], project_id: projectId,
    studio: { current: warmupCard, current_warmup: warmupCard, next_ready: false, now: { kind: 'warmup', card_ref: warmupId } },
    summary: { archived: false, name: 'Map project', project_id: projectId, unanswered_count: 0 },
    tree: {
      meta: { surfaced_concept_ids: [] },
      nodes: [
        { concept_id: 'project-map:root', concept_name: 'Root', parent_id: null },
        { concept_id: 'project-map:warmup-only', concept_name: 'Warmup only', parent_id: 'project-map:root' },
      ],
    },
  });
  warmup.hooks.store.activeProjectId = projectId;
  warmup.hooks.store.activations.set(projectId, carriedActivation(projectId));
  warmup.hooks.renderMapCoverage();
  const beforeWarmupAnswer = warmup.nodes.get('#map-coverage').innerHTML;
  await warmup.hooks.submitAnswer(projectId, warmupId, 0);
  assert.equal(warmup.nodes.get('#map-coverage').innerHTML, beforeWarmupAnswer, 'a warmup answer never changes map coverage');
});

test('the real answer renderer sends one correct-answer celebration episode, never a card-ready celebration', async () => {
  const { hooks, mascotCalls } = loadRenderedApp({
    answer: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ correct: true, explanation: 'Exactly.', strength: 2 }),
    }),
  });
  hooks.applySettings({ ui_locale: 'en' });
  const card = {
    card_id: 'card-answer', concept_id: 'concept-answer', concept_name: 'A concept', correct_index: 0,
    explanation: '', lesson: 'A lesson.', options: ['Yes', 'No', 'Maybe'], question: 'Choose.',
    source: { kind: 'agent' }, state: { answered: false, chosen_index: null, correct: null },
  };
  const project = {
    cards: [card], project_id: 'project-answer',
    studio: {
      current: card, current_warmup: null, next_ready: false,
      now: { kind: 'real', card_ref: card.card_id },
      presentation: { epoch_id: 'epoch-answer', phase: 'card-ready', reason: 'delivery', stable_id: card.card_id },
      waiting: { reason: 'idle', source_provenance: null },
    },
    summary: { archived: false, name: 'Answer project', project_id: 'project-answer', unanswered_count: 1 },
    tree: { meta: {}, nodes: [] },
  };
  hooks.store.projects.set(project.project_id, project);
  hooks.store.activeProjectId = project.project_id;

  hooks.renderPipeline();
  assert.equal(mascotCalls.at(-1).state, 'idle', 'a ready card is not a celebration');
  assert.equal(mascotCalls.at(-1).celebrationEpisode, null);

  await hooks.submitAnswer(project.project_id, card.card_id, 0);
  assert.equal(mascotCalls.at(-1).state, 'idle', 'the underlying state remains truthful during a celebration');
  assert.equal(mascotCalls.at(-1).celebrationEpisode, 'answer:project-answer:card-answer');

  hooks.celebrateCorrectAnswer(project.project_id, card.card_id);
  assert.equal(hooks.store.celebration.episode, 'answer:project-answer:card-answer', 'the same correct answer stays one deduped episode');
});

test('the real English warmup 409 path renders localized replacement toasts after refresh and reconnect fallback', async () => {
  const cases = [
    {
      expected: 'This warmup was replaced by the full lesson from the same activity.',
      snapshotResponse: {
        ok: true,
        status: 200,
        json: async () => ({
          cards: [], strengths: {}, tree: { meta: {}, nodes: [] },
          studio: {
            current: null, current_warmup: null, next_ready: false,
            now: { kind: null, card_ref: null }, presentation: { phase: 'idle' },
            waiting: { reason: 'idle', source_provenance: null },
          },
        }),
      },
    },
    {
      expected: 'This warmup was replaced. The page will update when it reconnects.',
      snapshotResponse: { ok: false, status: 503 },
    },
  ];
  for (const scenario of cases) {
    const { hooks, nodes } = loadRenderedApp({
      answer: async (url) => (url.startsWith('/answer?')
        ? { ok: false, status: 409 }
        : scenario.snapshotResponse),
    });
    hooks.applySettings({ ui_locale: 'en' });
    const project = warmupProject();
    project.studio.current_warmup.state = { answered: false, chosen_index: null, correct: null };
    project.studio.current = project.studio.current_warmup;
    hooks.store.projects.set(project.project_id, project);
    hooks.store.activeProjectId = project.project_id;

    await hooks.submitAnswer(project.project_id, project.studio.current_warmup.warmup_id, 0);
    const toast = nodes.get('#toast').textContent;
    assert.equal(toast, scenario.expected);
    assert.doesNotMatch(toast, HAN, 'the actual 409 recovery toast must stay in the selected English locale');
  }
});
