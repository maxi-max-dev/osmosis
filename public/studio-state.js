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

  function hasOwn(value, key) {
    return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));
  }

  function objectOrNull(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

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

  function normalizeSourceProvenance(value) {
    const source = objectOrNull(value);
    if (!source) return null;
    return {
      kind: typeof source.kind === 'string' ? source.kind : 'agent',
      task: typeof source.task === 'string' ? source.task : '',
      what_i_did: typeof source.what_i_did === 'string' ? source.what_i_did : '',
    };
  }

  function normalizeWaiting(value) {
    if (value === null) return null;
    const waiting = objectOrNull(value);
    if (!waiting) return { reason: 'idle', source_provenance: null };
    const rawReason = typeof waiting.reason === 'string'
      ? waiting.reason
      // A short migration shim lets a connecting browser survive an older
      // owner during a local port-handover without treating it as canonical.
      : typeof waiting.state === 'string' ? waiting.state : 'idle';
    const reason = ['preparing', 'queued', 'idle'].includes(rawReason) ? rawReason : 'idle';
    return {
      reason,
      source_provenance: normalizeSourceProvenance(waiting.source_provenance || waiting.source),
    };
  }

  function normalizeNow(value) {
    const now = objectOrNull(value);
    if (!now) return null;
    if (now.kind === null) return { kind: null, card_ref: null };
    if (now.kind !== 'real' && now.kind !== 'warmup') return { kind: null, card_ref: null };
    const cardRef = typeof now.card_ref === 'string' ? now.card_ref.trim() : '';
    return cardRef ? { kind: now.kind, card_ref: cardRef } : { kind: null, card_ref: null };
  }

  function normalizeWarmup(value) {
    const warmup = objectOrNull(value);
    const warmupId = typeof warmup?.warmup_id === 'string' ? warmup.warmup_id.trim() : '';
    if (!warmupId) return null;
    const state = objectOrNull(warmup.state) || {};
    return {
      ...warmup,
      warmup_id: warmupId,
      state: {
        ...state,
        answered: state.answered === true,
        chosen_index: Number.isInteger(state.chosen_index) ? state.chosen_index : null,
        correct: typeof state.correct === 'boolean' ? state.correct : null,
      },
    };
  }

  function inferredNow(current, warmup) {
    if (warmup?.warmup_id) return { kind: 'warmup', card_ref: warmup.warmup_id };
    if (typeof current?.warmup_id === 'string' && current.warmup_id) {
      return { kind: 'warmup', card_ref: current.warmup_id };
    }
    if (typeof current?.card_id === 'string' && current.card_id) {
      return { kind: 'real', card_ref: current.card_id };
    }
    return { kind: null, card_ref: null };
  }

  /**
   * The one Studio wire contract used by REST snapshots and live SSE:
   * current remains in place until Next, while next_ready exposes only the
   * buffer's availability—not its hidden lesson payload.
   */
  function normalizeStudioContract(value, fallback = null) {
    const studio = objectOrNull(value);
    const previous = objectOrNull(fallback);
    const hasNow = Boolean(studio && hasOwn(studio, 'now'));
    const hasCurrent = Boolean(studio && hasOwn(studio, 'current'));
    const hasWarmup = Boolean(studio && hasOwn(studio, 'current_warmup'));
    const rawCurrent = hasCurrent ? objectOrNull(studio.current) : null;
    const previousNow = normalizeNow(previous?.now) || { kind: null, card_ref: null };
    const previousWarmup = normalizeWarmup(previous?.current_warmup);
    const providedWarmup = hasWarmup ? normalizeWarmup(studio.current_warmup) : null;
    const compatibilityWarmup = normalizeWarmup(rawCurrent);
    let now;
    if (hasNow) {
      now = normalizeNow(studio.now) || { kind: null, card_ref: null };
    } else if (hasWarmup || hasCurrent) {
      // An explicit `current_warmup: null` is authoritative: do not revive a
      // compatibility `current` payload after the owner has replaced it.
      const currentForInference = hasWarmup && rawCurrent?.warmup_id ? null : rawCurrent;
      now = inferredNow(currentForInference, hasWarmup ? providedWarmup : compatibilityWarmup);
    } else {
      now = previousNow;
    }

    let currentWarmup = null;
    let current = null;
    if (now.kind === 'warmup') {
      const candidate = hasWarmup ? providedWarmup : compatibilityWarmup || previousWarmup;
      if (candidate?.warmup_id === now.card_ref) {
        // `current_warmup` is the authoritative warmup payload. `current`
        // stays as a compatibility view for existing Studio helpers, but it
        // must never be treated as a real history card by callers.
        currentWarmup = candidate;
        current = candidate;
      } else {
        now = { kind: null, card_ref: null };
      }
    } else if (now.kind === 'real') {
      const candidate = hasCurrent ? rawCurrent : objectOrNull(previous?.current);
      if (candidate?.card_id === now.card_ref) current = candidate;
    }
    const nextReady = studio && hasOwn(studio, 'next_ready')
      ? studio.next_ready === true
      : studio?.next
        ? studio.next.ready === true
        : previous?.next_ready === true;
    const waiting = studio && hasOwn(studio, 'waiting')
      ? normalizeWaiting(studio.waiting)
      : previous && hasOwn(previous, 'waiting')
        ? normalizeWaiting(previous.waiting)
        : { reason: 'idle', source_provenance: null };
    const interactionToken = Number.isInteger(studio?.interaction_token)
      ? studio.interaction_token
      : Number.isInteger(previous?.interaction_token)
        ? previous.interaction_token
        : null;
    return {
      now,
      current,
      current_warmup: currentWarmup,
      next_ready: nextReady,
      waiting,
      ...(interactionToken === null ? {} : { interaction_token: interactionToken }),
    };
  }

  function mergeStudioCurrent(cards, current, now = null) {
    const existing = Array.isArray(cards) ? cards.filter(Boolean) : [];
    // A warmup's only durable home is `studio.current_warmup` /
    // `warmup_history`. It must never leak into cards, review, strengths, or
    // the real learning trail—even if a compatibility `current` field exists.
    if (now && now.kind !== 'real') return existing;
    if (!current || typeof current.card_id !== 'string') return existing;
    return [...existing.filter((card) => card?.card_id !== current.card_id), current];
  }

  function nextControlState(studio) {
    const normalized = normalizeStudioContract(studio);
    if (!normalized.current?.state?.answered) return 'hidden';
    if (normalized.next_ready) return 'ready';
    return ['preparing', 'queued'].includes(normalized.waiting?.reason) ? 'preparing' : 'idle';
  }

  function autoAdvanceEligible(studio) {
    const normalized = normalizeStudioContract(studio);
    // Warmups are deliberately local, non-curricular practice. A learner can
    // manually choose Next after one, but no timer may move them on without
    // that explicit choice.
    return Boolean(
      normalized.now.kind === 'real'
      && normalized.current?.state?.answered
      && normalized.next_ready,
    );
  }

  function isActiveNowContext(state, projectId) {
    return Boolean(
      state
      && typeof projectId === 'string'
      && state.activeProjectId === projectId
      && normalizeView(state.studioView) === DEFAULT_VIEW,
    );
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
  };
});
