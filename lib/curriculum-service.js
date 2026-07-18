'use strict';

const {
  compressedConcepts,
  directConceptForReport,
  masteredConceptIds,
  selectableLeaves,
} = require('./concepts');
const { isMastered } = require('./mastery');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function unansweredCount(cards) {
  return (Array.isArray(cards) ? cards : []).filter((card) => !card.state?.answered).length;
}

function createCurriculumService({ config, hub, provider, state, treeService, clock = () => Date.now(), sleep = delay }) {
  // This is deliberately shared by every report that reaches this service.
  // Ambient Watch can observe more than one Codex session, but lessons still
  // belong to one project wall and must be spaced as one stream.
  let lastDeliveredAt = null;

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
    return unansweredCount(state.cards) >= config.unansweredCardCap;
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

    return {
      enabled: true,
      usesProjectTree: true,
      concepts: compressedConcepts(concepts),
      conceptIds: new Set(concepts.map((concept) => concept.concept_id)),
      masteredConceptIds: masteredConceptIds(state.strengths),
    };
  }

  async function beforeDelivery(card) {
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

    const waitFor = lastDeliveredAt === null ? 0 : Math.max(0, lastDeliveredAt + config.cardPacingMs - clock());
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

  return { beforeDelivery, enabled, isQueueFull: queueIsFull, markDelivered, prepare, usesProjectTree };
}

module.exports = {
  createCurriculumService,
  unansweredCount,
};
