'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeStudioState, studioSnapshot } = require('../lib/state');
const { createAnswerService } = require('../lib/answer-service');
const { createStudioService } = require('../lib/studio-service');
const { makeWarmupCandidate, matchesForWarmupEvent } = require('../lib/warmup-catalog');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function warmup(id, epoch = 'epoch-a') {
  const match = matchesForWarmupEvent({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: JSON.stringify({ cmd: 'rg --files' }),
    },
  })[0];
  return makeWarmupCandidate(match, {
    activity_epoch_id: epoch,
    observation_id: `observation-${epoch}`,
    warmup_id: id,
  });
}

function realCard(id, concept = 'true-concept') {
  return {
    card_id: id,
    concept_id: concept,
    concept_name: '真实概念',
    correct_index: 0,
    explanation: '这是解释。',
    lesson: '这是一段真实课程。',
    options: ['第一项。', '第二项。', '第三项。'],
    question: '这是哪一项？',
    source: { kind: 'observed-activity', report_id: `report-${id}`, task: 'Observed', what_i_did: 'Observed safely.' },
    state: { answered: false, chosen_index: null, correct: null },
  };
}

function observedReport(epoch) {
  return {
    activity_epoch_id: epoch,
    report_id: `report-${epoch}`,
    source: 'observed',
    stack_hints: ['rg'],
    task: 'Observed local activity',
    what_i_did: 'Observed safe local activity.',
  };
}

function harness({ state = { cards: [], strengths: {}, studio: null }, ledger = null, transitionHook = null, generate = null } = {}) {
  let latest = null;
  const events = [];
  const entries = [];
  const idempotent = ledger || {
    seen: new Set(),
    async appendIdempotent(entry) {
      if (this.seen.has(entry.outbox_id)) return { ...entry, duplicate: true };
      this.seen.add(entry.outbox_id);
      entries.push(clone(entry));
      return clone(entry);
    },
  };
  const studio = createStudioService({
    state,
    hub: { broadcast(type, payload) { events.push({ payload: clone(payload), type }); } },
    ledger: idempotent,
    persistence: {
      async saveCards(cards, savedStudio) {
        latest = { cards: clone(cards), studio: clone(savedStudio) };
      },
    },
    ...(typeof generate === 'function' ? { generate } : {}),
    transitionHook,
  });
  return {
    entries,
    events,
    ledger: idempotent,
    latest: () => clone(latest),
    state,
    studio,
  };
}

test('Studio snapshots preserve real, warmup, and explicit empty Now states without leaking a warmup answer', () => {
  const visibleWarmup = warmup('warmup-snapshot');
  const warmupState = normalizeStudioState({
    current_warmup: visibleWarmup,
    now: { kind: 'warmup', card_ref: visibleWarmup.warmup_id },
  }, []);
  const warmupSnapshot = studioSnapshot(warmupState, []);
  assert.deepEqual(warmupSnapshot.now, { kind: 'warmup', card_ref: 'warmup-snapshot' });
  assert.equal(warmupSnapshot.current_warmup.warmup_id, 'warmup-snapshot');
  assert.equal(warmupSnapshot.current.correct_index, undefined);
  assert.equal(warmupSnapshot.current_warmup.correct_index, undefined);

  const real = realCard('real-snapshot');
  const realState = normalizeStudioState({
    current_card_id: real.card_id,
    now: { kind: 'real', card_ref: real.card_id },
  }, [real]);
  assert.deepEqual(studioSnapshot(realState, [real]).now, { kind: 'real', card_ref: real.card_id });

  const emptyState = normalizeStudioState({
    current_card_id: real.card_id,
    now: { kind: null, card_ref: null },
  }, [real]);
  const emptySnapshot = studioSnapshot(emptyState, [real]);
  assert.deepEqual(emptySnapshot.now, { kind: null, card_ref: null });
  assert.equal(emptySnapshot.current, null, 'an explicit empty Now never revives a legacy pointer');
});

test('a persisted Studio recovers each authoritative Now variant after a restart', async () => {
  const warmupOwner = harness();
  await warmupOwner.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-recover-warmup',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-recover-warmup:search-with-rg',
    observation_id: 'observation-recover-warmup',
    report: observedReport('epoch-recover-warmup'),
    warmup: warmup('warmup-recover', 'epoch-recover-warmup'),
  });
  const warmupRecovery = harness({ state: warmupOwner.latest() });
  assert.deepEqual(warmupRecovery.studio.projection().now, { kind: 'warmup', card_ref: 'warmup-recover' });
  assert.equal(warmupRecovery.studio.projection().current_warmup.warmup_id, 'warmup-recover');
  assert.equal(warmupRecovery.studio.projection().current_warmup.correct_index, undefined);

  const realOwner = harness();
  await realOwner.studio.acceptGenerated({
    activity_epoch_id: 'epoch-recover-real',
    candidate_id: 'candidate-recover-real',
    report: observedReport('epoch-recover-real'),
  }, realCard('real-recover', 'recover-concept'));
  const realRecovery = harness({ state: realOwner.latest() });
  assert.deepEqual(realRecovery.studio.projection().now, { kind: 'real', card_ref: 'real-recover' });
  assert.equal(realRecovery.studio.projection().current.card_id, 'real-recover');
  assert.equal(realRecovery.studio.projection().current_warmup, null);

  const emptyOwner = harness({
    state: {
      cards: [],
      strengths: {},
      studio: { now: { kind: null, card_ref: null } },
    },
  });
  await emptyOwner.studio.recordWarmupSuppression({
    activity_epoch_id: 'epoch-recover-empty',
    observation_id: 'observation-recover-empty',
    reason: 'trigger-not-allowlisted',
  });
  const emptyRecovery = harness({ state: emptyOwner.latest() });
  assert.deepEqual(emptyRecovery.studio.projection().now, { kind: null, card_ref: null });
  assert.equal(emptyRecovery.studio.projection().current, null);
  assert.equal(emptyRecovery.studio.projection().current_warmup, null);
});

test('a warmup persists its observed-to-preparing activity phase with the observation id through a reconnect', async () => {
  let releaseGeneration;
  const h = harness({
    generate: () => new Promise((resolve) => {
      releaseGeneration = resolve;
    }),
  });
  await h.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-progress',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-progress:search-with-rg',
    observation_id: 'observation-progress',
    report: observedReport('epoch-progress'),
    warmup: warmup('warmup-progress', 'epoch-progress'),
  });

  assert.deepEqual(h.studio.projection().progress, {
    phase: 'observed',
    observation_id: 'observation-progress',
    reason: 'warmup-eligible',
    updated_at: h.studio.projection().progress.updated_at,
  });
  const starting = h.studio.pump();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(h.studio.projection().progress, {
    phase: 'preparing',
    observation_id: 'observation-progress',
    reason: 'formal-lesson',
    updated_at: h.studio.projection().progress.updated_at,
  });
  assert.equal(
    h.events.some((event) => event.type === 'studio' && event.payload.progress?.phase === 'preparing'),
    true,
    'the live Studio SSE projection exposes the same durable phase',
  );

  const reconnect = harness({ state: h.latest() });
  assert.equal(reconnect.studio.projection().progress?.phase, 'preparing');
  assert.equal(reconnect.studio.projection().progress?.observation_id, 'observation-progress');
  assert.equal(reconnect.studio.projection().progress?.reason, 'formal-lesson');

  releaseGeneration({ state: 'suppressed', reason: 'generation-failed' });
  await starting;
});

test('fast-path SSE and reconnect presentation phases stay monotonic from observed to idle', async () => {
  let releaseGeneration;
  const h = harness({
    generate: () => new Promise((resolve) => {
      releaseGeneration = resolve;
    }),
  });
  const request = {
    activity_epoch_id: 'epoch-monotonic',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-monotonic:search-with-rg',
    observation_id: 'observation-monotonic',
    report: observedReport('epoch-monotonic'),
    warmup: warmup('warmup-monotonic', 'epoch-monotonic'),
  };
  const reconnectedPhase = () => {
    const persisted = h.latest();
    return studioSnapshot(normalizeStudioState(persisted.studio, persisted.cards), persisted.cards).presentation.phase;
  };

  await h.studio.onWarmupCandidate(request);
  assert.equal(reconnectedPhase(), 'observed', 'an atomic observed+warmup commit never claims the true lesson is already ready');

  const generating = h.studio.pump();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reconnectedPhase(), 'preparing', 'the paired true-card generation advances monotonically after the warmup is visible');

  releaseGeneration({ state: 'generated', card: realCard('real-monotonic', 'search-with-rg') });
  await generating;
  assert.equal(reconnectedPhase(), 'card-ready');

  const answer = createAnswerService({
    cardService: { clearPendingByConcept: () => 0, persistCards: async () => {} },
    hub: { broadcast() {} },
    persistence: { saveProfile: async () => {} },
    state: h.state,
    studio: h.studio,
  });
  await answer.answer({ card_id: 'real-monotonic', chosen_index: 0 });
  await h.studio.whenIdle();
  assert.equal(reconnectedPhase(), 'idle', 'a correct real-card answer completes the visible activity episode');

  const visiblePhases = h.events
    .filter((event) => event.type === 'studio')
    .map((event) => event.payload.presentation?.phase)
    .filter(Boolean);
  assert.deepEqual(visiblePhases, ['observed', 'preparing', 'card-ready', 'idle']);
});

test('only a same-epoch real card replaces an untouched warmup; an unrelated card remains Next', async () => {
  const h = harness();
  const served = await h.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-a',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session:search-with-rg',
    observation_id: 'observation-epoch-a',
    report: observedReport('epoch-a'),
    warmup: warmup('warmup-a', 'epoch-a'),
  });
  assert.equal(served.state, 'warmup-served');
  assert.equal(h.state.studio.now.kind, 'warmup');
  assert.equal(h.state.cards.length, 0);
  assert.deepEqual(
    h.state.studio.candidates.map((candidate) => candidate.activity_epoch_id),
    ['epoch-a'],
    'the paired true-card candidate is created in the same transition, without waiting for ambient aggregation',
  );

  await h.studio.acceptGenerated({
    activity_epoch_id: 'epoch-other',
    candidate_id: 'candidate-other',
    report: observedReport('epoch-other'),
  }, realCard('real-other', 'other-concept'));
  assert.equal(h.state.studio.now.kind, 'warmup');
  assert.equal(h.state.studio.ready_card.card_id, 'real-other');

  await h.studio.acceptGenerated({
    activity_epoch_id: 'epoch-a',
    candidate_id: 'candidate-a',
    report: observedReport('epoch-a'),
  }, realCard('real-a', 'search-with-rg'));
  assert.deepEqual(h.state.studio.now, { kind: 'real', card_ref: 'real-a' });
  assert.equal(h.state.studio.ready_card.card_id, 'real-other', 'the unrelated real lesson stays in Next');
  assert.equal(h.state.studio.current_warmup, null);
  assert.equal(h.state.studio.warmup_history[0].warmup_id, 'warmup-a');
  assert.deepEqual(
    h.entries.map((entry) => entry.event).filter((event) => ['observed', 'warmup_served', 'warmup_replaced', 'delivery'].includes(event)),
    ['observed', 'warmup_served', 'warmup_replaced', 'delivery'],
  );
  await assert.rejects(
    h.studio.answerWarmup({ card_id: 'warmup-a', chosen_index: 0 }),
    (error) => error?.statusCode === 409,
  );
});

test('a same-epoch true card with another canonical concept cannot replace the warmup', async () => {
  const h = harness();
  await h.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-canonical',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-canonical:search-with-rg',
    observation_id: 'observation-epoch-canonical',
    report: observedReport('epoch-canonical'),
    warmup: warmup('warmup-canonical', 'epoch-canonical'),
  });

  await h.studio.acceptGenerated({
    activity_epoch_id: 'epoch-canonical',
    candidate_id: 'candidate-canonical-mismatch',
    report: observedReport('epoch-canonical'),
  }, realCard('real-canonical-mismatch', 'feedback-loop'));

  assert.deepEqual(h.state.studio.now, { kind: 'warmup', card_ref: 'warmup-canonical' });
  assert.equal(h.state.studio.current_warmup.concept_id, 'search-with-rg');
  assert.equal(h.state.studio.ready_card.card_id, 'real-canonical-mismatch');
  assert.equal(h.state.studio.ready_card.concept_id, 'feedback-loop');
  assert.equal(
    h.entries.some((entry) => entry.event === 'warmup_replaced' && entry.activity_epoch_id === 'epoch-canonical'),
    false,
  );
});

test('a full real-generation queue does not suppress an otherwise eligible local warmup in an empty Now', async () => {
  const h = harness();
  const first = h.studio.enqueueReport(observedReport('epoch-buffer-one'));
  const second = h.studio.enqueueReport(observedReport('epoch-buffer-two'));
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  await Promise.all([first.done, second.done]);
  assert.equal(h.state.studio.candidates.length, 2, 'the true-card queue is genuinely at its bounded ceiling');
  assert.deepEqual(h.state.studio.now, { kind: null, card_ref: null });

  const result = await h.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-buffered-warmup',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-buffered-warmup:search-with-rg',
    observation_id: 'observation-buffered-warmup',
    report: observedReport('epoch-buffered-warmup'),
    warmup: warmup('warmup-buffered', 'epoch-buffered-warmup'),
  });

  assert.equal(result.state, 'warmup-served');
  assert.deepEqual(h.state.studio.now, { kind: 'warmup', card_ref: 'warmup-buffered' });
  assert.equal(h.state.studio.current_warmup.warmup_id, 'warmup-buffered');
  assert.equal(
    h.entries.some((entry) => entry.observation_id === 'observation-buffered-warmup' && entry.event === 'warmup_suppressed'),
    false,
    'a local card must not be relabeled as a rate-limited suppression merely because its paired generator candidate is full',
  );
});

test('a second fast epoch beyond the one deferred true-card slot is rate-limited instead of serving an orphaned warmup', async () => {
  function retainedCandidate(id, epoch) {
    return {
      activity_epoch_id: epoch,
      candidate_id: id,
      created_at: '2026-07-19T00:00:00.000Z',
      report: observedReport(epoch),
      report_ids: [`report-${epoch}`],
      updated_at: '2026-07-19T00:00:00.000Z',
    };
  }

  const h = harness();
  h.state.studio.candidates = [
    retainedCandidate('candidate-existing-a', 'epoch-existing-a'),
    retainedCandidate('candidate-existing-b', 'epoch-existing-b'),
  ];
  h.state.studio.deferred_epoch_candidate = retainedCandidate('candidate-deferred-a', 'epoch-deferred-a');
  assert.deepEqual(h.state.studio.now, { kind: null, card_ref: null });

  const result = await h.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-overflow',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-overflow:search-with-rg',
    observation_id: 'observation-overflow',
    report: observedReport('epoch-overflow'),
    warmup: warmup('warmup-overflow', 'epoch-overflow'),
  });

  assert.equal(result.accepted, false);
  assert.equal(result.committed, true);
  assert.equal(result.reason, 'rate-limited');
  assert.equal(result.state, 'suppressed');
  assert.deepEqual(h.state.studio.now, { kind: null, card_ref: null });
  assert.equal(h.state.studio.current_warmup, null);
  assert.equal(h.state.studio.deferred_epoch_candidate.candidate_id, 'candidate-deferred-a');
  assert.equal(
    [...h.state.studio.candidates, h.state.studio.deferred_epoch_candidate]
      .some((candidate) => candidate?.activity_epoch_id === 'epoch-overflow'),
    false,
    'the product never shows a warmup if it cannot retain that epoch\'s paired true-card request',
  );
  assert.equal(
    h.entries.some((entry) => (
      entry.event === 'warmup_suppressed'
      && entry.observation_id === 'observation-overflow'
      && entry.reason === 'rate-limited'
    )),
    true,
  );
});

test('restart recovery never coalesces distinct activity epochs into a mismatched true-card candidate', () => {
  function candidate(id, epoch) {
    return {
      activity_epoch_id: epoch,
      candidate_id: id,
      created_at: '2026-07-19T00:00:00.000Z',
      report: observedReport(epoch),
      report_ids: [`report-${epoch}`],
      updated_at: '2026-07-19T00:00:00.000Z',
    };
  }

  const restored = normalizeStudioState({
    candidates: [candidate('candidate-b', 'epoch-b'), candidate('candidate-c', 'epoch-c')],
    deferred_epoch_candidate: candidate('candidate-deferred', 'epoch-deferred'),
    generation: {
      candidate: candidate('candidate-a', 'epoch-a'),
      in_flight: true,
      started_at: '2026-07-19T00:00:00.000Z',
    },
  }, []);

  assert.deepEqual(
    restored.candidates.map((item) => [item.candidate_id, item.activity_epoch_id, item.report.report_id]),
    [
      ['candidate-a', 'epoch-a', 'report-epoch-a'],
      ['candidate-b', 'epoch-b', 'report-epoch-b'],
    ],
  );
  assert.equal(restored.candidates.some((item) => item.report.task.includes('·')), false, 'epoch reports are never aggregated on recovery');
  assert.deepEqual(
    [
      restored.deferred_epoch_candidate.candidate_id,
      restored.deferred_epoch_candidate.activity_epoch_id,
      restored.deferred_epoch_candidate.report.report_id,
    ],
    ['candidate-deferred', 'epoch-deferred', 'report-epoch-deferred'],
    'a deferred fast-path true-card request also survives restart without losing its epoch association',
  );
});

test('every public warmup suppression reason is durable in the activity trace', async () => {
  const h = harness();
  const reasons = [
    'learning-paused',
    'project-unregistered',
    'project-uncarried',
    'catalog-invalid',
    'trigger-not-allowlisted',
    'mastered',
    'current-real',
    'current-warmup',
    'next-ready',
    'rate-limited',
    'epoch-duplicate',
  ];
  for (const [index, reason] of reasons.entries()) {
    const result = await h.studio.recordWarmupSuppression({
      activity_epoch_id: `epoch-suppression-${index}`,
      concept_id: reason === 'catalog-invalid' || reason === 'trigger-not-allowlisted' ? '' : 'search-with-rg',
      observation_id: `observation-suppression-${index}`,
      reason,
    });
    assert.equal(result.reason, reason);
    assert.equal(result.committed, true);
  }
  assert.deepEqual(
    h.entries.filter((entry) => entry.event === 'warmup_suppressed').map((entry) => entry.reason),
    reasons,
  );
});

test('answering a warmup does not touch mastery and blocks same-epoch replacement', async () => {
  const strengths = { existing: { strength: 2 } };
  const tree = {
    meta: { surfaced_concept_ids: ['existing'] },
    nodes: [{ concept_id: 'existing', concept_name: 'Existing', parent_id: null }],
  };
  const treeBefore = clone(tree);
  const h = harness({ state: { cards: [], strengths, studio: null, tree } });
  await h.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-answer',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-answer:search-with-rg',
    observation_id: 'observation-epoch-answer',
    report: observedReport('epoch-answer'),
    warmup: warmup('warmup-answer', 'epoch-answer'),
  });
  const result = await h.studio.answerWarmup({ card_id: 'warmup-answer', chosen_index: 0 });
  assert.deepEqual(result, { correct: true, explanation: h.state.studio.current_warmup.explanation, warmup: true });
  assert.deepEqual(strengths, { existing: { strength: 2 } });
  assert.deepEqual(h.state.tree, treeBefore, 'a warmup never mutates the real learning tree');
  assert.equal(h.state.cards.length, 0, 'a warmup never enters the real card history');

  await h.studio.acceptGenerated({
    activity_epoch_id: 'epoch-answer',
    candidate_id: 'candidate-answer',
    report: observedReport('epoch-answer'),
  }, realCard('real-answer', 'answer-concept'));
  assert.equal(h.state.studio.now.kind, 'warmup');
  assert.equal(h.state.studio.ready_card.card_id, 'real-answer');
  assert.equal(h.state.studio.current_warmup.state.answered, true);

  assert.deepEqual(
    await h.studio.next({ auto: true, enabled: true }),
    { advanced: false, state: 'auto-advance-current-not-real' },
    'an answered warmup can only advance when the learner deliberately asks for Next',
  );
  const advanced = await h.studio.next();
  assert.equal(advanced.advanced, true);
  assert.deepEqual(h.state.studio.now, { kind: 'real', card_ref: 'real-answer' });
  assert.equal(h.state.studio.warmup_history.at(-1).warmup_id, 'warmup-answer');
  const recovered = harness({ state: h.latest() });
  assert.equal(recovered.state.studio.warmup_history.at(-1).warmup_id, 'warmup-answer', 'an archived warmup remains durable for trace reconciliation after restart');
});

test('the frozen two-key answer service routes only the active warmup and returns 409 after it leaves Now', async () => {
  const strengths = { carried: { strength: 2 } };
  const h = harness({ state: { cards: [], strengths, studio: null } });
  await h.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-route-answer',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-route-answer:search-with-rg',
    observation_id: 'observation-epoch-route-answer',
    report: observedReport('epoch-route-answer'),
    warmup: warmup('warmup-route-answer', 'epoch-route-answer'),
  });
  let profileWrites = 0;
  const answer = createAnswerService({
    cardService: { clearPendingByConcept: () => 0, persistCards: async () => {} },
    hub: { broadcast() {} },
    persistence: { saveProfile: async () => { profileWrites += 1; } },
    state: h.state,
    studio: h.studio,
  });

  const response = await answer.answer({ card_id: 'warmup-route-answer', chosen_index: 0 });
  assert.equal(response.warmup, true);
  assert.equal(response.correct, true);
  assert.deepEqual(strengths, { carried: { strength: 2 } }, 'a warmup answer has no profile side effect');
  assert.equal(profileWrites, 0, 'the warmup route must not call the shared profile persistence path');

  await h.studio.acceptGenerated({
    activity_epoch_id: 'epoch-route-answer',
    candidate_id: 'candidate-route-answer',
    report: observedReport('epoch-route-answer'),
  }, realCard('real-route-answer', 'route-answer-concept'));
  assert.equal((await h.studio.next()).advanced, true);
  await assert.rejects(
    answer.answer({ card_id: 'warmup-route-answer', chosen_index: 0 }),
    (error) => error?.statusCode === 409,
  );
});

test('warmup session dedupe survives a persisted restart and leaves an honest epoch-duplicate trace', async () => {
  const first = harness();
  const request = {
    activity_epoch_id: 'epoch-session-dedupe-a',
    concept_id: 'search-with-rg',
    dedupe_key: 'project-a:rollout-hash:search-with-rg',
    observation_id: 'observation-session-dedupe-a',
    report: observedReport('epoch-session-dedupe-a'),
    warmup: warmup('warmup-session-dedupe-a', 'epoch-session-dedupe-a'),
  };
  assert.equal((await first.studio.onWarmupCandidate(request)).state, 'warmup-served');
  const sameEpochAggregate = first.studio.enqueueReport(observedReport('epoch-session-dedupe-a'));
  assert.equal(sameEpochAggregate.accepted, false, 'the old 45-second aggregation path cannot enqueue a second true-card candidate for this epoch');
  const duplicateResult = await sameEpochAggregate.done;
  assert.equal(duplicateResult.reason, 'same-epoch-duplicate');
  assert.equal(duplicateResult.state, 'suppressed');
  const restored = harness({ state: first.latest(), ledger: first.ledger });
  const duplicate = await restored.studio.onWarmupCandidate({
    ...request,
    activity_epoch_id: 'epoch-session-dedupe-b',
    observation_id: 'observation-session-dedupe-b',
    warmup: warmup('warmup-session-dedupe-b', 'epoch-session-dedupe-b'),
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'epoch-duplicate');
  assert.equal(restored.state.studio.warmup_dedupe.length, 1);
  assert.equal(restored.state.studio.current_warmup.warmup_id, 'warmup-session-dedupe-a');
  const staleAggregateAfterRestart = restored.studio.enqueueReport(observedReport('epoch-session-dedupe-a'));
  assert.equal(staleAggregateAfterRestart.accepted, false, 'the durable dedupe record also blocks an old aggregation after takeover');
  assert.equal(
    first.entries.some((entry) => entry.event === 'warmup_suppressed' && entry.reason === 'epoch-duplicate'),
    true,
  );
});

test('outbox recovers after both crash windows without duplicate activity entries', async () => {
  const sharedLedger = {
    seen: new Set(),
    entries: [],
    async appendIdempotent(entry) {
      if (this.seen.has(entry.outbox_id)) return { ...entry, duplicate: true };
      this.seen.add(entry.outbox_id);
      this.entries.push(clone(entry));
      return clone(entry);
    },
  };
  let crashAfterPersist = true;
  const first = harness({
    ledger: sharedLedger,
    transitionHook: async (phase) => {
      if (phase === 'after-persist-before-ledger' && crashAfterPersist) {
        crashAfterPersist = false;
        throw new Error('simulated crash after state persistence');
      }
    },
  });
  await assert.rejects(first.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-crash-a',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-crash-a:search-with-rg',
    observation_id: 'observation-epoch-crash-a',
    report: observedReport('epoch-crash-a'),
    warmup: warmup('warmup-crash-a', 'epoch-crash-a'),
  }));
  const recovered = harness({
    ledger: sharedLedger,
    state: first.latest(),
  });
  assert.equal((await recovered.studio.flushLedgerOutbox()).ok, true);
  assert.deepEqual(sharedLedger.entries.map((entry) => entry.event), ['observed', 'warmup_served']);

  let crashAfterFirstLedger = true;
  const second = harness({
    ledger: sharedLedger,
    transitionHook: async (phase, detail) => {
      if (phase === 'after-ledger-entry' && detail.index === 0 && crashAfterFirstLedger) {
        crashAfterFirstLedger = false;
        throw new Error('simulated crash during ledger flush');
      }
    },
  });
  const interrupted = await second.studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-crash-b',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-crash-b:search-with-rg',
    observation_id: 'observation-epoch-crash-b',
    report: observedReport('epoch-crash-b'),
    warmup: warmup('warmup-crash-b', 'epoch-crash-b'),
  });
  assert.equal(interrupted.committed, false);
  assert.equal(interrupted.state, 'warmup-served');
  const resumed = harness({ ledger: sharedLedger, state: second.latest() });
  assert.equal((await resumed.studio.flushLedgerOutbox()).ok, true);
  const eventIds = sharedLedger.entries.map((entry) => entry.outbox_id);
  assert.equal(new Set(eventIds).size, eventIds.length, 'idempotent replay never duplicates a ledger entry');
  assert.deepEqual(
    sharedLedger.entries.filter((entry) => entry.activity_epoch_id === 'epoch-crash-b').map((entry) => entry.event),
    ['observed', 'warmup_served'],
  );
});

test('an owner lease lost after durable state persistence cannot append ledger entries or broadcast a stale warmup', async () => {
  const state = { cards: [], strengths: {}, studio: null };
  const entries = [];
  const events = [];
  let ownerAlive = true;
  let beginSave;
  let releaseSave;
  const saving = new Promise((resolve) => { beginSave = resolve; });
  const release = new Promise((resolve) => { releaseSave = resolve; });
  let persisted = null;
  const studio = createStudioService({
    canCommit: () => ownerAlive,
    hub: { broadcast(type, payload) { events.push({ payload: clone(payload), type }); } },
    ledger: {
      async appendIdempotent(entry) {
        entries.push(clone(entry));
        return entry;
      },
    },
    persistence: {
      async saveCards(cards, savedStudio) {
        beginSave();
        await release;
        persisted = { cards: clone(cards), studio: clone(savedStudio) };
      },
    },
    state,
  });

  const transition = studio.onWarmupCandidate({
    activity_epoch_id: 'epoch-owner-lease',
    concept_id: 'search-with-rg',
    dedupe_key: 'project:session-owner-lease:search-with-rg',
    observation_id: 'observation-owner-lease',
    report: observedReport('epoch-owner-lease'),
    warmup: warmup('warmup-owner-lease', 'epoch-owner-lease'),
  });
  await saving;
  ownerAlive = false;
  releaseSave();
  const result = await transition;

  assert.equal(result.committed, false);
  assert.deepEqual(entries, [], 'the old owner never reaches the ledger after its lease has ended');
  assert.deepEqual(events, [], 'the old owner never sends an SSE that could resurrect a stale warmup');
  assert.ok(persisted?.studio?.ledger_outbox?.length >= 2, 'the new owner can safely replay the already-persisted outbox');
});
