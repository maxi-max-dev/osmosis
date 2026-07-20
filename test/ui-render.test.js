'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const studioState = require('../public/studio-state');

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
