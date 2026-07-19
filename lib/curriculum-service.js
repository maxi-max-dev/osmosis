'use strict';

const {
  compressedConcepts,
  directConceptForReport,
  selectableLeaves,
} = require('./concepts');
const { isMastered } = require('./mastery');
const { localConceptId } = require('./project-concepts');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unansweredCount(cards, studio = null) {
  // A generated Next card belongs to the Studio's one-card hidden buffer. It
  // is intentionally not a question the learner has been shown yet, so it
  // must not consume the historical five-unanswered safety ceiling. Keep the
  // compatibility check here as well as in the Studio coordinator: old
  // projects can carry a ready card persisted in a previous process.
  const readyId = studio?.ready_card_id || studio?.ready_card?.card_id || null;
  return (Array.isArray(cards) ? cards : []).filter(
    (card) => !card.state?.answered && card.card_id !== readyId,
  ).length;
}

function createCurriculumService({ config, hub, provider, state, treeService, clock = () => Date.now(), sleep = delay }) {
  // This is deliberately shared by every report that reaches this service.
  // Ambient Watch can observe more than one Codex session, but lessons still
  // belong to one project wall and must be spaced as one stream.
  // Studio persists the last unsolicited wall delivery beside its card
  // watermark. Seed the per-channel cadence after a restart so bouncing the
  // broker cannot accidentally skip the 12-second kindness interval.
  function restoredDeliveryTimestamp() {
    return Number.isFinite(state?.studio?.last_unsolicited_delivery_at)
      ? Number(state.studio.last_unsolicited_delivery_at)
      : null;
  }

  let lastDeliveredAt = restoredDeliveryTimestamp();

  function restorePacing() {
    lastDeliveredAt = restoredDeliveryTimestamp();
    return lastDeliveredAt;
  }

  function enabled() {
    return config.mode !== 'replay';
  }

  function usesProjectTree() {
    return enabled() && provider.supportsLiveCurriculum;
  }

  async function markDirectConcept(report, concepts) {
    const direct = directConceptForReport(report, concepts);
    if (direct) {
      await treeService.markSurfaced(direct.concept_id);
    }
  }

  function queueIsFull() {
    return unansweredCount(state.cards, state.studio) >= config.unansweredCardCap;
  }

  async function prepare(report) {
    if (!enabled()) {
      return { enabled: false };
    }

    // Do this before asking any provider to build a tree or generate a card.
    // It keeps the unanswered-card cap a global backpressure boundary for
    // every provider, including the template (`none`) provider.
    if (queueIsFull()) {
      // A live tree can still remember that this known concept was surfaced,
      // but the cap prevents a card-generation request. The template provider
      // intentionally has no tree to create here.
      if (usesProjectTree()) {
        await treeService.ensureInitialTree(report);
        await markDirectConcept(report, selectableLeaves(state.tree, state.strengths, state.cards));
      }
      return {
        enabled: true,
        skip: {
          state: 'queue-full',
          message: 'Five lessons are already waiting. Osmosis will hold the next report.',
        },
      };
    }

    if (!usesProjectTree()) {
      return { enabled: true, usesProjectTree: false };
    }

    await treeService.ensureInitialTree(report);
    const concepts = selectableLeaves(state.tree, state.strengths, state.cards);
    if (concepts.length === 0) {
      return {
        enabled: true,
        skip: {
          state: 'skipped',
          message: 'All available project concepts are already mastered or waiting.',
        },
      };
    }

    const conceptIdMap = new Map(concepts.map((concept) => [localConceptId(concept.concept_id), concept.concept_id]));
    const providerConcepts = concepts.map((concept) => ({
      concept_id: localConceptId(concept.concept_id),
      concept_name: concept.concept_name,
      parent_id: concept.parent_id === null ? null : localConceptId(concept.parent_id),
    }));
    return {
      enabled: true,
      usesProjectTree: true,
      concepts: compressedConcepts(providerConcepts),
      conceptIdMap,
      conceptIds: new Set(concepts.map((concept) => concept.concept_id)),
      masteredConceptIds: state.tree.nodes
        .filter((node) => isMastered(state.strengths, node.concept_id))
        .map((node) => localConceptId(node.concept_id)),
    };
  }

  async function beforeDelivery(card, { solicited = false } = {}) {
    if (!enabled()) {
      return { deliver: true };
    }

    if (isMastered(state.strengths, card.concept_id)) {
      return {
        deliver: false,
        state: 'skipped',
        message: `You have already mastered ${card.concept_name}.`,
      };
    }

    if (queueIsFull()) {
      if (usesProjectTree()) {
        await treeService.markSurfaced(card.concept_id);
      }
      return {
        deliver: false,
        state: 'queue-full',
        message: 'Five lessons are already waiting. Osmosis will hold the next report.',
      };
    }

    // The pace is a kindness for unsolicited arrivals while someone is
    // working. Choosing Next is explicit learner intent, so it never waits
    // behind the 12-second background cadence.
    const waitFor = solicited
      ? 0
      : lastDeliveredAt === null
        ? 0
        : Math.max(0, lastDeliveredAt + config.cardPacingMs - clock());
    if (waitFor > 0) {
      hub.broadcast('status', {
        state: 'pacing',
        message: 'Osmosis is spacing the next lesson.',
        provider: provider.name,
      });
      await sleep(waitFor);
    }

    if (isMastered(state.strengths, card.concept_id)) {
      return {
        deliver: false,
        state: 'skipped',
        message: `You have already mastered ${card.concept_name}.`,
      };
    }

    if (queueIsFull()) {
      if (usesProjectTree()) {
        await treeService.markSurfaced(card.concept_id);
      }
      return {
        deliver: false,
        state: 'queue-full',
        message: 'Five lessons are already waiting. Osmosis will hold the next report.',
      };
    }

    return { deliver: true };
  }

  async function markDelivered(conceptId) {
    if (!enabled()) {
      return;
    }
    lastDeliveredAt = clock();
    if (usesProjectTree()) {
      await treeService.markSurfaced(conceptId);
    }
  }

  return {
    beforeDelivery,
    enabled,
    isQueueFull: queueIsFull,
    markDelivered,
    prepare,
    restorePacing,
    usesProjectTree,
  };
}

module.exports = {
  createCurriculumService,
  unansweredCount,
};
