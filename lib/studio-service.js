'use strict';

const { randomUUID } = require('node:crypto');
const { isMastered } = require('./mastery');
const { canonicalWarmupConceptId } = require('./warmup-catalog');

const {
  cardForClient,
  normalizeStudioReport,
  normalizeStudioState,
  studioReadyCard,
  studioSnapshot,
  studioWaiting,
  warmupForClient,
} = require('./state');

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

function countUnansweredExcludingReady(cards, studio) {
  // `studio.ready_card` is intentionally outside this public/history array,
  // so the hidden follow-up cannot accidentally consume the unanswered cap.
  return (Array.isArray(cards) ? cards : []).filter(
    (card) => card && !card.state?.answered,
  ).length;
}

function candidateFrom(report, {
  clock = Date.now,
  id = randomUUID,
  warmupCatalog = undefined,
  warmupTargetConceptId = null,
} = {}) {
  const normalized = normalizeStudioReport(report);
  if (!normalized) {
    return null;
  }
  const activityEpochId = typeof normalized.activity_epoch_id === 'string'
    ? normalized.activity_epoch_id
    : Array.isArray(normalized.activity_epoch_ids) ? normalized.activity_epoch_ids[0] : null;
  // This owner-derived field deliberately lives on the durable candidate,
  // never on an agent report. Only a qualified warmup can steer generation.
  const warmupTarget = canonicalWarmupConceptId(warmupTargetConceptId, warmupCatalog);
  return {
    candidate_id: id(),
    ...(typeof activityEpochId === 'string' && activityEpochId ? { activity_epoch_id: activityEpochId } : {}),
    ...(warmupTarget ? { warmup_target_concept_id: warmupTarget } : {}),
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
    ...(typeof left.activity_epoch_id === 'string' ? { activity_epoch_id: left.activity_epoch_id } : {}),
    ...(typeof left.warmup_target_concept_id === 'string' && left.warmup_target_concept_id
      ? { warmup_target_concept_id: left.warmup_target_concept_id }
      : {}),
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
  afterDelivery = null,
  canCommit = () => true,
  warmupCatalog = undefined,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  outboxRetryMs = 250,
  maxOutboxRetryAttempts = 6,
  transitionHook = null,
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
  let transitionTail = Promise.resolve();
  let activeGeneration = null;
  let interactionVersion = 0;
  let reloading = false;
  let active = true;
  let outboxRetryTimer = null;
  let outboxRetryAttempts = 0;
  const safeOutboxRetryMs = Number.isInteger(outboxRetryMs) && outboxRetryMs > 0 ? outboxRetryMs : 250;
  const safeMaxOutboxRetryAttempts = Number.isInteger(maxOutboxRetryAttempts) && maxOutboxRetryAttempts > 0
    ? maxOutboxRetryAttempts
    : 6;

  function writable() {
    if (!active) {
      return false;
    }
    try {
      return canCommit() !== false;
    } catch {
      return false;
    }
  }

  function currentNow() {
    const now = state.studio.now;
    if (now?.kind === 'real' || now?.kind === 'warmup') {
      return { kind: now.kind, card_ref: now.card_ref };
    }
    return { kind: null, card_ref: null };
  }

  function currentCard() {
    const now = currentNow();
    return now.kind === 'real'
      ? state.cards.find((card) => card?.card_id === now.card_ref) || null
      : null;
  }

  function currentWarmup() {
    const now = currentNow();
    return now.kind === 'warmup' && state.studio.current_warmup?.warmup_id === now.card_ref
      ? state.studio.current_warmup
      : null;
  }

  function setNowReal(card) {
    state.studio.now = { kind: 'real', card_ref: card.card_id };
    state.studio.current_card_id = card.card_id;
    state.studio.current_warmup = null;
  }

  function setNowWarmup(warmup) {
    state.studio.now = { kind: 'warmup', card_ref: warmup.warmup_id };
    state.studio.current_card_id = null;
    state.studio.current_warmup = warmup;
  }

  function setNowEmpty() {
    state.studio.now = { kind: null, card_ref: null };
    state.studio.current_card_id = null;
    state.studio.current_warmup = null;
  }

  function readyCard() {
    return studioReadyCard(state.studio, state.cards);
  }

  // Fast-path observations are the only signals with a durable, public
  // progress trail. Keep it tied to the canonical observation id rather than
  // a provider status string: the latter is transient and can describe a
  // different candidate after a reconnect.
  function observationForCandidate(candidate) {
    const fromReport = typeof candidate?.report?.observation_id === 'string'
      ? candidate.report.observation_id
      : '';
    if (fromReport) return fromReport;
    return typeof candidate?.activity_epoch_id === 'string'
      ? candidate.activity_epoch_id
      : '';
  }

  function isObservedCandidate(candidate) {
    return candidate?.report?.source === 'observed' && Boolean(observationForCandidate(candidate));
  }

  function setObservedProgress(candidate, reason = 'warmup-eligible') {
    const observationId = observationForCandidate(candidate);
    if (!isObservedCandidate(candidate) || !observationId) return;
    state.studio.progress = {
      phase: 'observed',
      observation_id: observationId,
      reason,
      updated_at: new Date(clock()).toISOString(),
    };
  }

  function setPreparingProgress(candidate) {
    const observationId = observationForCandidate(candidate);
    if (!isObservedCandidate(candidate) || !observationId) return;
    state.studio.progress = {
      phase: 'preparing',
      observation_id: observationId,
      reason: 'formal-lesson',
      updated_at: new Date(clock()).toISOString(),
    };
  }

  function clearProgressForCandidate(candidate) {
    const observationId = observationForCandidate(candidate);
    if (observationId && state.studio.progress?.observation_id === observationId) {
      state.studio.progress = null;
    }
  }

  function stableOutboxId(entry) {
    const parts = [
      entry.event,
      entry.observation_id,
      entry.activity_epoch_id,
      entry.warmup_id,
      entry.report_id,
      entry.card_id,
      entry.reason,
    ].filter((value) => typeof value === 'string' && value);
    return parts.join(':').slice(0, 160) || id();
  }

  function queueOutbox(entries = []) {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const outboxId = stableOutboxId(entry);
      if (state.studio.ledger_outbox.some((item) => item?.outbox_id === outboxId)) {
        continue;
      }
      state.studio.ledger_outbox.push({
        outbox_id: outboxId,
        entry: { ...entry, outbox_id: outboxId },
      });
    }
  }

  async function invokeTransitionHook(phase, context) {
    if (typeof transitionHook === 'function') {
      await transitionHook(phase, context);
    }
  }

  function scheduleOutboxRetry() {
    if (!writable() || outboxRetryTimer || outboxRetryAttempts >= safeMaxOutboxRetryAttempts) {
      return;
    }
    outboxRetryAttempts += 1;
    const delay = Math.min(5_000, safeOutboxRetryMs * (2 ** Math.max(0, outboxRetryAttempts - 1)));
    outboxRetryTimer = setTimeoutFn(() => {
      outboxRetryTimer = null;
      void serializeTransition(async () => {
        if (!writable()) {
          return;
        }
        const result = await flushLedgerOutbox({ scheduleRetry: false });
        if (!result.ok) {
          scheduleOutboxRetry();
          return;
        }
        outboxRetryAttempts = 0;
        // The original transition deliberately withheld SSE. Once the same
        // durable outbox has reached the ledger, publish the authoritative
        // projection and resume the same bounded generation path.
        emit();
        void pump();
      }).catch(() => scheduleOutboxRetry());
    }, delay);
    outboxRetryTimer?.unref?.();
  }

  async function flushLedgerOutbox({ scheduleRetry = true } = {}) {
    const pending = [...(state.studio.ledger_outbox || [])];
    if (pending.length === 0) {
      return { flushed: 0, ok: true };
    }
    if (!ledger || (typeof ledger.appendIdempotent !== 'function' && typeof ledger.append !== 'function')) {
      if (scheduleRetry) scheduleOutboxRetry();
      return { flushed: 0, ok: false };
    }
    let flushed = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      try {
        if (typeof ledger.appendIdempotent === 'function') {
          await ledger.appendIdempotent({ ...item.entry, outbox_id: item.outbox_id });
        } else {
          await ledger.append({ ...item.entry, outbox_id: item.outbox_id });
        }
        flushed += 1;
        await invokeTransitionHook('after-ledger-entry', { index, item });
      } catch {
        // Keep every unconfirmed entry on disk. A later owner can replay the
        // full suffix; ledger outbox ids make already written entries safe.
        state.studio.ledger_outbox = pending.slice(index);
        if (scheduleRetry) scheduleOutboxRetry();
        return { flushed, ok: false };
      }
    }
    state.studio.ledger_outbox = [];
    try {
      await persist();
    } catch (error) {
      // The ledger already has idempotent records, but the durable outbox
      // must remain until its cleared state is safely written. Restoring the
      // full list makes a later owner replay harmlessly rather than losing
      // its evidence after a cards.json write failure.
      state.studio.ledger_outbox = pending;
      if (scheduleRetry) scheduleOutboxRetry();
      return { error, flushed, ok: false };
    }
    outboxRetryAttempts = 0;
    return { flushed, ok: true };
  }

  async function commitOutboxTransition(entries, { afterPersist = null, afterLedger = null, broadcastCard = null } = {}) {
    if (!writable()) {
      return false;
    }
    queueOutbox(entries);
    await persist();
    if (!writable()) {
      return false;
    }
    await invokeTransitionHook('after-persist-before-ledger', { entries });
    if (typeof afterPersist === 'function') {
      await afterPersist();
    }
    const result = await flushLedgerOutbox();
    if (!result.ok) {
      return false;
    }
    if (!writable()) {
      return false;
    }
    if (typeof afterLedger === 'function') {
      await afterLedger();
    }
    if (!writable()) {
      return false;
    }
    await invokeTransitionHook('after-ledger-before-sse', { entries });
    if (broadcastCard) {
      hub?.broadcast?.('card', cardForClient(broadcastCard));
    }
    emit();
    return true;
  }

  function serializeTransition(work) {
    const queued = transitionTail.then(work);
    transitionTail = queued.catch(() => {});
    return queued;
  }

  function reportIdForCard(card) {
    return typeof card?.source?.report_id === 'string' && card.source.report_id
      ? card.source.report_id
      : undefined;
  }

  function sourceForCard(card) {
    const kind = card?.source?.kind;
    return typeof kind === 'string' && kind ? kind : 'agent';
  }

  function ledgerEntryForCard(card, { event, reason, state: ledgerState }) {
    return {
      at: nowIso(),
      card_id: card.card_id,
      concept_id: card.concept_id,
      event,
      reason,
      report_id: reportIdForCard(card),
      source: sourceForCard(card),
      state: ledgerState,
    };
  }

  /**
   * There is exactly one mutable hidden-buffer record. Clearing it always
   * leaves an activity trace tied to the exact card, so a prior delivery can
   * never become the misleading final ledger state for a vanished lesson.
   */
  function takeReady() {
    const buffered = readyCard();
    if (!buffered) {
      return null;
    }
    state.studio.ready_card = null;
    return buffered;
  }

  async function discardReadyNow({ event = 'refusal', reason = 'discarded', state: ledgerState = 'suppressed' } = {}) {
    if (!writable()) {
      return null;
    }
    const buffered = takeReady();
    if (!buffered) {
      return null;
    }
    const committed = await commitOutboxTransition([
      ledgerEntryForCard(buffered, { event, reason, state: ledgerState }),
    ]);
    if (committed) {
      void pump();
    }
    return buffered;
  }

  function discardReady(options) {
    return serializeTransition(() => discardReadyNow(options));
  }

  async function suppressMastered(candidate, card) {
    if (!writable()) {
      return { accepted: false, reason: 'owner-inactive', state: 'suppressed' };
    }
    clearProgressForCandidate(candidate);
    const committed = await commitOutboxTransition([{
      at: nowIso(),
      card_id: card.card_id,
      concept_id: card.concept_id,
      event: 'refusal',
      reason: 'mastered',
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: 'suppressed',
    }]);
    if (committed) {
      void pump();
    }
    return { accepted: false, reason: committed ? 'mastered' : 'outbox-pending', state: 'suppressed' };
  }

  function emit() {
    if (writable()) {
      hub?.broadcast?.('studio', projection());
    }
  }

  function persist() {
    const work = writeTail.then(() => persistence.saveCards(state.cards, state.studio));
    writeTail = work.catch(() => {});
    return work;
  }

  function waiting() {
    return studioWaiting(state.studio);
  }

  function status() {
    const current = currentCard();
    const warmup = currentWarmup();
    return {
      candidate_count: state.studio.candidates.length + (state.studio.deferred_epoch_candidate ? 1 : 0),
      current: current || warmup
        ? {
          answered: Boolean((current || warmup).state?.answered),
          card_id: current?.card_id || warmup?.warmup_id,
          kind: current ? 'real' : 'warmup',
        }
        : null,
      generation_in_flight: Boolean(state.studio.generation.in_flight),
      next_ready: Boolean(readyCard()),
      progress: state.studio.progress,
      unanswered_count: countUnansweredExcludingReady(state.cards, state.studio),
      waiting: waiting(),
    };
  }

  function projection() {
    return {
      ...studioSnapshot(state.studio, state.cards),
      // The browser sends this optimistic-concurrency marker back only for
      // auto-advance. A later learner interaction invalidates an in-flight
      // automatic transition without ever hiding the manual Next control.
      interaction_token: interactionVersion,
    };
  }

  function candidateEpoch(candidate) {
    return typeof candidate?.activity_epoch_id === 'string' && candidate.activity_epoch_id
      ? candidate.activity_epoch_id
      : null;
  }

  function queueCandidate(candidate) {
    if (state.studio.candidates.length < MAX_CANDIDATES) {
      state.studio.candidates.push(candidate);
      return { coalesced: false, accepted: true };
    }

    const incomingEpoch = candidateEpoch(candidate);
    const queuedEpochs = state.studio.candidates.filter((item) => candidateEpoch(item));
    const queuedPlainIndexes = state.studio.candidates
      .map((item, index) => (candidateEpoch(item) ? -1 : index))
      .filter((index) => index >= 0);

    if (incomingEpoch) {
      // An epoch-linked true card is allowed to replace only its own warmup.
      // Never merge it with a different epoch (or a plain aggregate), because
      // doing so could give unrelated provider output the warmup's epoch id.
      // If both slots are already occupied, refuse this new fast-path epoch
      // honestly rather than silently changing a learner-facing association.
      if (queuedEpochs.length > 0) {
        return { accepted: false, reason: 'rate-limited' };
      }
      // Two ordinary aggregate candidates can be safely coalesced to free one
      // slot for the indivisible fast-path epoch.
      const [first, second] = state.studio.candidates;
      const merged = coalesceCandidates(first, second, { clock });
      state.studio.candidates.splice(0, state.studio.candidates.length, merged, candidate);
      return { accepted: true, coalesced: true, merged };
    }

    if (queuedPlainIndexes.length === 0) {
      // Both persisted slots belong to distinct warmup epochs. Preserve their
      // association and let the ordinary aggregate be retried by a later
      // signal instead of corrupting either epoch.
      return { accepted: false, reason: 'epoch-capacity' };
    }

    if (queuedPlainIndexes.length === 1) {
      const index = queuedPlainIndexes[0];
      const merged = coalesceCandidates(state.studio.candidates[index], candidate, { clock });
      state.studio.candidates[index] = merged;
      return { accepted: true, coalesced: true, merged };
    }

    // The legacy all-ordinary case retains the newest signal separately while
    // preserving the older provenance as one bounded aggregate.
    const first = state.studio.candidates.shift();
    const second = state.studio.candidates.shift();
    const merged = coalesceCandidates(first, second, { clock });
    state.studio.candidates.push(merged, candidate);
    return { accepted: true, coalesced: true, merged };
  }

  /**
   * A qualifying observation has two independent outcomes: the immediate
   * local warmup and its same-epoch true-card request. The former must never
   * disappear merely because the normal two-signal generation watermark is
   * momentarily full. Keep one exact epoch candidate aside instead of
   * coalescing it with unrelated provenance; `pump()` moves it back as soon
   * as an ordinary slot opens.
   */
  function queueFastPathCandidate(candidate) {
    const queued = queueCandidate(candidate);
    if (queued.accepted) {
      return queued;
    }
    if (!candidateEpoch(candidate)) {
      return queued;
    }
    const deferred = state.studio.deferred_epoch_candidate;
    if (!deferred) {
      state.studio.deferred_epoch_candidate = candidate;
      return { accepted: true, deferred: true, reason: 'rate-limited' };
    }
    if (candidateEpoch(deferred) === candidateEpoch(candidate)) {
      return { accepted: false, reason: 'epoch-duplicate' };
    }
    return { accepted: false, reason: 'rate-limited' };
  }

  function promoteDeferredEpochCandidate() {
    const deferred = state.studio.deferred_epoch_candidate;
    if (!deferred || state.studio.candidates.length >= MAX_CANDIDATES) {
      return false;
    }
    state.studio.deferred_epoch_candidate = null;
    // The deferred candidate already carries exact activity provenance. Do
    // not send it back through coalescing logic that was intentionally built
    // for ordinary aggregate reports.
    state.studio.candidates.unshift(deferred);
    return true;
  }

  function sameCanonicalWarmupConcept(warmup, card) {
    const warmupConcept = canonicalWarmupConceptId(warmup?.concept_id, warmupCatalog);
    const cardConcept = canonicalWarmupConceptId(card?.concept_id, warmupCatalog);
    return Boolean(warmupConcept && cardConcept && warmupConcept === cardConcept);
  }

  function activityEpochsFor(report) {
    return [...new Set([
      report?.activity_epoch_id,
      ...(Array.isArray(report?.activity_epoch_ids) ? report.activity_epoch_ids : []),
    ].filter((value) => typeof value === 'string' && value))];
  }

  function hasActivityEpoch(epochId) {
    return state.studio.warmup_dedupe.some((item) => item?.activity_epoch_id === epochId);
  }

  function rememberWarmupDedupe({ key, observation_id: observationId, activity_epoch_id: epochId, concept_id: conceptId, warmup_id: warmupId }) {
    if (!key || !observationId || !epochId || !conceptId) {
      return false;
    }
    if (state.studio.warmup_dedupe.some((item) => item?.key === key || item?.activity_epoch_id === epochId)) {
      return false;
    }
    state.studio.warmup_dedupe.push({
      activity_epoch_id: epochId,
      concept_id: conceptId,
      key,
      observation_id: observationId,
      ...(warmupId ? { warmup_id: warmupId } : {}),
    });
    state.studio.warmup_dedupe = state.studio.warmup_dedupe.slice(-128);
    return true;
  }

  function archiveWarmup(warmup) {
    if (!warmup) {
      return;
    }
    state.studio.warmup_history.push(warmup);
    state.studio.warmup_history = state.studio.warmup_history.slice(-50);
    setNowEmpty();
  }

  function isKnownWarmupId(warmupId) {
    return typeof warmupId === 'string' && Boolean(
      currentWarmup()?.warmup_id === warmupId
      || state.studio.warmup_history.some((warmup) => warmup?.warmup_id === warmupId),
    );
  }

  function canGenerate() {
    return writable()
      && !reloading
      && Boolean(generator)
      && !state.studio.generation.in_flight
      && !readyCard()
      && (state.studio.candidates.length > 0 || state.studio.deferred_epoch_candidate);
  }

  async function generationFailureNow(candidate) {
    if (!writable()) {
      return { state: 'owner-inactive' };
    }
    state.studio.generation = { candidate: null, in_flight: false, started_at: null };
    clearProgressForCandidate(candidate);
    const committed = await commitOutboxTransition([{
      activity_epoch_id: candidate.activity_epoch_id,
      at: nowIso(),
      event: 'failure',
      reason: 'generation-failed',
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: 'failed',
    }]);
    return { state: committed ? 'failed' : 'outbox-pending' };
  }

  function generationFailure(candidate) {
    return serializeTransition(() => generationFailureNow(candidate));
  }

  async function generationWaitingNow(candidate, reason = 'generation-queue-full') {
    if (!writable()) {
      return { state: 'owner-inactive' };
    }
    state.studio.generation = { candidate: null, in_flight: false, started_at: null };
    // The signal was already durable before provider work started. Put it
    // back at the front rather than turning a temporary broker slot shortage
    // into a silent lesson loss.
    const requeued = queueCandidate(candidate);
    // Provider capacity is temporarily unavailable, so this remains a
    // truthfully observed activity rather than a stale "preparing" spinner.
    setObservedProgress(candidate, requeued.accepted ? reason : requeued.reason || reason);
    const committed = await commitOutboxTransition([{
      activity_epoch_id: candidate.activity_epoch_id,
      at: nowIso(),
      event: 'refusal',
      reason: requeued.accepted ? reason : requeued.reason || reason,
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: 'waiting',
    }]);
    return { state: committed ? 'waiting' : 'outbox-pending' };
  }

  function generationWaiting(candidate, reason) {
    return serializeTransition(() => generationWaitingNow(candidate, reason));
  }

  async function generationSettledNow(candidate, result) {
    if (!writable()) {
      return { state: 'owner-inactive' };
    }
    state.studio.generation = { candidate: null, in_flight: false, started_at: null };
    clearProgressForCandidate(candidate);
    const outcomeState = result?.state === 'failed' ? 'failed' : 'suppressed';
    const reason = typeof result?.reason === 'string' && result.reason
      ? result.reason
      : outcomeState === 'failed' ? 'generation-failed' : 'generation-suppressed';
    const committed = await commitOutboxTransition([{
      activity_epoch_id: candidate.activity_epoch_id,
      at: nowIso(),
      ...(typeof result?.concept_id === 'string' && result.concept_id ? { concept_id: result.concept_id } : {}),
      event: outcomeState === 'failed' ? 'failure' : 'refusal',
      reason,
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: outcomeState,
    }], {
      afterLedger: async () => {
        if (result?.status && typeof result.status === 'object') {
          hub?.broadcast?.('status', result.status);
        }
      },
    });
    return { state: committed ? result?.state || 'suppressed' : 'outbox-pending' };
  }

  function generationSettled(candidate, result) {
    return serializeTransition(() => generationSettledNow(candidate, result));
  }

  function pump() {
    if (!writable()) {
      return Promise.resolve({ state: 'owner-inactive' });
    }
    // A deferred fast-path epoch is promoted before we decide whether work is
    // available. This is the only route that drains the one bounded deferred
    // slot, and its state change is persisted with the generation handoff
    // below before a provider can observe the report.
    if (!readyCard()) {
      promoteDeferredEpochCandidate();
    }
    if (!canGenerate()) {
      return Promise.resolve({ state: status().waiting?.reason || 'idle' });
    }
    const candidate = state.studio.candidates.shift();
    state.studio.generation = {
      candidate,
      in_flight: true,
      started_at: new Date(clock()).toISOString(),
    };
    setPreparingProgress(candidate);
    const run = persist()
      .then(() => {
        if (!writable()) {
          return { state: 'owner-inactive' };
        }
        emit();
        return generator(candidate.report, candidate);
      })
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

  async function receiveGeneratedNow(candidateOrReport, card) {
    if (!writable()) {
      return { accepted: false, state: 'owner-inactive' };
    }
    const candidate = candidateFor(candidateOrReport) || state.studio.generation.candidate;
    if (!candidate || !card || typeof card.card_id !== 'string') {
      return { accepted: false, state: 'unmatched-generation' };
    }
    if (state.studio.generation.candidate?.candidate_id === candidate.candidate_id) {
      state.studio.generation = { candidate: null, in_flight: false, started_at: null };
    }
    // The provider checked mastery before generation, but an answer can land
    // while it is working. Recheck at placement so neither Now nor Next can
    // receive a concept that has become gold in the meantime.
    if (isMastered(state.strengths, card.concept_id)) {
      return suppressMastered(candidate, card);
    }
    let placement;
    const now = currentNow();
    const warmup = currentWarmup();
    if (now.kind === null) {
      placement = 'current';
    } else if (
      now.kind === 'warmup'
      && warmup
      && !warmup.state?.answered
      && typeof candidate.activity_epoch_id === 'string'
      && candidate.activity_epoch_id === warmup.activity_epoch_id
      && sameCanonicalWarmupConcept(warmup, card)
    ) {
      placement = 'replace-warmup';
    } else if (!readyCard()) {
      placement = 'ready';
    } else {
      // A caller may race an old provider result against a newly-filled
      // buffer. Never create a third hidden question.
      const requeued = queueCandidate(candidate);
      const committed = await commitOutboxTransition([{
        activity_epoch_id: candidate.activity_epoch_id,
        at: nowIso(),
        event: 'refusal',
        reason: requeued.accepted ? 'watermark-full' : requeued.reason || 'watermark-full',
        report_id: candidate.report.report_id,
        source: sourceKind(candidate.report),
        state: 'waiting',
      }]);
      return { accepted: false, state: committed ? 'watermark-full' : 'outbox-pending' };
    }
    const persisted = await persistGenerated(card, placement);
    if (!writable()) {
      return { accepted: false, state: 'owner-inactive' };
    }
    if (!persisted) {
      // `beforeDelivery` can observe a correct answer that raced the provider
      // result. That is a terminal mastered suppression, not a temporary
      // delivery delay that should be requeued.
      if (isMastered(state.strengths, card.concept_id)) {
        return suppressMastered(candidate, card);
      }
      // A pause or pacing/cap decision can happen after a slow provider has
      // returned. Preserve the original signal instead of letting that race
      // erase a lesson opportunity; a later explicit Next or new signal can
      // safely ask the bounded coordinator to try again.
      const requeued = queueCandidate(candidate);
      const committed = await commitOutboxTransition([{
        activity_epoch_id: candidate.activity_epoch_id,
        at: nowIso(),
        event: 'refusal',
        reason: requeued.accepted ? 'delivery-deferred' : requeued.reason || 'delivery-deferred',
        report_id: candidate.report.report_id,
        source: sourceKind(candidate.report),
        state: 'waiting',
      }]);
      return { accepted: false, state: committed ? 'waiting' : 'outbox-pending' };
    }
    // `persistCard` is allowed to await pacing/eligibility. Make the final
    // mastery decision after that await and before any state write, which is
    // the only atomic placement point for both current and ready cards.
    if (isMastered(state.strengths, card.concept_id)) {
      return suppressMastered(candidate, card);
    }
    // Commit one complete buffer record only after asynchronous eligibility
    // work has settled. A relay takeover may reload state while the provider
    // is waiting above; it can now see either the old state or this complete
    // state, never a pointer without a card.
    if (placement === 'current' || placement === 'replace-warmup') {
      if (!state.cards.some((item) => item?.card_id === card.card_id)) {
        state.cards.push(card);
      }
      if (placement === 'replace-warmup') {
        archiveWarmup(warmup);
      }
      setNowReal(card);
    } else {
      state.studio.ready_card = card;
    }
    clearProgressForCandidate(candidate);
    // Persist the cadence only after the question is actually on the wall.
    // A provider result that is deferred by pause, backpressure, or mastery
    // is not an unsolicited delivery and must not create a phantom 12s gap
    // after a restart.
    if (placement === 'current' || placement === 'replace-warmup') {
      state.studio.last_unsolicited_delivery_at = clock();
    }
    const ledgerEntries = [{
      activity_epoch_id: candidate.activity_epoch_id,
      at: nowIso(),
      event: 'provider-result',
      concept_id: card.concept_id,
      report_id: candidate.report.report_id,
      source: sourceKind(candidate.report),
      state: 'observed',
    }];
    if (placement === 'replace-warmup') {
      ledgerEntries.push({
        activity_epoch_id: candidate.activity_epoch_id,
        at: nowIso(),
        card_id: card.card_id,
        concept_id: card.concept_id,
        event: 'warmup_replaced',
        observation_id: warmup.observation_id,
        reason: 'true-card-ready',
        report_id: candidate.report.report_id,
        source: sourceKind(candidate.report),
        state: 'delivered',
        warmup_id: warmup.warmup_id,
      });
    }
    if (placement === 'current' || placement === 'replace-warmup') {
      ledgerEntries.push({
        activity_epoch_id: candidate.activity_epoch_id,
        at: nowIso(),
        event: 'delivery',
        card_id: card.card_id,
        concept_id: card.concept_id,
        report_id: candidate.report.report_id,
        source: sourceKind(candidate.report),
        state: 'delivered',
      });
    } else {
      // A hidden Next lesson is durable and ready for the learner, but it is
      // not yet a visible delivery. Its eventual terminal trace is either a
      // voluntary promotion or an explicit suppression (for example mastery).
      ledgerEntries.push({
        activity_epoch_id: candidate.activity_epoch_id,
        at: nowIso(),
        event: 'buffered',
        reason: 'next-ready',
        card_id: card.card_id,
        concept_id: card.concept_id,
        report_id: candidate.report.report_id,
        source: sourceKind(candidate.report),
        state: 'waiting',
      });
    }
    const committed = await commitOutboxTransition(ledgerEntries, {
      afterLedger: async () => {
        if ((placement !== 'current' && placement !== 'replace-warmup') || typeof afterDelivery !== 'function') {
          return;
        }
        try {
          await afterDelivery(card, placement);
        } catch {
          // The visible card and its audit trace are already durable. A later
          // curriculum hydration can repair secondary bookkeeping; never erase
          // or relabel a lesson after the learner has received it.
        }
      },
      broadcastCard: placement === 'current' || placement === 'replace-warmup' ? card : null,
    });
    if (!committed) {
      return { accepted: false, card, placement, state: 'outbox-pending' };
    }
    // Persist the pointer and hidden buffer before notifying a browser. A
    // hard reload after the SSE event must reconstruct the exact same Now /
    // Next state rather than observing a half-written watermark.
    // Watermark pre-generation: once the first card becomes Now, one later
    // candidate may fill the hidden Next slot, but never more than one.
    void pump();
    return { accepted: true, card, placement, state: placement === 'current' || placement === 'replace-warmup' ? 'delivered' : 'ready' };
  }

  function receiveGenerated(candidateOrReport, card) {
    return serializeTransition(() => receiveGeneratedNow(candidateOrReport, card));
  }

  async function onWarmupCandidate({
    warmup = null,
    report = null,
    dedupe_key: dedupeKey = '',
    observation_id: observationId = '',
    activity_epoch_id: activityEpochId = observationId,
    concept_id: conceptId = warmup?.concept_id || '',
    suppression_reason: suppressionReason = null,
  } = {}) {
    return serializeTransition(async () => {
      if (!writable()) {
        return { accepted: false, committed: false, reason: 'owner-inactive', state: 'suppressed' };
      }
      const epochId = typeof activityEpochId === 'string' ? activityEpochId : '';
      const observation = typeof observationId === 'string' ? observationId : '';
      const concept = typeof conceptId === 'string' ? conceptId : '';
      const duplicate = !dedupeKey || !observation || !epochId || !concept
        || state.studio.warmup_dedupe.some((item) => item?.key === dedupeKey || item?.activity_epoch_id === epochId);
      if (duplicate) {
        const committed = await commitOutboxTransition([{
          activity_epoch_id: epochId,
          event: 'warmup_suppressed',
          observation_id: observation,
          reason: 'epoch-duplicate',
          source: 'observed',
          state: 'suppressed',
        }]);
        return { accepted: false, committed, reason: 'epoch-duplicate', state: 'suppressed' };
      }

      rememberWarmupDedupe({
        activity_epoch_id: epochId,
        concept_id: concept,
        key: dedupeKey,
        observation_id: observation,
        warmup_id: warmup?.warmup_id,
      });

      const entries = [{
        activity_epoch_id: epochId,
        concept_id: concept,
        event: 'observed',
        observation_id: observation,
        reason: 'warmup-eligible',
        report_id: report?.report_id,
        source: 'observed',
        state: 'observed',
      }];
      const candidate = candidateFrom({
        ...report,
        activity_epoch_id: epochId,
        observation_id: observation,
      }, {
        clock,
        id,
        warmupCatalog,
        warmupTargetConceptId: concept,
      });
      // The paired true-card candidate is durable independently of whether
      // its normal two-slot queue can start immediately. A full queue cannot
      // turn an empty Now into a missed local lesson.
      const queued = candidate ? queueFastPathCandidate(candidate) : { accepted: false, reason: 'catalog-invalid' };
      if (candidate && queued.accepted) {
        // This is committed with the observed ledger entry below, before the
        // broker is allowed to wake provider work. It is therefore a real
        // reconnect-safe phase, not a best-effort status toast.
        setObservedProgress(candidate, 'warmup-eligible');
      }

      let served = false;
      let reason = suppressionReason;
      if (!reason && !warmup) {
        reason = 'catalog-invalid';
      }
      // A visible warmup is only valid when the same transition has retained
      // its paired true-card candidate. `deferred` counts as retained; a
      // second overflow beyond that bounded slot is an honest rate-limit
      // suppression rather than a heat with no possible real follow-up.
      if (!reason && !queued.accepted) {
        reason = queued.reason || 'rate-limited';
      }
      if (!reason) {
        const now = currentNow();
        if (now.kind === null && !readyCard()) {
          setNowWarmup(warmup);
          served = true;
          entries.push({
            activity_epoch_id: epochId,
            concept_id: warmup.concept_id,
            event: 'warmup_served',
            observation_id: observation,
            reason: 'now-empty',
            source: 'observed',
            state: 'delivered',
            warmup_id: warmup.warmup_id,
          });
        } else {
          reason = readyCard()
            ? 'next-ready'
          : now.kind === 'real'
              ? 'current-real'
              : 'current-warmup';
        }
      }
      if (candidate && (!queued.accepted || queued.deferred)) {
        // This is the true-card scheduling outcome, not a false claim that
        // the warmup itself was suppressed. The deferred candidate remains
        // in durable state and `pump()` promotes it when capacity opens.
        entries.push({
          activity_epoch_id: epochId,
          event: 'refusal',
          reason: queued.reason || 'rate-limited',
          report_id: candidate.report.report_id,
          source: 'observed',
          state: 'waiting',
        });
      }
      if (!served) {
        entries.push({
          activity_epoch_id: epochId,
          concept_id: concept || undefined,
          event: 'warmup_suppressed',
          observation_id: observation,
          reason: reason || 'rate-limited',
          source: 'observed',
          state: 'suppressed',
          ...(warmup?.warmup_id ? { warmup_id: warmup.warmup_id } : {}),
        });
      }

      const committed = await commitOutboxTransition(entries);
      return {
        accepted: Boolean(served || (candidate && queued.accepted)),
        committed,
        // Deliberately do not call `pump()` here. The fast path's only job
        // is to persist/render the fixed local lesson plus its paired source
        // candidate. The broker wakes normal provider scheduling afterwards,
        // keeping this catalog-only transition free of generator subprocesses
        // and CODEX_HOME side effects.
        should_wake: Boolean(committed && candidate && queued.accepted),
        ...(served ? { warmup: warmupForClient(warmup) } : { reason }),
        state: served ? 'warmup-served' : 'suppressed',
      };
    });
  }

  async function recordWarmupSuppression({
    observation_id: observationId = '',
    activity_epoch_id: activityEpochId = observationId,
    concept_id: conceptId = '',
    reason = 'trigger-not-allowlisted',
  } = {}) {
    return serializeTransition(async () => {
      if (!writable()) {
        return { accepted: false, committed: false, reason: 'owner-inactive', state: 'suppressed' };
      }
      const committed = await commitOutboxTransition([{
        activity_epoch_id: activityEpochId,
        ...(conceptId ? { concept_id: conceptId } : {}),
        event: 'warmup_suppressed',
        observation_id: observationId,
        reason,
        source: 'observed',
        state: 'suppressed',
      }]);
      return { accepted: false, committed, reason, state: 'suppressed' };
    });
  }

  function enqueueReport(report) {
    if (!writable()) {
      return {
        accepted: false,
        done: Promise.resolve({ reason: 'owner-inactive', state: 'suppressed' }),
        report,
      };
    }
    const epochs = activityEpochsFor(report);
    if (epochs.length > 0 && epochs.every((epochId) => hasActivityEpoch(epochId))) {
      const done = serializeTransition(async () => {
        if (!writable()) {
          return { reason: 'owner-inactive', state: 'suppressed' };
        }
        const committed = await commitOutboxTransition([{
          at: nowIso(),
          event: 'refusal',
          reason: 'same-epoch-duplicate',
          report_id: report?.report_id,
          source: sourceKind(report),
          state: 'suppressed',
        }]);
        return { reason: 'same-epoch-duplicate', state: committed ? 'suppressed' : 'outbox-pending' };
      });
      return {
        accepted: false,
        done,
        report,
      };
    }
    const candidate = candidateFrom(report, { clock, id });
    if (!candidate) {
      return { accepted: false, done: Promise.resolve({ state: 'invalid-report' }), report };
    }
    const queued = queueCandidate(candidate);
    let generated = null;
    const transition = serializeTransition(async () => {
      if (!writable()) {
        return { reason: 'owner-inactive', state: 'suppressed' };
      }
      const committed = await commitOutboxTransition([{
        at: nowIso(),
        event: queued.accepted && !queued.coalesced ? 'accept' : 'refusal',
        reason: queued.accepted
          ? queued.coalesced ? 'studio-candidate-coalesced' : 'studio-candidate'
          : queued.reason || 'studio-candidate-rejected',
        report_id: candidate.report.report_id,
        source: sourceKind(candidate.report),
        state: 'waiting',
      }]);
      if (!committed) {
        return { reason: 'outbox-pending', state: 'waiting' };
      }
      if (!queued.accepted) {
        return { reason: queued.reason || 'studio-candidate-rejected', state: 'waiting' };
      }
      // Do not await the generation here: its completion re-enters this same
      // transition queue to place the card. Starting it after the durable
      // commit preserves ordering without a self-await deadlock.
      generated = pump();
      return null;
    });
    return {
      accepted: queued.accepted,
      done: transition.then((result) => generated || result),
      report: candidate.report,
    };
  }

  async function nextNow({ auto = false, enabled = true, interaction_token: token } = {}) {
    if (!writable()) {
      return { advanced: false, state: 'owner-inactive' };
    }
    if (auto && !enabled) {
      return { advanced: false, state: 'auto-advance-disabled' };
    }
    if (auto && currentNow().kind !== 'real') {
      return { advanced: false, state: 'auto-advance-current-not-real' };
    }
    if (auto && token !== undefined && token !== interactionVersion) {
      return { advanced: false, state: 'interaction-paused' };
    }
    const current = currentCard();
    const warmup = currentWarmup();
    const visible = current || warmup;
    if (visible && !visible.state?.answered) {
      return { advanced: false, state: 'answer-required' };
    }
    const nextCard = readyCard();
    if (!nextCard) {
      void pump();
      return { advanced: false, state: state.studio.generation.in_flight || state.studio.candidates.length ? 'preparing' : 'idle' };
    }
    if (isMastered(state.strengths, nextCard.concept_id)) {
      await discardReadyNow({ reason: 'mastered' });
      return { advanced: false, state: 'mastered' };
    }
    if (!auto) {
      interactionVersion += 1;
    }
    const promoted = readyCard();
    if (!writable() || !promoted) {
      return { advanced: false, state: 'idle' };
    }
    state.studio.ready_card = null;
    if (warmup) {
      archiveWarmup(warmup);
    }
    if (!state.cards.some((card) => card?.card_id === promoted.card_id)) {
      state.cards.push(promoted);
    }
    setNowReal(promoted);
    const committed = await commitOutboxTransition([{
      activity_epoch_id: promoted.source?.activity_epoch_id,
      at: nowIso(),
      event: 'promotion',
      reason: 'learner-next',
      card_id: promoted.card_id,
      concept_id: promoted.concept_id,
      report_id: reportIdForCard(promoted),
      source: sourceForCard(promoted),
      state: 'delivered',
    }], { broadcastCard: promoted });
    if (!committed) {
      return { advanced: false, state: 'outbox-pending' };
    }
    void pump();
    return { advanced: true, card: promoted, state: 'advanced' };
  }

  function next(options) {
    return serializeTransition(() => nextNow(options));
  }

  function warmupAnswerError() {
    const error = new Error('That warmup is no longer the question you are working on.');
    error.statusCode = 409;
    return error;
  }

  async function answerWarmup(value) {
    return serializeTransition(async () => {
      if (!writable()) {
        throw warmupAnswerError();
      }
      const warmup = currentWarmup();
      if (
        currentNow().kind !== 'warmup'
        || !warmup
        || !value
        || value.card_id !== warmup.warmup_id
      ) {
        throw warmupAnswerError();
      }
      if (warmup.state.answered) {
        return {
          correct: warmup.state.correct,
          explanation: warmup.explanation,
          warmup: true,
        };
      }
      const correct = value.chosen_index === warmup.correct_index;
      warmup.state = {
        answered: true,
        chosen_index: value.chosen_index,
        correct,
      };
      const committed = await commitOutboxTransition([]);
      if (!committed) {
        const error = new Error('The warmup answer is saved locally and will sync after recovery.');
        error.statusCode = 503;
        throw error;
      }
      return {
        correct,
        explanation: warmup.explanation,
        warmup: true,
      };
    });
  }

  function noteInteraction() {
    interactionVersion += 1;
    return interactionVersion;
  }

  function deactivate() {
    active = false;
    if (outboxRetryTimer) {
      clearTimeoutFn(outboxRetryTimer);
      outboxRetryTimer = null;
    }
  }

  async function clearPendingByConcept(conceptId, exceptCardId = null) {
    const buffered = readyCard();
    if (!buffered || buffered.concept_id !== conceptId || buffered.card_id === exceptCardId) {
      return 0;
    }
    // A correctly answered lesson makes an unseen duplicate actively
    // misleading. Remove the buffered copy before CardService clears the
    // legacy pending list, and make the pointer durable in the same write.
    const removed = await discardReady({ reason: 'mastered' });
    return removed ? 1 : 0;
  }

  function setGenerate(nextGenerator) {
    generator = typeof nextGenerator === 'function' ? nextGenerator : null;
    return pump();
  }

  async function waitForIdle() {
    while (true) {
      const writes = writeTail;
      const generation = activeGeneration;
      const transitions = transitionTail;
      await Promise.all([writes, generation || Promise.resolve(), transitions]);
      if (writes === writeTail && generation === activeGeneration && transitions === transitionTail) {
        return;
      }
    }
  }

  /**
   * Broker takeover hydrates into this same state object. Hold new pumps,
   * then wait for an in-flight generation and its durable write before the
   * caller replaces state from disk. This closes the old pointer/card reload
   * window without blocking MCP stdin or a learner's existing lesson.
   */
  async function reload(applyHydratedState, { resume = true } = {}) {
    if (typeof applyHydratedState !== 'function') {
      throw new TypeError('Studio reload needs a state hydration function.');
    }
    reloading = true;
    try {
      await waitForIdle();
      return await applyHydratedState();
    } finally {
      reloading = false;
      if (resume) {
        void pump();
      }
    }
  }

  return {
    acceptGenerated: receiveGenerated,
    answerWarmup,
    afterAnswer: () => {
      emit();
      return status();
    },
    canAutoAdvance: ({ enabled = false, interaction_token: token } = {}) => Boolean(
      enabled && readyCard() && currentNow().kind === 'real' && currentCard()?.state?.answered && (token === undefined || token === interactionVersion),
    ),
    countUnanswered: () => countUnansweredExcludingReady(state.cards, state.studio),
    clearPendingByConcept,
    currentCard,
    currentCardId: () => state.studio.current_card_id,
    currentNow,
    currentWarmup,
    deactivate,
    discardReady,
    enqueueReport,
    flushLedgerOutbox,
    interactionToken: () => interactionVersion,
    isKnownWarmupId,
    next,
    noteInteraction,
    onWarmupCandidate,
    projection,
    pump,
    readyCard,
    recordWarmupSuppression,
    receiveGenerated,
    reload,
    setGenerate,
    status,
    // A current-card delivery can synchronously start the one permitted
    // hidden-buffer generation just before its own promise settles. Recheck
    // both tails until they are stable so tests and broker handover never
    // mistake that handoff for an idle Studio.
    whenIdle: waitForIdle,
  };
}

module.exports = {
  MAX_CANDIDATES,
  candidateFrom,
  coalesceCandidates,
  countUnansweredExcludingReady,
  createStudioService,
  sourceKind,
};
