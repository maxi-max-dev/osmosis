'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await ensureDirectory(directory);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function emptyTree() {
  return { meta: {}, nodes: [] };
}

/**
 * Studio state deliberately lives beside cards rather than in the shared
 * profile. It is project-local, and keeping it in the same document as the
 * cards means a current/ready pointer can never refer to a different
 * project's history.
 */
function defaultStudioState() {
  return {
    // The hidden follow-up is a complete, durable card in this record rather
    // than an id pointing into `cards`. That makes buffer occupancy, the
    // wire-level `next_ready` flag, and the eventual Next promotion one
    // state-machine fact instead of three loosely synchronized facts.
    version: 3,
    // `now` is the authoritative learner-facing slot. `current_card_id`
    // remains as a legacy compatibility pointer for real cards only.
    now: { kind: null, card_ref: null },
    current_card_id: null,
    // Warmups never enter the real card history. While one is visible its
    // complete, answerable payload lives here; an answered/replaced card is
    // moved to warmup_history instead.
    current_warmup: null,
    warmup_history: [],
    // Bounded durable keys prevent the same observed session/concept from
    // serving another warmup after an owner restart or takeover.
    warmup_dedupe: [],
    // State and activity trace commit together through this local outbox.
    // The owner flushes entries idempotently before broadcasting SSE.
    ledger_outbox: [],
    // A small, durable status record for the warmup fast path. Unlike a
    // transient provider `status` event, this survives a reconnect and lets
    // the Studio truthfully show the path from an observed activity to real
    // lesson preparation.
    progress: null,
    ready_card: null,
    // A fast-path observation always creates its paired true-card candidate.
    // If the ordinary two-slot generation watermark is full of indivisible
    // epoch candidates, retain one bounded deferred epoch rather than making
    // an otherwise empty Now suppress its local warmup. It is never visible
    // to the learner and is promoted into `candidates` as soon as a slot
    // opens.
    deferred_epoch_candidate: null,
    candidates: [],
    generation: {
      candidate: null,
      in_flight: false,
      started_at: null,
    },
    last_unsolicited_delivery_at: null,
  };
}

function boundedString(value, maximum) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : null;
}

/**
 * The progress record deliberately has only two public phases. `observed`
 * means a qualifying local activity has been durably accepted; `preparing`
 * means its paired true-card candidate is now being worked on. The internal
 * reason is retained alongside the observation id so a reconnect cannot turn
 * a concrete activity into a generic spinner.
 */
function normalizeStudioProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const phase = value.phase === 'observed' || value.phase === 'preparing'
    ? value.phase
    : null;
  const observationId = boundedString(value.observation_id, 160);
  const reason = boundedString(value.reason, 160);
  if (!phase || !observationId || !reason) {
    return null;
  }
  return {
    phase,
    observation_id: observationId,
    reason,
    ...(boundedString(value.updated_at, 64) ? { updated_at: boundedString(value.updated_at, 64) } : {}),
  };
}

function isStudioCard(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && boundedString(value.card_id, 128)
    && value.state
    && typeof value.state === 'object'
    && !Array.isArray(value.state),
  );
}

function normalizeWarmupCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const warmupId = boundedString(value.warmup_id, 128);
  const conceptId = boundedString(value.concept_id, 256);
  const title = boundedString(value.title, 240);
  const lesson = boundedString(value.lesson, 4_000);
  const question = boundedString(value.question, 1_024);
  const explanation = boundedString(value.explanation, 4_000);
  const observationId = boundedString(value.observation_id, 160);
  const epochId = boundedString(value.activity_epoch_id, 160);
  const options = Array.isArray(value.options)
    ? value.options.filter((option) => typeof option === 'string' && option.trim()).map((option) => option.slice(0, 1_024)).slice(0, 3)
    : [];
  if (
    !warmupId || !conceptId || !title || !lesson || !question || !explanation
    || !observationId || !epochId || options.length !== 3 || !Number.isInteger(value.correct_index)
    || value.correct_index < 0 || value.correct_index > 2
  ) {
    return null;
  }
  const cardState = value.state && typeof value.state === 'object' && !Array.isArray(value.state)
    ? value.state
    : {};
  const catalogVersion = Number.isInteger(value.catalog_version) && value.catalog_version > 0
    ? value.catalog_version
    : boundedString(value.catalog_version, 64) || 1;
  return {
    activity_epoch_id: epochId,
    catalog_version: catalogVersion,
    concept_id: conceptId,
    concept_name: boundedString(value.concept_name, 240) || title,
    correct_index: value.correct_index,
    created_at: boundedString(value.created_at, 64) || null,
    explanation,
    lesson,
    observation_id: observationId,
    options,
    question,
    state: {
      answered: cardState.answered === true,
      chosen_index: Number.isInteger(cardState.chosen_index) ? cardState.chosen_index : null,
      correct: typeof cardState.correct === 'boolean' ? cardState.correct : null,
    },
    title,
    warmup_id: warmupId,
  };
}

function warmupForClient(warmup) {
  const normalized = normalizeWarmupCard(warmup);
  if (!normalized) {
    return null;
  }
  const { correct_index, explanation, ...visibleWarmup } = normalized;
  return normalized.state.answered
    ? { ...visibleWarmup, explanation }
    : visibleWarmup;
}

function normalizeStudioNow(value, cards, currentWarmup, legacyCurrentCardId) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const kind = raw?.kind;
  const cardRef = boundedString(raw?.card_ref, 128);
  const cardIds = new Set((Array.isArray(cards) ? cards : []).map((card) => card?.card_id).filter(Boolean));
  if (kind === 'real' && cardRef && cardIds.has(cardRef)) {
    return { kind: 'real', card_ref: cardRef };
  }
  if (kind === 'warmup' && cardRef && currentWarmup?.warmup_id === cardRef) {
    return { kind: 'warmup', card_ref: cardRef };
  }
  if (kind === null) {
    return { kind: null, card_ref: null };
  }
  // v2 documents had only the real card pointer. This one-way migration is
  // intentionally used only if no explicit v3 `now` value was stored.
  if (!raw && legacyCurrentCardId && cardIds.has(legacyCurrentCardId)) {
    return { kind: 'real', card_ref: legacyCurrentCardId };
  }
  return { kind: null, card_ref: null };
}

function normalizeWarmupDedupe(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const unique = new Set();
  const normalized = [];
  for (const item of value) {
    const key = boundedString(item?.key, 384);
    const observationId = boundedString(item?.observation_id, 160);
    const epochId = boundedString(item?.activity_epoch_id, 160);
    const conceptId = boundedString(item?.concept_id, 256);
    if (!key || !observationId || !epochId || !conceptId || unique.has(key)) {
      continue;
    }
    unique.add(key);
    normalized.push({
      activity_epoch_id: epochId,
      concept_id: conceptId,
      key,
      observation_id: observationId,
      ...(boundedString(item?.warmup_id, 128) ? { warmup_id: boundedString(item.warmup_id, 128) } : {}),
    });
    if (normalized.length >= 128) {
      break;
    }
  }
  return normalized;
}

function normalizeLedgerOutbox(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const outboxId = boundedString(item?.outbox_id, 160);
    const entry = item?.entry;
    if (!outboxId || !entry || typeof entry !== 'object' || Array.isArray(entry) || seen.has(outboxId)) {
      continue;
    }
    const event = boundedString(entry.event, 96);
    const state = boundedString(entry.state, 32);
    if (!event || !state) {
      continue;
    }
    seen.add(outboxId);
    const safeEntry = { event, state };
    for (const [key, maximum] of [
      ['activity_epoch_id', 160], ['card_id', 128], ['concept_id', 256], ['observation_id', 160],
      ['reason', 256], ['report_id', 128], ['source', 96], ['warmup_id', 128], ['ts', 64],
    ]) {
      const text = boundedString(entry[key], maximum);
      if (text) safeEntry[key] = text;
    }
    normalized.push({ outbox_id: outboxId, entry: safeEntry });
  }
  return normalized;
}

/**
 * The one authoritative hidden-buffer record. `ready_card_id` is accepted
 * only as a legacy read migration: old documents kept the actual card in the
 * compatibility card array, which made a reload between two writes able to
 * orphan it. New state never writes that pointer.
 */
function studioReadyCard(studio, cards = []) {
  const direct = studio?.ready_card;
  if (isStudioCard(direct)) {
    return direct;
  }
  const legacyId = boundedString(studio?.ready_card_id, 128);
  if (!legacyId) {
    return null;
  }
  return Array.isArray(cards)
    ? cards.find((card) => card?.card_id === legacyId && isStudioCard(card)) || null
    : null;
}

function normalizeStudioReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const task = boundedString(value.task, 240);
  const whatIDid = boundedString(value.what_i_did, 4_000);
  const stackHints = Array.isArray(value.stack_hints)
    ? value.stack_hints.filter((hint) => typeof hint === 'string' && hint.trim()).map((hint) => hint.slice(0, 120)).slice(0, 12)
    : [];
  if (!task || !whatIDid || stackHints.length === 0) {
    return null;
  }
  return {
    task,
    what_i_did: whatIDid,
    stack_hints: stackHints,
    ...(boundedString(value.report_id, 128) ? { report_id: boundedString(value.report_id, 128) } : {}),
    // A fast-path activity carries this stable local hash all the way through
    // its paired provider candidate. It is safe metadata (never a raw rollout
    // payload) and lets the visible progress state stay tied to one exact
    // observation after a reconnect or owner handover.
    ...(boundedString(value.observation_id, 160) ? { observation_id: boundedString(value.observation_id, 160) } : {}),
    ...(boundedString(value.activity_epoch_id, 160) ? { activity_epoch_id: boundedString(value.activity_epoch_id, 160) } : {}),
    ...(Array.isArray(value.activity_epoch_ids)
      ? {
        activity_epoch_ids: [...new Set(value.activity_epoch_ids
          .filter((id) => typeof id === 'string' && id)
          .map((id) => id.slice(0, 160)))].slice(0, 12),
      }
      : {}),
    // Preserve the provenance class through the durable candidate. Agent is
    // explicit rather than implied so status/ledger consumers never have to
    // guess whether a waiting signal was observed or reported.
    source: value.source === 'observed' ? 'observed' : 'agent',
    ...(value.observed_kind === 'change' ? { observed_kind: 'change' } : {}),
  };
}

function normalizeStudioCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const report = normalizeStudioReport(value.report);
  const candidateId = boundedString(value.candidate_id, 128);
  if (!report || !candidateId) {
    return null;
  }
  const reportIds = Array.isArray(value.report_ids)
    ? value.report_ids.filter((id) => typeof id === 'string' && id).map((id) => id.slice(0, 128)).slice(0, 12)
    : report.report_id
      ? [report.report_id]
      : [];
  return {
    candidate_id: candidateId,
    report,
    report_ids: [...new Set(reportIds)],
    // This field is written only by the owner-side warmup transition. It
    // survives a takeover beside the epoch so the resumed provider request
    // cannot lose the one concept allowed to replace that warmup.
    ...(boundedString(value.warmup_target_concept_id, 256)
      ? { warmup_target_concept_id: boundedString(value.warmup_target_concept_id, 256) }
      : {}),
    ...(boundedString(value.activity_epoch_id, 160)
      ? { activity_epoch_id: boundedString(value.activity_epoch_id, 160) }
      : boundedString(report.activity_epoch_id, 160)
        ? { activity_epoch_id: boundedString(report.activity_epoch_id, 160) }
        : {}),
    created_at: boundedString(value.created_at, 64) || null,
    updated_at: boundedString(value.updated_at, 64) || null,
  };
}

// A provider request is intentionally not resumed across process boundaries.
// If the process stops with that request plus the two normal candidates,
// retain all of the source provenance by coalescing the two oldest signals
// instead of silently truncating the third one during normalization.
function coalesceRestoredStudioCandidates(left, right) {
  const reports = [left?.report, right?.report].filter(Boolean);
  const first = reports[0] || {};
  const last = reports.at(-1) || first;
  const reportIds = [...new Set([
    ...(Array.isArray(left?.report_ids) ? left.report_ids : []),
    ...(Array.isArray(right?.report_ids) ? right.report_ids : []),
    ...reports.map((report) => report.report_id).filter(Boolean),
  ])].slice(0, 12);
  const stackHints = [...new Set(reports.flatMap((report) => report.stack_hints || []))].slice(0, 12);
  return {
    candidate_id: left?.candidate_id || right?.candidate_id,
    ...(boundedString(left?.warmup_target_concept_id, 256)
      ? { warmup_target_concept_id: boundedString(left.warmup_target_concept_id, 256) }
      : boundedString(right?.warmup_target_concept_id, 256)
        ? { warmup_target_concept_id: boundedString(right.warmup_target_concept_id, 256) }
        : {}),
    created_at: left?.created_at || right?.created_at || null,
    report: {
      ...last,
      task: reports.map((report) => report.task).filter(Boolean).join(' · ').slice(0, 240),
      what_i_did: reports.map((report) => report.what_i_did).filter(Boolean).join(' ').slice(0, 4_000),
      stack_hints: stackHints.length > 0 ? stackHints : first.stack_hints || [],
      ...(reportIds[0] ? { report_id: reportIds[0] } : {}),
    },
    report_ids: reportIds,
    updated_at: right?.updated_at || left?.updated_at || null,
  };
}

function candidateActivityEpoch(candidate) {
  return boundedString(candidate?.activity_epoch_id, 160)
    || boundedString(candidate?.report?.activity_epoch_id, 160)
    || null;
}

function restoreBoundedCandidates(candidates) {
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.candidate_id)) {
      continue;
    }
    seen.add(candidate.candidate_id);
    unique.push(candidate);
  }
  if (unique.length <= 2) {
    return unique;
  }

  // A warmup epoch is an exact provenance contract, not an aggregation hint.
  // Retain epoch candidates individually across a restart; merging their
  // reports would let unrelated provider output replace a visible warmup.
  const epochCandidates = unique.filter((candidate) => candidateActivityEpoch(candidate));
  const plainCandidates = unique.filter((candidate) => !candidateActivityEpoch(candidate));
  if (epochCandidates.length >= 2) {
    return epochCandidates.slice(0, 2);
  }
  if (epochCandidates.length === 1) {
    if (plainCandidates.length === 0) {
      return epochCandidates;
    }
    let mergedPlain = plainCandidates[0];
    for (const next of plainCandidates.slice(1)) {
      mergedPlain = coalesceRestoredStudioCandidates(mergedPlain, next);
    }
    return [epochCandidates[0], mergedPlain];
  }

  let bounded = [...plainCandidates];
  while (bounded.length > 2) {
    const first = bounded.shift();
    const second = bounded.shift();
    bounded.unshift(coalesceRestoredStudioCandidates(first, second));
  }
  return bounded;
}

function normalizeStudioState(value, cards = []) {
  const fallback = defaultStudioState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }
  const cardIds = new Set((Array.isArray(cards) ? cards : []).map((card) => card?.card_id).filter(Boolean));
  const legacyCurrentCardId = boundedString(value.current_card_id, 128);
  const currentWarmup = normalizeWarmupCard(value.current_warmup);
  const progress = normalizeStudioProgress(value.progress);
  const now = normalizeStudioNow(value.now, cards, currentWarmup, legacyCurrentCardId);
  const readyCard = studioReadyCard(value, cards);
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.map(normalizeStudioCandidate).filter(Boolean).slice(0, 2)
    : [];
  const generation = value.generation && typeof value.generation === 'object' && !Array.isArray(value.generation)
    ? value.generation
    : {};
  const inFlightCandidate = normalizeStudioCandidate(generation.candidate);
  const deferredEpochCandidate = normalizeStudioCandidate(value.deferred_epoch_candidate);

  // An in-flight provider request cannot survive a process restart. Put its
  // durable signal back at the front of the bounded queue instead of leaving
  // a permanent "generating" state or silently losing the work that prompted
  // it.
  if (generation.in_flight && inFlightCandidate) {
    candidates.unshift(inFlightCandidate);
  }
  const uniqueCandidates = restoreBoundedCandidates(candidates);

  return {
    version: 3,
    now,
    current_card_id: now.kind === 'real' && cardIds.has(now.card_ref) ? now.card_ref : null,
    current_warmup: now.kind === 'warmup' ? currentWarmup : null,
    warmup_history: Array.isArray(value.warmup_history)
      ? value.warmup_history.map(normalizeWarmupCard).filter(Boolean).slice(-50)
      : [],
    warmup_dedupe: normalizeWarmupDedupe(value.warmup_dedupe),
    ledger_outbox: normalizeLedgerOutbox(value.ledger_outbox),
    progress,
    ready_card: readyCard && readyCard.card_id !== now.card_ref ? readyCard : null,
    deferred_epoch_candidate: candidateActivityEpoch(deferredEpochCandidate) ? deferredEpochCandidate : null,
    candidates: uniqueCandidates,
    generation: {
      candidate: null,
      in_flight: false,
      started_at: null,
    },
    last_unsolicited_delivery_at: Number.isFinite(value.last_unsolicited_delivery_at)
      ? Number(value.last_unsolicited_delivery_at)
      : null,
  };
}

function studioSourceProvenance(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return null;
  }
  return {
    kind: report.source === 'observed'
      ? report.observed_kind === 'change' ? 'observed-change' : 'observed-activity'
      : 'agent',
    task: boundedString(report.task, 240) || '',
    what_i_did: boundedString(report.what_i_did, 4_000) || '',
  };
}

function studioWaiting(studio, cards = []) {
  const normalized = studio && typeof studio === 'object' && !Array.isArray(studio)
    ? studio
    : defaultStudioState();
  // A ready card is the learner's next actionable state. Do not dilute that
  // clear signal with a second, competing "waiting" message for work behind
  // the one-card buffer.
  if (studioReadyCard(normalized, cards)) {
    return null;
  }
  const generation = normalized.generation && typeof normalized.generation === 'object'
    ? normalized.generation
    : {};
  if (generation.in_flight && generation.candidate?.report) {
    return {
      reason: 'preparing',
      source_provenance: studioSourceProvenance(generation.candidate.report),
    };
  }
  const candidate = Array.isArray(normalized.candidates) ? normalized.candidates[0] : null;
  const deferred = normalized.deferred_epoch_candidate;
  if (deferred?.report) {
    return {
      reason: 'queued',
      source_provenance: studioSourceProvenance(deferred.report),
    };
  }
  if (candidate?.report) {
    return {
      reason: 'queued',
      source_provenance: studioSourceProvenance(candidate.report),
    };
  }
  return { reason: 'idle', source_provenance: null };
}

/**
 * The Studio wire contract is intentionally small and shared by snapshot and
 * SSE consumers. `current` remains the lesson in the learner's hands until
 * an explicit Next transition promotes the hidden ready card.
 */
function studioSnapshot(studio, cards = []) {
  const normalized = studio && typeof studio === 'object' && !Array.isArray(studio)
    ? studio
    : defaultStudioState();
  const normalizedState = normalizeStudioState(normalized, cards);
  const now = normalizedState.now;
  const current = now.kind === 'real'
    ? (Array.isArray(cards) ? cards.find((card) => card?.card_id === now.card_ref) || null : null)
    : null;
  const currentWarmup = now.kind === 'warmup' ? normalizedState.current_warmup : null;
  const ready = studioReadyCard(normalizedState, cards);
  return {
    now: { kind: now.kind, card_ref: now.card_ref },
    current: current ? cardForClient(current) : warmupForClient(currentWarmup),
    current_warmup: warmupForClient(currentWarmup),
    next_ready: Boolean(ready),
    progress: normalizedState.progress,
    waiting: studioWaiting(normalizedState, cards),
  };
}

async function loadProjectState(config, sharedStrengths = null) {
  await ensureDirectory(config.stateDir);
  const cardDocument = await readJson(path.join(config.stateDir, 'cards.json'), { cards: [] });
  const storedCards = Array.isArray(cardDocument.cards) ? cardDocument.cards : [];
  const legacyReadyId = boundedString(cardDocument.studio?.ready_card_id, 128);
  const studio = normalizeStudioState(cardDocument.studio, storedCards);
  const ready = studioReadyCard(studio, storedCards);
  // Move legacy ready cards out of the public/history array as soon as they
  // are hydrated. A hidden question is not a second unanswered lesson, and
  // keeping it only in `studio.ready_card` makes an interrupted reload unable
  // to leave an invisible card behind.
  const cards = ready
    ? storedCards.filter((card) => card?.card_id !== ready.card_id)
    : storedCards;
  const tree = await readJson(config.treePath, emptyTree());
  const strengths = sharedStrengths || await readJson(config.profilePath, {});

  return {
    cards,
    tree: tree && Array.isArray(tree.nodes) ? tree : emptyTree(),
    strengths: strengths && typeof strengths === 'object' && !Array.isArray(strengths) ? strengths : {},
    project_id: config.projectId || config.project_id || null,
    studio: normalizeStudioState(studio, cards),
    // Used by the broker to write the migration immediately, before a
    // provider can make another decision from this channel.
    studio_migrated: Boolean(
      legacyReadyId || (ready && storedCards.length !== cards.length),
    ),
  };
}

async function saveCards(config, cards, studio) {
  const document = { cards };
  if (studio !== undefined) {
    document.studio = normalizeStudioState(studio, cards);
  }
  await writeJsonAtomic(path.join(config.stateDir, 'cards.json'), document);
}

async function saveProfile(config, strengths) {
  await writeJsonAtomic(config.profilePath, strengths);
}

async function saveReplay(config, replay) {
  await writeJsonAtomic(config.replayPath, replay);
}

async function saveTree(config, tree) {
  await writeJsonAtomic(config.treePath, tree);
}

function createPersistence(config, { profileStore = null } = {}) {
  let cardsWrite = Promise.resolve();
  let profileWrite = Promise.resolve();
  let replayWrite = Promise.resolve();
  let treeWrite = Promise.resolve();
  // Preserve the Studio document when legacy card callers still invoke
  // saveCards(cards) without knowing about the new durable state.
  let rememberedStudio;
  let loadedStudio = false;

  function enqueue(previous, work) {
    const next = previous.then(work);
    return {
      next,
      tail: next.catch(() => {}),
    };
  }

  return {
    saveCards(cards, studio) {
      const queued = enqueue(cardsWrite, async () => {
        if (studio !== undefined) {
          rememberedStudio = normalizeStudioState(studio, cards);
          loadedStudio = true;
        } else if (!loadedStudio) {
          const existing = await readJson(path.join(config.stateDir, 'cards.json'), { cards: [] });
          rememberedStudio = existing.studio === undefined
            ? undefined
            : normalizeStudioState(existing.studio, existing.cards);
          loadedStudio = true;
        }
        await saveCards(config, cards, rememberedStudio);
      });
      cardsWrite = queued.tail;
      return queued.next;
    },
    saveStudio(studio, cards) {
      const queued = enqueue(cardsWrite, async () => {
        const existingCards = Array.isArray(cards)
          ? cards
          : (await readJson(path.join(config.stateDir, 'cards.json'), { cards: [] })).cards;
        rememberedStudio = normalizeStudioState(studio, existingCards);
        loadedStudio = true;
        await saveCards(config, existingCards, rememberedStudio);
      });
      cardsWrite = queued.tail;
      return queued.next;
    },
    saveProfile(strengths) {
      const queued = enqueue(profileWrite, () =>
        profileStore && typeof profileStore.save === 'function'
          ? profileStore.save(strengths)
          : saveProfile(config, strengths),
      );
      profileWrite = queued.tail;
      return queued.next;
    },
    updateProfile(mutator) {
      if (profileStore && typeof profileStore.update === 'function') {
        return profileStore.update(mutator);
      }
      const queued = enqueue(profileWrite, async () => {
        const current = await readJson(config.profilePath, {});
        const result = await mutator(current);
        await saveProfile(config, current);
        return result;
      });
      profileWrite = queued.tail;
      return queued.next;
    },
    saveReplay(replay) {
      const queued = enqueue(replayWrite, () => saveReplay(config, replay));
      replayWrite = queued.tail;
      return queued.next;
    },
    saveTree(tree) {
      const queued = enqueue(treeWrite, () => saveTree(config, tree));
      treeWrite = queued.tail;
      return queued.next;
    },
  };
}

function snapshotFor(state) {
  return {
    cards: state.cards.map(cardForClient),
    tree: state.tree,
    strengths: state.strengths,
    studio: studioSnapshot(state.studio, state.cards),
  };
}

function cardForClient(card) {
  const { correct_index, explanation, ...visibleCard } = card;

  if (card.state.answered) {
    return { ...visibleCard, explanation };
  }

  return visibleCard;
}

module.exports = {
  defaultStudioState,
  loadProjectState,
  normalizeStudioCandidate,
  coalesceRestoredStudioCandidates,
  normalizeStudioReport,
  normalizeStudioState,
  saveCards,
  saveProfile,
  saveReplay,
  saveTree,
  createPersistence,
  snapshotFor,
  cardForClient,
  normalizeLedgerOutbox,
  restoreBoundedCandidates,
  normalizeWarmupCard,
  normalizeWarmupDedupe,
  normalizeStudioProgress,
  studioReadyCard,
  studioSourceProvenance,
  studioWaiting,
  studioSnapshot,
  warmupForClient,
  writeJsonAtomic,
};
