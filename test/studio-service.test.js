'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeStudioState, snapshotFor } = require('../lib/state');
const { createStudioService } = require('../lib/studio-service');

function report(number) {
  return {
    report_id: `report-${number}`,
    task: `Milestone ${number}`,
    what_i_did: `Completed work for milestone ${number}.`,
    stack_hints: ['node', `topic-${number}`],
    source: number % 2 ? 'agent' : 'observed',
    ...(number === 2 ? { observed_kind: 'change' } : {}),
  };
}

function card(number) {
  return {
    card_id: `card-${number}`,
    concept_id: `concept-${number}`,
    concept_name: `Concept ${number}`,
    lesson: `Lesson ${number}`,
    question: `Hidden question ${number}?`,
    options: ['one', 'two', 'three'],
    correct_index: 0,
    explanation: `Explanation ${number}`,
    source: { kind: 'agent', task: `Milestone ${number}`, what_i_did: 'Done.' },
    state: { answered: false, chosen_index: null, correct: null },
  };
}

function harness({ generate = null } = {}) {
  const persisted = [];
  const events = [];
  const ledger = [];
  const state = { cards: [], studio: null };
  const studio = createStudioService({
    state,
    generate,
    hub: { broadcast: (type, payload) => events.push({ type, payload }) },
    ledger: { append: (entry) => ledger.push(entry) },
    persistence: {
      async saveCards(cards, savedStudio) {
        persisted.push({ cards: cards.map((item) => item.card_id), studio: JSON.parse(JSON.stringify(savedStudio)) });
      },
    },
    clock: () => 1_000,
    id: (() => {
      let number = 0;
      return () => `candidate-${++number}`;
    })(),
  });
  return { events, ledger, persisted, state, studio };
}

test('Studio coalesces candidates at the two-signal watermark and ledgers the merge', async () => {
  const { ledger, state, studio } = harness();

  assert.equal(studio.enqueueReport(report(1)).accepted, true);
  assert.equal(studio.enqueueReport(report(2)).accepted, true);
  assert.equal(studio.enqueueReport(report(3)).accepted, true);
  await studio.whenIdle();

  assert.equal(state.studio.candidates.length, 2);
  assert.deepEqual(state.studio.candidates[0].report_ids, ['report-1', 'report-2']);
  assert.deepEqual(state.studio.candidates[1].report_ids, ['report-3']);
  assert.equal(state.studio.generation.in_flight, false);
  assert.equal(ledger.some((entry) => entry.reason === 'studio-candidate-coalesced'), true);
});

test('Studio keeps an answered Now card stable while a ready buffer lights Next, suppresses a third card, and promotes explicitly', async () => {
  let generated = 0;
  const { events, state, studio } = harness({
    generate: async () => card(++generated),
  });
  studio.enqueueReport(report(1));
  await studio.whenIdle();

  assert.equal(state.studio.current_card_id, 'card-1');
  assert.equal(state.studio.ready_card_id, null);
  state.cards.find((item) => item.card_id === 'card-1').state = { answered: true, chosen_index: 1, correct: false };

  studio.enqueueReport(report(2));
  await studio.whenIdle();

  assert.equal(state.studio.ready_card_id, 'card-2');
  studio.enqueueReport(report(3));
  await studio.whenIdle();

  const readyProjection = studio.projection();
  assert.equal(readyProjection.current.card_id, 'card-1');
  assert.equal(readyProjection.current.state.answered, true);
  assert.equal(readyProjection.current.explanation, 'Explanation 1');
  assert.equal(readyProjection.next_ready, true);
  assert.equal(readyProjection.waiting, null);
  // The third signal remains only as a bounded candidate while Now and the
  // hidden Next occupy the watermark. It never leaks a third card early.
  assert.equal(state.studio.candidates.length, 1);
  assert.deepEqual(state.studio.candidates[0].report_ids, ['report-3']);
  assert.equal(state.cards.some((item) => item.card_id === 'card-3'), false);
  assert.equal(studio.countUnanswered(), 0);
  assert.equal(JSON.stringify(readyProjection).includes('Hidden question 2?'), false);
  assert.equal(JSON.stringify(snapshotFor(state)).includes('Hidden question 2?'), false);
  assert.deepEqual(events.filter((event) => event.type === 'card').map((event) => event.payload.card_id), ['card-1']);

  const advanced = await studio.next();
  assert.deepEqual({ advanced: advanced.advanced, state: advanced.state }, { advanced: true, state: 'advanced' });
  assert.equal(studio.currentCardId(), 'card-2');
  assert.equal(state.studio.ready_card_id, null);
  assert.deepEqual(events.filter((event) => event.type === 'card').map((event) => event.payload.card_id), ['card-1', 'card-2']);
});

test('auto-advance is opt-in and an interaction invalidates a pending automatic advance', async () => {
  let generated = 0;
  const { state, studio } = harness({ generate: async () => card(++generated) });
  studio.enqueueReport(report(1));
  studio.enqueueReport(report(2));
  await studio.whenIdle();

  const token = studio.interactionToken();
  assert.equal(studio.canAutoAdvance({ enabled: true, interaction_token: token }), false);
  state.cards.find((item) => item.card_id === 'card-1').state = { answered: true, chosen_index: 0, correct: true };
  assert.equal(studio.canAutoAdvance({ enabled: false, interaction_token: token }), false);
  assert.equal(studio.canAutoAdvance({ enabled: true, interaction_token: token }), true);
  studio.noteInteraction();
  assert.deepEqual(await studio.next({ auto: true, enabled: true, interaction_token: token }), {
    advanced: false,
    state: 'interaction-paused',
  });
  assert.deepEqual(await studio.next({ auto: true, enabled: false }), {
    advanced: false,
    state: 'auto-advance-disabled',
  });
});

test('restart normalization coalesces an interrupted generation instead of dropping a third source candidate', () => {
  const candidate = (number) => ({
    candidate_id: `candidate-${number}`,
    created_at: `2026-07-19T00:00:0${number}.000Z`,
    report: report(number),
    report_ids: [`report-${number}`],
    updated_at: `2026-07-19T00:00:0${number}.000Z`,
  });
  const restored = normalizeStudioState({
    candidates: [candidate(2), candidate(3)],
    generation: { candidate: candidate(1), in_flight: true, started_at: '2026-07-19T00:00:00.000Z' },
  }, []);

  assert.equal(restored.candidates.length, 2);
  assert.deepEqual(restored.candidates[0].report_ids, ['report-1', 'report-2']);
  assert.deepEqual(restored.candidates[1].report_ids, ['report-3']);
  assert.match(restored.candidates[0].report.task, /Milestone 1.*Milestone 2/);
});
