'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_AUTO_ADVANCE_DELAY_MS,
  autoAdvanceEligible,
  autoAdvanceGate,
  buildStudioRoute,
  claimAutoAdvance,
  createAutoAdvanceState,
  isActiveNowContext,
  mergeStudioCurrent,
  noteNextReady,
  noteNextUnavailable,
  noteStudioInteraction,
  nextControlState,
  normalizeStudioContract,
  parseStudioRoute,
  selectStudioRouteFromUser,
  setAutoAdvanceEnabled,
} = require('../public/studio-state');

function lesson(cardId, { answered = false, explanation = '' } = {}) {
  return {
    card_id: cardId,
    concept_name: `Concept ${cardId}`,
    explanation,
    lesson: `Lesson ${cardId}`,
    question: `Question ${cardId}`,
    state: { answered, chosen_index: answered ? 1 : null, correct: answered ? false : null },
  };
}

function warmupLesson(warmupId, { answered = false, explanation = '' } = {}) {
  return {
    warmup_id: warmupId,
    concept_name: '即时热身',
    explanation,
    lesson: '这是一段本地热身。',
    question: '现在正在学习什么？',
    state: { answered, chosen_index: answered ? 0 : null, correct: answered ? true : null },
  };
}

test('Studio routes round-trip a project and the review view without trusting malformed hashes', () => {
  const route = buildStudioRoute({ projectId: 'project-a.1', view: 'review' });
  assert.equal(route, '#project=project-a.1&view=review');
  assert.deepEqual(parseStudioRoute(route), { projectId: 'project-a.1', view: 'review' });
  assert.deepEqual(parseStudioRoute('?project=project-b&view=now'), { projectId: 'project-b', view: 'now' });
  assert.deepEqual(parseStudioRoute('#project=%E0%A4%A&view=review'), { projectId: null, view: 'review' });
  assert.deepEqual(parseStudioRoute('#project=<script>&view=not-a-view'), { projectId: null, view: 'now' });
  assert.equal(buildStudioRoute({ projectId: '../not-a-project', view: 'review' }), '');
});

test('only an explicit Studio selection changes the active project and clears its ready badge', () => {
  const state = {
    activeProjectId: 'project-a',
    readyProjectIds: new Set(['project-b']),
    studioView: 'now',
  };

  assert.equal(selectStudioRouteFromUser(state, '#project=project-b&view=review'), true);
  assert.equal(state.activeProjectId, 'project-b');
  assert.equal(state.studioView, 'review');
  assert.equal(state.readyProjectIds.has('project-b'), false);

  // Invalid/background-shaped data cannot accidentally switch a learner away
  // from the tab they selected.
  assert.equal(selectStudioRouteFromUser(state, '#project=<background>&view=now'), false);
  assert.equal(state.activeProjectId, 'project-b');
  assert.equal(state.studioView, 'review');
});

test('a project/view transition removes the old lesson from the auto-advance context', () => {
  const state = {
    activeProjectId: 'project-a',
    readyProjectIds: new Set(),
    studioView: 'now',
  };
  assert.equal(isActiveNowContext(state, 'project-a'), true);

  selectStudioRouteFromUser(state, { projectId: 'project-b', view: 'now' });
  assert.equal(isActiveNowContext(state, 'project-a'), false);
  assert.equal(isActiveNowContext(state, 'project-b'), true);

  selectStudioRouteFromUser(state, { projectId: 'project-b', view: 'review' });
  assert.equal(isActiveNowContext(state, 'project-b'), false);
});

test('the canonical Studio contract keeps answered Now through a live ready flip, reload, and explicit promotion', () => {
  const answeredNow = lesson('now', { answered: true, explanation: 'Why this answer matters.' });
  const initial = normalizeStudioContract({
    current: answeredNow,
    next_ready: false,
    waiting: { reason: 'idle', source_provenance: null },
  });
  assert.equal(nextControlState(initial), 'idle');

  // This is the live SSE update: only readiness changes. Now cannot be
  // reconstructed from an arbitrary unseen card or silently replaced.
  const live = normalizeStudioContract({
    current: answeredNow,
    next_ready: true,
    waiting: null,
  }, initial);
  assert.equal(live.current.card_id, 'now');
  assert.equal(live.current.explanation, 'Why this answer matters.');
  assert.equal(nextControlState(live), 'ready');

  const reloaded = normalizeStudioContract({
    current: answeredNow,
    next_ready: true,
    waiting: null,
  });
  const reconstructedCards = mergeStudioCurrent([], reloaded.current);
  assert.equal(reloaded.current.card_id, 'now');
  assert.equal(reloaded.current.explanation, 'Why this answer matters.');
  assert.equal(reconstructedCards[0].card_id, 'now');
  assert.equal(nextControlState(reloaded), 'ready');

  const promoted = normalizeStudioContract({
    current: lesson('next'),
    next_ready: false,
    waiting: { reason: 'idle', source_provenance: null },
  }, reloaded);
  assert.equal(promoted.current.card_id, 'next');
  assert.equal(nextControlState(promoted), 'hidden');
});

test('the client treats current_warmup as the authoritative warmup Now and never merges it into real history', () => {
  const realHistory = [lesson('real-history')];
  const warmup = warmupLesson('warmup-now');
  const live = normalizeStudioContract({
    now: { kind: 'warmup', card_ref: 'warmup-now' },
    // A stale compatibility current must not override the authoritative
    // warmup record carried by snapshot/SSE.
    current: lesson('stale-real'),
    current_warmup: warmup,
    next_ready: false,
    waiting: { reason: 'queued', source_provenance: null },
  });
  assert.deepEqual(live.now, { kind: 'warmup', card_ref: 'warmup-now' });
  assert.equal(live.current.warmup_id, 'warmup-now');
  assert.equal(live.current_warmup.warmup_id, 'warmup-now');
  assert.deepEqual(mergeStudioCurrent(realHistory, live.current, live.now), realHistory);

  const reloaded = normalizeStudioContract({
    now: { kind: 'warmup', card_ref: 'warmup-now' },
    current_warmup: warmup,
    next_ready: false,
    waiting: { reason: 'queued', source_provenance: null },
  });
  assert.equal(reloaded.current.warmup_id, 'warmup-now', 'a hard reload reconstructs the exact warmup question');

  const replacement = normalizeStudioContract({
    now: { kind: 'real', card_ref: 'real-replacement' },
    current: lesson('real-replacement'),
    current_warmup: null,
    next_ready: false,
    waiting: { reason: 'idle', source_provenance: null },
  }, reloaded);
  assert.deepEqual(replacement.now, { kind: 'real', card_ref: 'real-replacement' });
  assert.equal(replacement.current.card_id, 'real-replacement');
  assert.equal(replacement.current_warmup, null);
});

test('auto advance is voluntary by default and needs an enabled setting, a ready Next card, and a full delay', () => {
  const auto = createAutoAdvanceState();
  assert.equal(auto.delayMs, DEFAULT_AUTO_ADVANCE_DELAY_MS);
  noteNextReady(auto, 1_000);
  assert.deepEqual(autoAdvanceGate(auto, { nextReady: true, now: 10_000 }), {
    keepNextVisible: true,
    reason: 'disabled',
    remainingMs: null,
    shouldAdvance: false,
  });

  setAutoAdvanceEnabled(auto, true, 2_000);
  assert.deepEqual(autoAdvanceGate(auto, { nextReady: true, now: 4_999 }), {
    keepNextVisible: true,
    reason: 'waiting-delay',
    remainingMs: 1,
    shouldAdvance: false,
  });
  assert.deepEqual(autoAdvanceGate(auto, { nextReady: true, now: 5_000 }), {
    keepNextVisible: true,
    reason: 'ready',
    remainingMs: 0,
    shouldAdvance: true,
  });
});

test('auto advance only becomes eligible for an answered current lesson with a ready buffer', () => {
  const unanswered = normalizeStudioContract({ current: lesson('now'), next_ready: true, waiting: null });
  const noReady = normalizeStudioContract({ current: lesson('now', { answered: true }), next_ready: false, waiting: { reason: 'idle', source_provenance: null } });
  const answeredReady = normalizeStudioContract({ current: lesson('now', { answered: true }), next_ready: true, waiting: null });
  assert.equal(autoAdvanceEligible(unanswered), false);
  assert.equal(autoAdvanceEligible(noReady), false);
  assert.equal(autoAdvanceEligible(answeredReady), true);

  const answeredWarmupReady = normalizeStudioContract({
    current_warmup: warmupLesson('warmup-auto', { answered: true }),
    now: { kind: 'warmup', card_ref: 'warmup-auto' },
    next_ready: true,
    waiting: null,
  });
  assert.equal(
    autoAdvanceEligible(answeredWarmupReady),
    false,
    'a local warmup keeps manual Next visible but can never be timer-promoted',
  );

  const auto = createAutoAdvanceState({ enabled: true, delayMs: 10 });
  noteNextReady(auto, 100);
  assert.equal(autoAdvanceGate(auto, { nextReady: autoAdvanceEligible(unanswered), now: 1_000 }).shouldAdvance, false);
  assert.equal(autoAdvanceGate(auto, { nextReady: autoAdvanceEligible(noReady), now: 1_000 }).shouldAdvance, false);
  assert.equal(autoAdvanceGate(auto, { nextReady: autoAdvanceEligible(answeredReady), now: 110 }).shouldAdvance, true);
});

test('interaction resets an enabled auto-advance timer, and automatic claims cannot hide or double-use Next', () => {
  const auto = createAutoAdvanceState({ enabled: true, delayMs: 2_000 });
  noteNextReady(auto, 1_000);
  noteStudioInteraction(auto, 2_500);

  assert.deepEqual(autoAdvanceGate(auto, { nextReady: true, now: 4_499 }), {
    keepNextVisible: true,
    reason: 'waiting-delay',
    remainingMs: 1,
    shouldAdvance: false,
  });
  const claimed = claimAutoAdvance(auto, { nextReady: true, now: 4_500 });
  assert.equal(claimed.shouldAdvance, true);
  assert.equal(claimed.keepNextVisible, true);
  assert.equal(auto.nextReadyAt, null);
  assert.equal(autoAdvanceGate(auto, { nextReady: false, now: 4_501 }).shouldAdvance, false);

  noteNextReady(auto, 5_000);
  noteNextUnavailable(auto);
  assert.equal(autoAdvanceGate(auto, { nextReady: false, now: 9_000 }).reason, 'next-not-ready');
});
