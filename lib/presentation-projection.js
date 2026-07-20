'use strict';

const PRESENTATION_PHASES = new Set(['observed', 'preparing', 'card-ready', 'idle']);

function bounded(value, maximum = 160) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null;
}

function idlePresentation(updatedAt = null) {
  return {
    epoch_id: null,
    phase: 'idle',
    reason: 'idle',
    stable_id: null,
    ...(bounded(updatedAt, 64) ? { updated_at: bounded(updatedAt, 64) } : {}),
  };
}

function normalizePresentation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return idlePresentation();
  const phase = PRESENTATION_PHASES.has(value.phase) ? value.phase : 'idle';
  if (phase === 'idle') return idlePresentation(value.updated_at);
  const epochId = bounded(value.epoch_id);
  const stableId = bounded(value.stable_id);
  const reason = bounded(value.reason, 256);
  if (!epochId || !stableId || !reason) return idlePresentation(value.updated_at);
  return {
    epoch_id: epochId,
    phase,
    reason,
    stable_id: stableId,
    ...(bounded(value.updated_at, 64) ? { updated_at: bounded(value.updated_at, 64) } : {}),
  };
}

function transitionPresentation(current, {
  epochId = null,
  phase = 'idle',
  reason = null,
  stableId = null,
  updatedAt = new Date().toISOString(),
} = {}) {
  if (!PRESENTATION_PHASES.has(phase) || phase === 'idle') return idlePresentation(updatedAt);
  const normalizedEpoch = bounded(epochId);
  const normalizedStable = bounded(stableId);
  const normalizedReason = bounded(reason, 256);
  if (!normalizedEpoch || !normalizedStable || !normalizedReason) return normalizePresentation(current);
  return {
    epoch_id: normalizedEpoch,
    phase,
    reason: normalizedReason,
    stable_id: normalizedStable,
    updated_at: bounded(updatedAt, 64) || new Date().toISOString(),
  };
}

/**
 * The activity strip is a read-only, recoverable projection. It consumes
 * ledger-shaped events but never changes Now/Next, card placement, pacing, or
 * provider scheduling. A state write simply retains the most recent visual
 * truth for an SSE reconnect.
 */
function projectLedgerEntries(current, entries, updatedAt = new Date().toISOString()) {
  let presentation = normalizePresentation(current);
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const entryEpochId = bounded(entry.activity_epoch_id);
    const epochId = entryEpochId || presentation.epoch_id;
    const observedId = bounded(entry.observation_id);
    const cardId = bounded(entry.card_id);
    const warmupId = bounded(entry.warmup_id);
    const reportId = bounded(entry.report_id);
    const stableId = observedId || warmupId || cardId || reportId;
    if (entry.event === 'observed') {
      presentation = transitionPresentation(presentation, {
        epochId,
        phase: 'observed',
        reason: entry.reason || 'observed',
        stableId: observedId || reportId,
        updatedAt: entry.at || updatedAt,
      });
      continue;
    }
    if (entry.event === 'accept' && entry.reason === 'studio-candidate' && entry.source === 'observed') {
      presentation = transitionPresentation(presentation, {
        epochId,
        phase: 'preparing',
        reason: entry.reason,
        stableId: reportId || presentation.stable_id,
        updatedAt: entry.at || updatedAt,
      });
      continue;
    }
    // A fast-path warmup is a useful immediate question, but it is not the
    // true generated lesson that this strip promises to prepare. Treating
    // warmup_served (or an internal provider result/buffer) as ready makes an
    // atomic observed+warmup transition visibly jump to ready, then regress to
    // preparing as its paired generation begins. Only a visible real-card
    // delivery/promotion/replacement may complete the strip.
    if (['delivery', 'promotion', 'warmup_replaced'].includes(entry.event)) {
      presentation = transitionPresentation(presentation, {
        epochId,
        phase: 'card-ready',
        reason: entry.event,
        stableId,
        updatedAt: entry.at || updatedAt,
      });
      continue;
    }
    if (['failure', 'refusal', 'warmup_suppressed'].includes(entry.event)
      && entryEpochId
      && (!presentation.epoch_id || entryEpochId === presentation.epoch_id)) {
      presentation = idlePresentation(entry.at || updatedAt);
    }
  }
  return presentation;
}

module.exports = {
  PRESENTATION_PHASES,
  idlePresentation,
  normalizePresentation,
  projectLedgerEntries,
  transitionPresentation,
};
