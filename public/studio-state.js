(function exposeStudioState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.OsmosisStudioState = api;
  }
})(typeof globalThis === 'undefined' ? null : globalThis, function createStudioStateApi() {
  'use strict';

  const DEFAULT_VIEW = 'now';
  const REVIEW_VIEW = 'review';
  const DEFAULT_AUTO_ADVANCE_DELAY_MS = 3_000;

  function normalizeProjectId(value) {
    if (typeof value !== 'string') return null;
    const projectId = value.trim();
    // Project IDs are server-generated. Keeping the deep-link grammar this
    // narrow means an arbitrary hash can never become an identifier that is
    // later interpolated into a URL or the page.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(projectId)) return null;
    return projectId;
  }

  function normalizeView(value) {
    return value === REVIEW_VIEW ? REVIEW_VIEW : DEFAULT_VIEW;
  }

  function hashQuery(value) {
    if (typeof value !== 'string') return '';
    const hashOffset = value.indexOf('#');
    const fragment = hashOffset >= 0 ? value.slice(hashOffset + 1) : value;
    return fragment.startsWith('?') ? fragment.slice(1) : fragment;
  }

  /**
   * Parse only the two Studio route fields. Invalid and malformed values are
   * deliberately reduced to the calm default rather than being propagated to
   * the rest of the UI.
   */
  function parseStudioRoute(value) {
    let params;
    try {
      params = new URLSearchParams(hashQuery(value));
    } catch {
      params = new URLSearchParams();
    }
    return {
      projectId: normalizeProjectId(params.get('project')),
      view: normalizeView(params.get('view')),
    };
  }

  function buildStudioRoute(route = {}) {
    const projectId = normalizeProjectId(route.projectId || route.project_id);
    if (!projectId) return '';
    const view = normalizeView(route.view);
    return `#project=${encodeURIComponent(projectId)}&view=${encodeURIComponent(view)}`;
  }

  function normalizedRoute(route) {
    if (typeof route === 'string') return parseStudioRoute(route);
    if (!route || typeof route !== 'object') return { projectId: null, view: DEFAULT_VIEW };
    return {
      projectId: normalizeProjectId(route.projectId || route.project_id),
      view: normalizeView(route.view),
    };
  }

  /**
   * This is intentionally the only project-selection transition in this
   * module. Call it for a tab click or explicit deep-link navigation; never
   * call it while consuming background activity/SSE. That preserves a user's
   * current learning context even when another project becomes ready.
   */
  function selectStudioRouteFromUser(state, route) {
    if (!state || typeof state !== 'object') return false;
    const parsed = normalizedRoute(route);
    if (!parsed.projectId) return false;
    state.activeProjectId = parsed.projectId;
    state.studioView = parsed.view;
    if (state.readyProjectIds && typeof state.readyProjectIds.delete === 'function') {
      state.readyProjectIds.delete(parsed.projectId);
    }
    return true;
  }

  function finiteTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
  }

  function normalizeDelay(value) {
    const delay = Number(value);
    if (!Number.isFinite(delay) || delay < 0) return DEFAULT_AUTO_ADVANCE_DELAY_MS;
    // A bounded delay keeps a corrupt persisted setting from silently parking
    // a Studio session forever while still allowing a deliberately slow pace.
    return Math.min(Math.floor(delay), 120_000);
  }

  function createAutoAdvanceState(options = {}) {
    return {
      delayMs: normalizeDelay(options.delayMs),
      enabled: options.enabled === true,
      lastInteractionAt: null,
      nextReadyAt: null,
    };
  }

  function setAutoAdvanceEnabled(state, enabled, now = Date.now()) {
    if (!state || typeof state !== 'object') return false;
    state.enabled = enabled === true;
    // Enabling and disabling are interactions: a ready question must wait a
    // fresh delay after either switch, never immediately jump the learner.
    state.lastInteractionAt = finiteTimestamp(now);
    return true;
  }

  function noteNextReady(state, now = Date.now()) {
    if (!state || typeof state !== 'object') return false;
    // Preserve the first ready timestamp. Repeated snapshots/events for the
    // same buffered card must not keep postponing an eligible advance.
    if (!Number.isFinite(state.nextReadyAt)) {
      state.nextReadyAt = finiteTimestamp(now);
    }
    return true;
  }

  function noteNextUnavailable(state) {
    if (!state || typeof state !== 'object') return false;
    state.nextReadyAt = null;
    return true;
  }

  function noteStudioInteraction(state, now = Date.now()) {
    if (!state || typeof state !== 'object') return false;
    // A tab/view change, answer click, pointer/keyboard activity, or manual
    // Next click resets the timer. The visible Next control is never tied to
    // this state and remains available to the learner.
    state.lastInteractionAt = finiteTimestamp(now);
    return true;
  }

  function autoAdvanceGate(state, { nextReady = false, now = Date.now() } = {}) {
    const keepNextVisible = true;
    if (!nextReady) {
      return { keepNextVisible, reason: 'next-not-ready', remainingMs: null, shouldAdvance: false };
    }
    if (!state || state.enabled !== true) {
      return { keepNextVisible, reason: 'disabled', remainingMs: null, shouldAdvance: false };
    }
    const readyAt = Number.isFinite(state.nextReadyAt) ? state.nextReadyAt : finiteTimestamp(now);
    const interactionAt = Number.isFinite(state.lastInteractionAt) ? state.lastInteractionAt : 0;
    const anchor = Math.max(readyAt, interactionAt);
    const delayMs = normalizeDelay(state.delayMs);
    const elapsed = Math.max(0, finiteTimestamp(now) - anchor);
    const remainingMs = Math.max(0, delayMs - elapsed);
    return {
      keepNextVisible,
      reason: remainingMs === 0 ? 'ready' : 'waiting-delay',
      remainingMs,
      shouldAdvance: remainingMs === 0,
    };
  }

  function claimAutoAdvance(state, options = {}) {
    const gate = autoAdvanceGate(state, options);
    if (!gate.shouldAdvance || !state || typeof state !== 'object') return gate;
    // Claiming consumes this ready buffer before a network transition starts,
    // so an interval cannot issue duplicate automatic Next requests.
    state.nextReadyAt = null;
    state.lastInteractionAt = finiteTimestamp(options.now);
    return gate;
  }

  return {
    DEFAULT_AUTO_ADVANCE_DELAY_MS,
    REVIEW_VIEW,
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
  };
});
