'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAnswerService } = require('../lib/answer-service');
const { createRuntimeCard } = require('../lib/card-factory');
const { createCardService } = require('../lib/card-service');

function generatedCard(conceptId, conceptName) {
  return {
    concept_id: conceptId,
    concept_name: conceptName,
    lesson: `A short lesson about ${conceptName}.`,
    question: `What is ${conceptName}?`,
    options: ['The first answer.', 'The second answer.', 'The third answer.'],
    correct_index: 0,
    explanation: `A short explanation about ${conceptName}.`,
  };
}

function runtimeCard(cardId, conceptId = 'feedback-loop', conceptName = 'The feedback loop') {
  return {
    ...createRuntimeCard(generatedCard(conceptId, conceptName), {
      task: 'Test milestone',
      what_i_did: 'Created a focused test lesson.',
    }),
    card_id: cardId,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness({ cards, strengths }) {
  const state = {
    cards,
    strengths,
    tree: { meta: {}, nodes: [] },
  };
  const events = [];
  const savedCards = [];
  const savedProfiles = [];
  const hub = {
    broadcast(type, payload) {
      events.push({ type, payload: clone(payload) });
    },
  };
  const persistence = {
    async saveCards(nextCards) {
      savedCards.push(clone(nextCards));
    },
    async saveProfile(nextStrengths) {
      savedProfiles.push(clone(nextStrengths));
    },
  };
  const cardService = createCardService({ state, hub, persistence });
  const answerService = createAnswerService({ state, hub, persistence, cardService });

  return { answerService, cardService, events, savedCards, savedProfiles, state };
}

test('runtime cards retain patch/activity provenance and default older reports to agent provenance', () => {
  const observedChange = createRuntimeCard(generatedCard('ambient-watch', 'Ambient Watch'), {
    task: 'Observed local change',
    what_i_did: 'Changed a Three.js scene file.',
    source: 'observed',
    observed_kind: 'change',
  });
  const observedActivity = createRuntimeCard(generatedCard('terminal', 'Terminal'), {
    task: 'Observed local activity',
    what_i_did: 'Ran node.',
    source: 'observed',
  });
  const agent = createRuntimeCard(generatedCard('mcp', 'MCP'), {
    task: 'Reported milestone',
    what_i_did: 'Connected the report tool.',
  });

  assert.deepEqual(observedChange.source, {
    task: 'Observed local change',
    what_i_did: 'Changed a Three.js scene file.',
    kind: 'observed-change',
  });
  assert.deepEqual(observedActivity.source, {
    task: 'Observed local activity',
    what_i_did: 'Ran node.',
    kind: 'observed-activity',
  });
  assert.deepEqual(agent.source, {
    task: 'Reported milestone',
    what_i_did: 'Connected the report tool.',
    kind: 'agent',
  });
});

test('a stale wrong answer cannot lower mastered strength or create another review card', async () => {
  const staleCard = runtimeCard('stale-card');
  const harness = createHarness({
    cards: [staleCard],
    strengths: {
      'feedback-loop': {
        name: 'The feedback loop',
        strength: 2,
        seen: 1,
        correct: 1,
        updated_at: '2026-07-18T00:00:00.000Z',
      },
    },
  });

  const result = await harness.answerService.answer({ card_id: staleCard.card_id, chosen_index: 1 });

  assert.deepEqual(result, {
    correct: false,
    explanation: staleCard.explanation,
    strength: 2,
  });
  assert.equal(harness.state.strengths['feedback-loop'].strength, 2);
  assert.equal(harness.savedProfiles.at(-1)['feedback-loop'].strength, 2);
  assert.equal(harness.savedProfiles.at(-1)['feedback-loop'].updated_at, '2026-07-18T00:00:00.000Z');

  await harness.cardService.deliver(runtimeCard('other-one', 'http', 'HTTP'));
  await harness.cardService.deliver(runtimeCard('other-two', 'sse', 'Server-sent events'));
  assert.equal(harness.state.cards.filter((card) => card.concept_id === 'feedback-loop').length, 1);
});

test('a correct answer removes same-concept pending cards and queued reviews', async () => {
  const correctCard = runtimeCard('correct-card');
  const pendingSameConcept = runtimeCard('pending-same');
  const pendingOtherConcept = runtimeCard('pending-other', 'http', 'HTTP');
  const harness = createHarness({
    cards: [correctCard, pendingSameConcept, pendingOtherConcept],
    strengths: {},
  });
  harness.cardService.queueRequeue(pendingSameConcept);

  const result = await harness.answerService.answer({ card_id: correctCard.card_id, chosen_index: 0 });

  assert.equal(result.strength, 2);
  assert.deepEqual(
    harness.state.cards.map((card) => card.card_id),
    ['correct-card', 'pending-other'],
  );
  assert.deepEqual(
    harness.savedCards.at(-1).map((card) => card.card_id),
    ['correct-card', 'pending-other'],
  );
  const removalSnapshot = harness.events.find((event) => event.type === 'snapshot');
  assert.deepEqual(
    removalSnapshot.payload.cards.map((card) => card.card_id),
    ['correct-card', 'pending-other'],
  );

  await harness.cardService.deliver(runtimeCard('other-one', 'sse', 'Server-sent events'));
  await harness.cardService.deliver(runtimeCard('other-two', 'dom', 'The document tree'));
  assert.equal(harness.state.cards.filter((card) => card.concept_id === 'feedback-loop').length, 1);
});

test('a queued review is checked again before delivery when mastery changes', async () => {
  const reviewCard = runtimeCard('review-card');
  const harness = createHarness({
    cards: [],
    strengths: {
      'feedback-loop': {
        name: 'The feedback loop',
        strength: 1,
        seen: 1,
        correct: 0,
        updated_at: '2026-07-18T00:00:00.000Z',
      },
    },
  });
  harness.cardService.queueRequeue(reviewCard);
  harness.state.strengths['feedback-loop'].strength = 2;

  await harness.cardService.deliver(runtimeCard('other-one', 'http', 'HTTP'));
  await harness.cardService.deliver(runtimeCard('other-two', 'sse', 'Server-sent events'));

  assert.equal(harness.state.cards.some((card) => card.concept_id === 'feedback-loop'), false);
  assert.equal(harness.events.some((event) => event.type === 'card' && event.payload.concept_id === 'feedback-loop'), false);
});
