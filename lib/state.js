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
    version: 1,
    current_card_id: null,
    ready_card_id: null,
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

function normalizeStudioState(value, cards = []) {
  const fallback = defaultStudioState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fallback;
  }
  const cardIds = new Set((Array.isArray(cards) ? cards : []).map((card) => card?.card_id).filter(Boolean));
  const currentCardId = boundedString(value.current_card_id, 128);
  const readyCardId = boundedString(value.ready_card_id, 128);
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.map(normalizeStudioCandidate).filter(Boolean).slice(0, 2)
    : [];
  const generation = value.generation && typeof value.generation === 'object' && !Array.isArray(value.generation)
    ? value.generation
    : {};
  const inFlightCandidate = normalizeStudioCandidate(generation.candidate);

  // An in-flight provider request cannot survive a process restart. Put its
  // durable signal back at the front of the bounded queue instead of leaving
  // a permanent "generating" state or silently losing the work that prompted
  // it.
  if (generation.in_flight && inFlightCandidate) {
    candidates.unshift(inFlightCandidate);
  }
  // Keep the two-candidate watermark without losing source context. This can
  // occur only when an interrupted in-flight request is restored alongside a
  // fully populated durable queue.
  while (candidates.length > 2) {
    const first = candidates.shift();
    const second = candidates.shift();
    candidates.unshift(coalesceRestoredStudioCandidates(first, second));
  }
  const uniqueCandidates = [];
  const seenCandidates = new Set();
  for (const candidate of candidates) {
    if (seenCandidates.has(candidate.candidate_id)) {
      continue;
    }
    seenCandidates.add(candidate.candidate_id);
    uniqueCandidates.push(candidate);
    if (uniqueCandidates.length === 2) {
      break;
    }
  }

  return {
    version: 1,
    current_card_id: currentCardId && cardIds.has(currentCardId) ? currentCardId : null,
    ready_card_id: readyCardId && readyCardId !== currentCardId && cardIds.has(readyCardId) ? readyCardId : null,
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

function studioSnapshot(studio) {
  const normalized = studio && typeof studio === 'object' && !Array.isArray(studio)
    ? studio
    : defaultStudioState();
  return {
    candidate_count: Array.isArray(normalized.candidates) ? Math.min(2, normalized.candidates.length) : 0,
    current_card_id: boundedString(normalized.current_card_id, 128),
    generation: {
      in_flight: Boolean(normalized.generation?.in_flight),
    },
    next_ready: Boolean(boundedString(normalized.ready_card_id, 128)),
  };
}

async function loadProjectState(config, sharedStrengths = null) {
  await ensureDirectory(config.stateDir);
  const cardDocument = await readJson(path.join(config.stateDir, 'cards.json'), { cards: [] });
  const cards = Array.isArray(cardDocument.cards) ? cardDocument.cards : [];
  const tree = await readJson(config.treePath, emptyTree());
  const strengths = sharedStrengths || await readJson(config.profilePath, {});

  return {
    cards,
    tree: tree && Array.isArray(tree.nodes) ? tree : emptyTree(),
    strengths: strengths && typeof strengths === 'object' && !Array.isArray(strengths) ? strengths : {},
    project_id: config.projectId || config.project_id || null,
    studio: normalizeStudioState(cardDocument.studio, cards),
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
  // The generated Next card is durable but deliberately unseen. Legacy
  // snapshot consumers may still render `cards`, so do not leak its prompt
  // through that compatibility surface before the learner explicitly asks
  // for the next lesson.
  const readyCardId = state.studio?.ready_card_id;
  return {
    cards: state.cards.filter((card) => card?.card_id !== readyCardId).map(cardForClient),
    tree: state.tree,
    strengths: state.strengths,
    studio: studioSnapshot(state.studio),
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
  studioSnapshot,
  writeJsonAtomic,
};
