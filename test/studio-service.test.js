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

function harness({ generate = null, persistCard = null } = {}) {
  const persisted = [];
  const events = [];
  const ledger = [];
  const state = { cards: [], studio: null, strengths: {} };
  const studio = createStudioService({
    state,
    generate,
    persistCard,
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
  const { events, ledger, state, studio } = harness({
    generate: async () => card(++generated),
  });
  studio.enqueueReport(report(1));
  await studio.whenIdle();

  assert.equal(state.studio.current_card_id, 'card-1');
  assert.equal(state.studio.ready_card, null);
  state.cards.find((item) => item.card_id === 'card-1').state = { answered: true, chosen_index: 1, correct: false };

  studio.enqueueReport(report(2));
  await studio.whenIdle();

  assert.equal(state.studio.ready_card.card_id, 'card-2');
  assert.equal(state.cards.some((item) => item.card_id === 'card-2'), false, 'the buffer is the sole hidden-card record');
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
  assert.equal(ledger.some((entry) => (
    entry.card_id === 'card-2'
      && entry.event === 'buffered'
      && entry.reason === 'next-ready'
      && entry.state === 'waiting'
  )), true, 'a hidden Next card is traceable as buffered work, not a visible delivery');
  assert.equal(ledger.some((entry) => entry.card_id === 'card-2' && entry.event === 'delivery'), false);

  const advanced = await studio.next();
  assert.deepEqual({ advanced: advanced.advanced, state: advanced.state }, { advanced: true, state: 'advanced' });
  assert.equal(studio.currentCardId(), 'card-2');
  assert.equal(state.studio.ready_card, null);
  assert.equal(state.cards.some((item) => item.card_id === 'card-2'), true, 'promotion moves the buffered card into lesson history');
  assert.deepEqual(events.filter((event) => event.type === 'card').map((event) => event.payload.card_id), ['card-1', 'card-2']);
  assert.equal(ledger.some((entry) => (
    entry.card_id === 'card-2'
      && entry.event === 'promotion'
      && entry.reason === 'learner-next'
      && entry.state === 'delivered'
  )), true, 'promotion closes the hidden-card delivery trail instead of silently clearing it');
});

test('Studio suppresses a concept mastered while its first generated lesson is waiting for placement', async () => {
  let releaseGeneration;
  const generationBlocked = new Promise((resolve) => { releaseGeneration = resolve; });
  let generationStarted;
  const started = new Promise((resolve) => { generationStarted = resolve; });
  const { ledger, state, studio } = harness({
    generate: async () => {
      generationStarted();
      await generationBlocked;
      return card(1);
    },
  });

  studio.enqueueReport(report(1));
  await started;
  state.strengths['concept-1'] = { strength: 2 };
  releaseGeneration();
  await studio.whenIdle();

  assert.equal(studio.currentCard(), null);
  assert.equal(studio.readyCard(), null);
  assert.equal(state.cards.length, 0);
  assert.equal(ledger.some((entry) => (
    entry.report_id === 'report-1'
      && entry.card_id === 'card-1'
      && entry.event === 'refusal'
      && entry.reason === 'mastered'
      && entry.state === 'suppressed'
  )), true);
  assert.equal(ledger.some((entry) => entry.card_id === 'card-1' && entry.event === 'delivery'), false);
});

test('Studio refuses a mastered concept before it can enter the hidden ready buffer', async () => {
  let generated = 0;
  let releaseReadyGeneration;
  const readyGenerationBlocked = new Promise((resolve) => { releaseReadyGeneration = resolve; });
  let readyGenerationStarted;
  const readyStarted = new Promise((resolve) => { readyGenerationStarted = resolve; });
  const { ledger, state, studio } = harness({
    generate: async () => {
      generated += 1;
      if (generated === 2) {
        readyGenerationStarted();
        await readyGenerationBlocked;
      }
      return card(generated);
    },
  });

  studio.enqueueReport(report(1));
  await studio.whenIdle();
  state.cards[0].state = { answered: true, chosen_index: 1, correct: false };

  studio.enqueueReport(report(2));
  await readyStarted;
  state.strengths['concept-2'] = { strength: 2 };
  releaseReadyGeneration();
  await studio.whenIdle();

  assert.equal(studio.readyCard(), null);
  assert.equal(studio.projection().next_ready, false);
  assert.equal(ledger.some((entry) => (
    entry.report_id === 'report-2'
      && entry.card_id === 'card-2'
      && entry.event === 'refusal'
      && entry.reason === 'mastered'
      && entry.state === 'suppressed'
  )), true);
  assert.equal(ledger.some((entry) => entry.card_id === 'card-2' && entry.event === 'delivery'), false);
});

test('Studio records a mastered suppression when cleanup removes a same-concept hidden lesson', async () => {
  let generated = 0;
  const { ledger, state, studio } = harness({
    generate: async () => {
      const generatedCard = card(++generated);
      if (generated === 2) {
        generatedCard.concept_id = 'concept-1';
        generatedCard.concept_name = 'Concept 1';
      }
      return generatedCard;
    },
  });
  studio.enqueueReport(report(1));
  await studio.whenIdle();
  state.cards[0].state = { answered: true, chosen_index: 0, correct: true };

  studio.enqueueReport(report(2));
  await studio.whenIdle();

  assert.equal(await studio.clearPendingByConcept('concept-1', 'card-1'), 1);
  assert.equal(studio.readyCard(), null);
  assert.equal(ledger.some((entry) => (
    entry.card_id === 'card-2'
      && entry.event === 'refusal'
      && entry.reason === 'mastered'
      && entry.state === 'suppressed'
  )), true);
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

test('legacy ready pointers normalize into one embedded hidden-buffer record', () => {
  const now = card(1);
  now.state = { answered: true, chosen_index: 1, correct: false };
  const next = card(2);
  const restored = normalizeStudioState({
    current_card_id: now.card_id,
    ready_card_id: next.card_id,
  }, [now, next]);

  assert.equal(restored.ready_card?.card_id, next.card_id);
  assert.equal(Object.hasOwn(restored, 'ready_card_id'), false);
  const snapshot = snapshotFor({ cards: [now], studio: restored, strengths: {}, tree: { meta: {}, nodes: [] } });
  assert.equal(snapshot.studio.next_ready, true);
  assert.equal(JSON.stringify(snapshot).includes(next.question), false);
});

test('a reload interleaving cannot orphan a generated ready card from the Studio buffer', async () => {
  let generated = 0;
  let releaseEligibility;
  const eligibilityBlocked = new Promise((resolve) => { releaseEligibility = resolve; });
  let readyEligibilityStarted;
  const readyEligibility = new Promise((resolve) => { readyEligibilityStarted = resolve; });
  const { state, studio } = harness({
    generate: async () => card(++generated),
    persistCard: async (_card, placement) => {
      if (placement === 'ready') {
        readyEligibilityStarted();
        await eligibilityBlocked;
      }
      return true;
    },
  });

  studio.enqueueReport(report(1));
  await studio.whenIdle();
  const now = state.cards.find((item) => item.card_id === 'card-1');
  now.state = { answered: true, chosen_index: 1, correct: false };

  studio.enqueueReport(report(2));
  await readyEligibility;

  // This is the old takeover window: a disk hydration replaces the Studio
  // object while asynchronous delivery eligibility is still pending. The
  // complete hidden card is committed only after that await, so it lands in
  // the replacement Studio object rather than becoming an unseen array card.
  state.cards = [now];
  state.studio = normalizeStudioState({ current_card_id: now.card_id }, state.cards);
  releaseEligibility();
  await studio.whenIdle();

  assert.equal(state.cards.some((item) => item.card_id === 'card-2'), false);
  assert.equal(state.studio.ready_card?.card_id, 'card-2');
  assert.equal(studio.projection().next_ready, true);
  assert.equal(studio.projection().waiting, null);
  const advanced = await studio.next();
  assert.equal(advanced.card.card_id, 'card-2');
  assert.equal(state.studio.ready_card, null);
});
