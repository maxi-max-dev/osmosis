'use strict';

const { randomUUID } = require('node:crypto');

const { cardForClient, normalizeStudioReport, normalizeStudioState } = require('./state');

const MAX_CANDIDATES = 2;

function nowIso() {
  return new Date().toISOString();
}

function sourceKind(report) {
  if (report?.source === 'observed') {
    return report.observed_kind === 'change' ? 'observed-change' : 'observed-activity';
  }
  return 'agent';
}

function sourceProjection(report) {
  return {
    kind: sourceKind(report),
    task: typeof report?.task === 'string' ? report.task.slice(0, 240) : '',
    what_i_did: typeof report?.what_i_did === 'string' ? report.what_i_did.slice(0, 4_000) : '',
  };
}

function countUnansweredExcludingReady(cards, studio) {
  const readyId = studio?.ready_card_id;
  return (Array.isArray(cards) ? cards : []).filter(
    (card) => card && !card.state?.answered && card.card_id !== readyId,
  ).length;
}

function candidateFrom(report, { clock = Date.now, id = randomUUID } = {}) {
  const normalized = normalizeStudioReport(report);
  if (!normalized) {
    return null;
  }
  return {
    candidate_id: id(),
    created_at: new Date(clock()).toISOString(),
    report: normalized,
    report_ids: normalized.report_id ? [normalized.report_id] : [],
    updated_at: new Date(clock()).toISOString(),
  };
}

function coalesceCandidates(left, right, { clock = Date.now } = {}) {
  const reports = [left?.report, right?.report].filter(Boolean);
  const first = reports[0] || {};
  const last = reports.at(-1) || first;
  const stackHints = [...new Set(reports.flatMap((report) => report.stack_hints || []))].slice(0, 12);
  return {
    candidate_id: left.candidate_id,
    created_at: left.created_at,
    report: {
      ...last,
      task: reports.map((report) => report.task).join(' · ').slice(0, 240),
      what_i_did: reports.map((report) => report.what_i_did).join(' ').slice(0, 4_000),
      stack_hints: stackHints.length > 0 ? stackHints : first.stack_hints || [],
      ...(first.report_id ? { report_id: first.report_id } : {}),
    },
    report_ids: [...new Set([...left.report_ids || [], ...right.report_ids || []])].slice(0, 12),
    updated_at: new Date(clock()).toISOString(),
  };
}

/**
 * The Studio is intentionally a small per-channel state machine. Provider
 * generation remains injectable so the broker can keep owning global fairness
 * and provider/curriculum concerns, while this service owns the durable
 * current/ready/candidate watermark.
 */
function createStudioService({
  state,
  persistence,
  hub = null,
  ledger = null,
  generate = null,
  persistCard = null,
  clock = Date.now,
  id = randomUUID,
} = {}) {
  if (!state || !Array.isArray(state.cards)) {
    throw new TypeError('createStudioService needs a state with cards.');
  }
  if (!persistence || typeof persistence.saveCards !== 'function') {
    throw new TypeError('createStudioService needs persistence.saveCards.');
  }

  state.studio = normalizeStudioState(state.studio, state.cards);
  let generator = typeof generate === 'function' ? generate : null;
  let writeTail = Promise.resolve();
  let activeGeneration = null;
  let interactionVersion = 0;

  function currentCard() {
    const currentId = state.studio.current_card_id;
    return currentId ? state.cards.find((card) => card?.card_id === currentId) || null : null;
  }

  function readyCard() {
    const readyId = state.studio.ready_card_id;
    return readyId ? state.cards.find((card) => card?.card_id === readyId) || null : null;
  }

  function appendLedger(entry) {
    if (!ledger || typeof ledger.append !== 'function') {
      return;
    }
    try {
      const result = ledger.append(entry);
      if (result?.catch) {
        void result.catch(() => {});
      }
    } catch {
      // The Studio must not make a local lesson unavailable because a trace
      // write failed. The broker has its own durable reconciliation path.
    }
  }

  function emit() {
    hub?.broadcast?.('studio', projection());
  }

  function persist() {
    const work = writeTail.then(() => persistence.saveCards(state.cards, state.studio));
    writeTail = work.catch(() => {});
    return work;
  }

  function waiting() {
    const generation = state.studio.generation;
    if (generation.in_flight && generation.candidate) {
      return {
        source: sourceProjection(generation.candidate.report),
        state: 'preparing',
        message: 'Preparing a lesson from the latest useful signal.',
      };
    }
    if (state.studio.candidates.length > 0) {
      return {
        source: sourceProjection(state.studio.candidates[0].report),
        state: 'queued',
        message: 'A useful signal is ready when there is room for the next lesson.',
      };
    }
    return {
      source: null,
      state: 'idle',
      message: 'Keep working — Osmosis will prepare the next lesson when it sees a useful signal.',
    };
  }

  function status() {
    const current = currentCard();
    return {
      candidate_count: state.studio.candidates.length,
      current: current
        ? { answered: Boolean(current.state?.answered), card_id: current.card_id }
        : null,
      generation_in_flight: Boolean(state.studio.generation.in_flight),
      next_ready: Boolean(readyCard()),
      unanswered_count: countUnansweredExcludingReady(state.cards, state.studio),
      waiting: waiting(),
    };
  }

  function projection() {
    const current = currentCard();
    const reviews = state.cards.filter((card) => card?.state?.answered).map(cardForClient);
    return {
      current: current ? cardForClient(current) : null,
      current_card_id: state.studio.current_card_id,
      // The browser sends this optimistic-concurrency marker back only for
      // auto-advance. A later learner interaction invalidates an in-flight
      // automatic transition without ever hiding the manual Next control.
      interaction_token: interactionVersion,
      next: { ready: Boolean(readyCard()) },
      review: reviews,
      status: status(),
      waiting: waiting(),
    };
  }

  function queueCandidate(candidate) {
    if (state.studio.candidates.length < MAX_CANDIDATES) {
      state.studio.candidates.push(candidate);
      return { coalesced: false };
    }
    // Keep the newest signal discrete. The two older signals become one
    // durable candidate, preserving a small but honest provenance trail.
    const first = state.studio.candidates.shift();
    const second = state.studio.candidates.shift();
    const merged = coalesceCandidates(first, second, { clock });
    state.studio.candidates.push(merged, candidate);
    return { coalesced: true, merged };
  }

  function canGenerate() {
    return Boolean(generator)
      && !state.studio.generation.in_flight
      && !readyCard()
      && state.studio.candidates.length > 0;
  }

  function generationFailure(candidate) {
    state.studio.generation = { candidate: null, in_flight: false, started_at: null };
    appendLedger({
      at: nowIso(),
      event: 'failure',
      reason: 'generation-failed',
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: 'failed',
    });
    emit();
    return persist().then(() => ({ state: 'failed' }));
  }

  function generationWaiting(candidate, reason = 'generation-queue-full') {
    state.studio.generation = { candidate: null, in_flight: false, started_at: null };
    // The signal was already durable before provider work started. Put it
    // back at the front rather than turning a temporary broker slot shortage
    // into a silent lesson loss.
    state.studio.candidates.unshift(candidate);
    state.studio.candidates = state.studio.candidates.slice(0, MAX_CANDIDATES);
    appendLedger({
      at: nowIso(),
      event: 'refusal',
      reason,
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: 'waiting',
    });
    emit();
    return persist().then(() => ({ state: 'waiting' }));
  }

  function generationSettled(candidate, result) {
    state.studio.generation = { candidate: null, in_flight: false, started_at: null };
    emit();
    return persist().then(() => ({ state: result?.state || 'suppressed' }));
  }

  function pump() {
    if (!canGenerate()) {
      return Promise.resolve({ state: status().waiting.state });
    }
    const candidate = state.studio.candidates.shift();
    state.studio.generation = {
      candidate,
      in_flight: true,
      started_at: new Date(clock()).toISOString(),
    };
    emit();
    const run = persist()
      .then(() => generator(candidate.report, candidate))
      .then((outcome) => {
        // Broker-backed generators return {state, card}; direct unit-test
        // generators may still return the runtime card itself.
        if (outcome && typeof outcome === 'object' && typeof outcome.state === 'string') {
          if (outcome.state === 'generated' && outcome.card) {
            return receiveGenerated(candidate, outcome.card);
          }
          if (outcome.state === 'waiting') {
            return generationWaiting(candidate, outcome.reason);
          }
          if (outcome.state === 'failed') {
            return generationSettled(candidate, outcome);
          }
          return generationSettled(candidate, outcome);
        }
        if (!outcome) {
          return generationFailure(candidate);
        }
        return receiveGenerated(candidate, outcome);
      })
      .catch(() => generationFailure(candidate));
    let settled;
    settled = run.finally(() => {
      if (activeGeneration === settled) {
        activeGeneration = null;
      }
    });
    activeGeneration = settled;
    return settled;
  }

  async function persistGenerated(card, placement) {
    if (typeof persistCard === 'function') {
      const result = await persistCard(card, placement);
      if (result === false) {
        return false;
      }
    }
    if (!state.cards.some((item) => item?.card_id === card.card_id)) {
      state.cards.push(card);
      if (placement === 'current') {
        hub?.broadcast?.('card', cardForClient(card));
      }
    }
    return true;
  }

  function candidateFor(value) {
    if (value?.candidate_id) {
      return value;
    }
    const reportId = value?.report_id;
    if (state.studio.generation.candidate?.report?.report_id === reportId) {
      return state.studio.generation.candidate;
    }
    return null;
  }

  async function receiveGenerated(candidateOrReport, card) {
    const candidate = candidateFor(candidateOrReport) || state.studio.generation.candidate;
    if (!candidate || !card || typeof card.card_id !== 'string') {
      return { accepted: false, state: 'unmatched-generation' };
    }
    if (state.studio.generation.candidate?.candidate_id === candidate.candidate_id) {
      state.studio.generation = { candidate: null, in_flight: false, started_at: null };
    }
    let placement;
    if (!currentCard()) {
      state.studio.current_card_id = card.card_id;
      placement = 'current';
    } else if (!readyCard()) {
      state.studio.ready_card_id = card.card_id;
      placement = 'ready';
    } else {
      // A caller may race an old provider result against a newly-filled
      // buffer. Never create a third hidden question.
      state.studio.candidates.unshift(candidate);
      state.studio.candidates = state.studio.candidates.slice(0, MAX_CANDIDATES);
      emit();
      await persist();
      return { accepted: false, state: 'watermark-full' };
    }
    const persisted = await persistGenerated(card, placement);
    if (!persisted) {
      if (placement === 'current') {
        state.studio.current_card_id = null;
      } else {
        state.studio.ready_card_id = null;
      }
      // A pause or pacing/cap decision can happen after a slow provider has
      // returned. Preserve the original signal instead of letting that race
      // erase a lesson opportunity; a later explicit Next or new signal can
      // safely ask the bounded coordinator to try again.
      state.studio.candidates.unshift(candidate);
      state.studio.candidates = state.studio.candidates.slice(0, MAX_CANDIDATES);
      appendLedger({
        at: nowIso(),
        event: 'refusal',
        reason: 'delivery-deferred',
        report_id: candidate.report.report_id,
        source: sourceKind(candidate.report),
        state: 'waiting',
      });
      emit();
      await persist();
      return { accepted: false, state: 'waiting' };
    }
    // Persist the cadence only after the question is actually on the wall.
    // A provider result that is deferred by pause, backpressure, or mastery
    // is not an unsolicited delivery and must not create a phantom 12s gap
    // after a restart.
    if (placement === 'current') {
      state.studio.last_unsolicited_delivery_at = clock();
    }
    appendLedger({
      at: nowIso(),
      event: 'provider-result',
      concept_id: card.concept_id,
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: 'observed',
    });
    appendLedger({
      at: nowIso(),
      event: 'delivery',
      card_id: card.card_id,
      concept_id: card.concept_id,
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: 'delivered',
    });
    emit();
    await persist();
    // Watermark pre-generation: once the first card becomes Now, one later
    // candidate may fill the hidden Next slot, but never more than one.
    void pump();
    return { accepted: true, card, placement, state: placement === 'current' ? 'delivered' : 'ready' };
  }

  function enqueueReport(report) {
    const candidate = candidateFrom(report, { clock, id });
    if (!candidate) {
      return { accepted: false, done: Promise.resolve({ state: 'invalid-report' }), report };
    }
    const queued = queueCandidate(candidate);
    appendLedger({
      at: nowIso(),
      event: queued.coalesced ? 'refusal' : 'accept',
      reason: queued.coalesced ? 'studio-candidate-coalesced' : 'studio-candidate',
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: 'waiting',
    });
    emit();
    const saved = persist();
    const generated = pump();
    return {
      accepted: true,
      done: Promise.all([saved, generated]).then(([, result]) => result),
      report: candidate.report,
    };
  }

  async function next({ auto = false, enabled = true, interaction_token: token } = {}) {
    if (auto && !enabled) {
      return { advanced: false, state: 'auto-advance-disabled' };
    }
    if (auto && token !== undefined && token !== interactionVersion) {
      return { advanced: false, state: 'interaction-paused' };
    }
    const current = currentCard();
    if (current && !current.state?.answered) {
      return { advanced: false, state: 'answer-required' };
    }
    const nextCard = readyCard();
    if (!nextCard) {
      void pump();
      return { advanced: false, state: state.studio.generation.in_flight || state.studio.candidates.length ? 'preparing' : 'idle' };
    }
    if (!auto) {
      interactionVersion += 1;
    }
    state.studio.current_card_id = nextCard.card_id;
    state.studio.ready_card_id = null;
    // The card was purposefully withheld from the compatibility feed while
    // it was Next. Promotion is the first point at which older SSE consumers
    // are allowed to receive its full question.
    hub?.broadcast?.('card', cardForClient(nextCard));
    emit();
    await persist();
    void pump();
    return { advanced: true, card: nextCard, state: 'advanced' };
  }

  function noteInteraction() {
    interactionVersion += 1;
    return interactionVersion;
  }

  async function clearPendingByConcept(conceptId, exceptCardId = null) {
    const buffered = readyCard();
    if (!buffered || buffered.concept_id !== conceptId || buffered.card_id === exceptCardId) {
      return 0;
    }
    // A correctly answered lesson makes an unseen duplicate actively
    // misleading. Remove the buffered copy before CardService clears the
    // legacy pending list, and make the pointer durable in the same write.
    const index = state.cards.findIndex((card) => card?.card_id === buffered.card_id);
    if (index >= 0) {
      state.cards.splice(index, 1);
    }
    state.studio.ready_card_id = null;
    emit();
    await persist();
    void pump();
    return 1;
  }

  function setGenerate(nextGenerator) {
    generator = typeof nextGenerator === 'function' ? nextGenerator : null;
    return pump();
  }

  return {
    acceptGenerated: receiveGenerated,
    afterAnswer: () => {
      emit();
      return status();
    },
    canAutoAdvance: ({ enabled = false, interaction_token: token } = {}) => Boolean(
      enabled && readyCard() && currentCard()?.state?.answered && (token === undefined || token === interactionVersion),
    ),
    countUnanswered: () => countUnansweredExcludingReady(state.cards, state.studio),
    clearPendingByConcept,
    currentCard,
    currentCardId: () => state.studio.current_card_id,
    enqueueReport,
    interactionToken: () => interactionVersion,
    next,
    noteInteraction,
    projection,
    pump,
    readyCard,
    receiveGenerated,
    setGenerate,
    status,
    whenIdle: () => Promise.all([writeTail, activeGeneration || Promise.resolve()]),
  };
}

module.exports = {
  MAX_CANDIDATES,
  candidateFrom,
  coalesceCandidates,
  countUnansweredExcludingReady,
  createStudioService,
  sourceKind,
  sourceProjection,
};
