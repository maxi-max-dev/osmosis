'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRuntimeCard, createTemplateGeneratedCard } = require('../lib/card-factory');
const { createCardService } = require('../lib/card-service');
const { createCurriculumService } = require('../lib/curriculum-service');
const { createProvider } = require('../lib/provider');
const { createReportPipeline } = require('../lib/report-pipeline');

function observedReport(sessionId) {
  return {
    task: `Observed work in ${sessionId}`,
    what_i_did: 'Observed ran node.',
    stack_hints: ['node'],
    source: 'observed',
    session_id: sessionId,
  };
}

function liveCard(conceptId, conceptName) {
  return createRuntimeCard(
    {
      concept_id: conceptId,
      concept_name: conceptName,
      lesson: `A focused lesson about ${conceptName}.`,
      question: `What does ${conceptName} help with?`,
      options: ['The first answer.', 'The second answer.', 'The third answer.'],
      correct_index: 0,
      explanation: `A focused explanation about ${conceptName}.`,
    },
    { task: 'Test delivery', what_i_did: 'Delivered a test lesson.' },
  );
}

function deliveryOptions(harness, card) {
  return {
    beforePersist: () => harness.curriculumService.beforeDelivery(card),
    afterPersisted: () => harness.curriculumService.markDelivered(card.concept_id),
  };
}

function createHarness({ cards = [], generationQueueCap, ledger = null, provider = createProvider({ provider: 'none' }) } = {}) {
  let now = 1_000;
  const waits = [];
  const events = [];
  const delivered = [];
  const state = { cards: [...cards], strengths: {}, tree: { meta: {}, nodes: [] } };
  const hub = { broadcast: (type, payload) => events.push({ at: now, type, payload }) };
  const persistence = { saveCards: async () => {} };
  const cardService = createCardService({ state, hub, persistence });
  const treeService = {
    async ensureInitialTree() {
      throw new Error('the none provider must not attempt to create a project tree');
    },
    async markSurfaced() {
      throw new Error('the none provider must not mark a project tree');
    },
  };
  const originalDeliver = cardService.deliver;
  cardService.deliver = async (card, options) => {
    const result = await originalDeliver(card, options);
    if (result.delivered) {
      delivered.push({ card, at: now });
    }
    return result;
  };
  const config = {
    mode: 'live',
    cardPacingMs: 12_000,
    unansweredCardCap: 5,
    generationQueueCap,
  };
  const curriculumService = createCurriculumService({
    config,
    hub,
    provider,
    state,
    treeService,
    clock: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  });
  cardService.setRequeueDeliveryGate({
    beforeDelivery: curriculumService.beforeDelivery,
    afterDelivered: (card) => curriculumService.markDelivered(card.concept_id),
  });
  const replayService = {
    async record() {},
    consume() {
      return null;
    },
  };
  const pipeline = createReportPipeline({
    cardService,
    config,
    curriculumService,
    hub,
    ledger,
    provider,
    replayService,
    state,
  });

  return { cardService, curriculumService, delivered, events, pipeline, state, waits };
}

test('observations from separate sessions share one none-provider pacing clock and five-card cap', async () => {
  const harness = createHarness();

  // These reports model independent rollout files arriving at the same time.
  // The pipeline deliberately has no per-session state, so all five compete
  // for the same wall-wide pacing and unanswered-card budget.
  const accepted = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e', 'session-f'].map((sessionId) =>
    harness.pipeline.accept(observedReport(sessionId)),
  );
  assert.deepEqual(accepted, [true, true, true, true, true, false]);

  await harness.pipeline.whenIdle();

  assert.equal(harness.delivered.length, 5);
  assert.deepEqual(
    harness.delivered.map((entry) => entry.at),
    [1_000, 13_000, 25_000, 37_000, 49_000],
  );
  assert.deepEqual(harness.waits, [12_000, 12_000, 12_000, 12_000]);

  // Once five unanswered cards are on the one project wall, a report from a
  // seventh independent session is refused before template generation.
  assert.equal(harness.pipeline.accept(observedReport('session-g')), false);
  assert.equal(harness.pipeline.recentReports().length, 5);
  assert.equal(harness.events.some((event) => event.payload.state === 'queue-full'), true);
});

test('the generation queue remains bounded while a provider is still working', async () => {
  let releaseFirstGeneration;
  let calls = 0;
  const provider = {
    name: 'none',
    supportsLiveCurriculum: false,
    isSlow: false,
    async generateCard() {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => {
          releaseFirstGeneration = resolve;
        });
      }
      return {
        concept_id: 'feedback-loop',
        concept_name: 'The feedback loop',
        lesson: 'A feedback loop turns completed work into a quick chance to learn why that work matters.',
        question: 'What does a feedback loop create?',
        options: ['A short learning moment.', 'A new database.', 'A deleted project.'],
        correct_index: 0,
        explanation: 'It creates a timely learning moment.',
      };
    },
  };
  const harness = createHarness({ generationQueueCap: 2, provider });

  assert.equal(harness.pipeline.accept(observedReport('session-a')), true);
  // Let the first generation enter the provider before adding reports from
  // other sessions. One active item plus one waiting item is the hard limit.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.pipeline.accept(observedReport('session-b')), true);
  assert.equal(harness.pipeline.accept(observedReport('session-c')), false);

  releaseFirstGeneration();
  await harness.pipeline.whenIdle();

  assert.equal(calls, 2);
  assert.equal(harness.delivered.length, 2);
});

test('pending reports reserve the remaining global unanswered-card slots', async () => {
  const existingCards = Array.from({ length: 4 }, (_, index) => ({
    card_id: `existing-${index}`,
    concept_id: `existing-${index}`,
    state: { answered: false },
  }));
  const harness = createHarness({ cards: existingCards });

  assert.equal(harness.pipeline.accept(observedReport('session-a')), true);
  assert.equal(harness.pipeline.accept(observedReport('session-b')), false);
  await harness.pipeline.whenIdle();

  assert.equal(harness.delivered.length, 1);
  assert.equal(harness.state.cards.filter((card) => !card.state.answered).length, 5);
});

test('a template starter and an observed none-provider report share one serial pacing gate', async () => {
  const harness = createHarness();
  const starter = createRuntimeCard(createTemplateGeneratedCard());

  const starterDelivery = harness.cardService.deliver(starter, deliveryOptions(harness, starter));
  assert.equal(harness.pipeline.accept(observedReport('session-after-starter')), true);
  await Promise.all([starterDelivery, harness.pipeline.whenIdle()]);

  assert.deepEqual(
    harness.delivered.map((entry) => entry.at),
    [1_000, 13_000],
  );
  assert.deepEqual(harness.waits, [12_000]);
});

test('eligible reviews also wait behind the project-wide delivery pace', async () => {
  const harness = createHarness();
  const original = liveCard('review-topic', 'Review topic');
  const second = liveCard('second-topic', 'Second topic');
  const third = liveCard('third-topic', 'Third topic');

  await harness.cardService.deliver(original, deliveryOptions(harness, original));
  original.state = { answered: true, chosen_index: 1, correct: false };
  harness.cardService.queueRequeue(original);
  await harness.cardService.deliver(second, deliveryOptions(harness, second));
  await harness.cardService.deliver(third, deliveryOptions(harness, third));

  const cardEvents = harness.events.filter((event) => event.type === 'card');
  assert.deepEqual(
    cardEvents.map((event) => event.at),
    [1_000, 13_000, 25_000, 37_000],
  );
  assert.equal(cardEvents.at(-1).payload.concept_id, 'review-topic');
  assert.deepEqual(harness.waits, [12_000, 12_000, 12_000]);
});

test('report traces retain one report id through delivery, refusal, and provider failure', async () => {
  const deliveredTrace = [];
  const delivered = createHarness({ ledger: { append: (entry) => deliveredTrace.push(entry) } });
  assert.equal(delivered.pipeline.accept(observedReport('delivered')), true);
  await delivered.pipeline.whenIdle();
  assert.deepEqual(
    deliveredTrace.map((entry) => [entry.event, entry.state]),
    [
      ['accept', 'observed'],
      ['provider-result', 'observed'],
      ['delivery', 'delivered'],
    ],
  );
  const deliveredId = deliveredTrace[0].report_id;
  assert.equal(deliveredTrace.every((entry) => entry.report_id === deliveredId), true);
  assert.equal(delivered.delivered[0].card.source.report_id, deliveredId);

  const refusalTrace = [];
  const full = createHarness({
    cards: Array.from({ length: 5 }, (_, index) => ({ card_id: `pending-${index}`, concept_id: `pending-${index}`, state: { answered: false } })),
    ledger: { append: (entry) => refusalTrace.push(entry) },
  });
  assert.equal(full.pipeline.accept(observedReport('full')), false);
  assert.deepEqual(
    refusalTrace.map((entry) => [entry.event, entry.state]),
    [
      ['accept', 'observed'],
      ['refusal', 'waiting'],
    ],
  );

  const failureTrace = [];
  const failing = createHarness({
    ledger: { append: (entry) => failureTrace.push(entry) },
    provider: {
      name: 'failing-provider',
      supportsLiveCurriculum: false,
      isSlow: false,
      async generateCard() {
        throw new Error('intentional provider failure');
      },
    },
  });
  assert.equal(failing.pipeline.accept(observedReport('failure')), true);
  await failing.pipeline.whenIdle();
  assert.deepEqual(
    failureTrace.map((entry) => [entry.event, entry.state]),
    [
      ['accept', 'observed'],
      ['failure', 'failed'],
    ],
  );
  assert.equal(failing.events.some((event) => event.type === 'status' && event.payload.state === 'failed'), true);
});

test('Studio generation returns terminal metadata without bypassing the Studio ledger outbox', async () => {
  const directLedger = [];
  const failing = createHarness({
    ledger: { append: (entry) => directLedger.push(entry) },
    provider: {
      name: 'failing-provider',
      supportsLiveCurriculum: false,
      isSlow: false,
      async generateCard() {
        throw new Error('intentional Studio provider failure');
      },
    },
  });
  const outcome = await failing.pipeline.generateForStudio({
    ...observedReport('studio-failure'),
    report_id: 'studio-failure-report',
  });

  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.reason, 'generation-failed');
  assert.equal(directLedger.length, 0, 'only Studio may write the terminal failure after its state/outbox persistence');
  assert.equal(outcome.status.state, 'failed');
});
