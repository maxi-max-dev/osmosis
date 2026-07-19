'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_AUTO_ADVANCE_DELAY_MS,
  autoAdvanceGate,
  buildStudioRoute,
  claimAutoAdvance,
  createAutoAdvanceState,
  noteNextReady,
  noteNextUnavailable,
  noteStudioInteraction,
  parseStudioRoute,
  selectStudioRouteFromUser,
  setAutoAdvanceEnabled,
} = require('../public/studio-state');

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
