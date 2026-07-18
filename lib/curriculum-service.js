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
  let lastDeliveredAt = 0;

  function enabled() {
    return provider.supportsLiveCurriculum && config.mode !== 'replay';
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

    if (queueIsFull()) {
      await markDirectConcept(report, concepts);
      return {
        enabled: true,
        skip: {
          state: 'queue-full',
          message: 'Five lessons are already waiting. Osmosis marked this concept for later.',
        },
      };
    }

    return {
      enabled: true,
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
      await treeService.markSurfaced(card.concept_id);
      return {
        deliver: false,
        state: 'queue-full',
        message: 'Five lessons are already waiting. Osmosis marked this concept for later.',
      };
    }

    const waitFor = lastDeliveredAt === 0 ? 0 : Math.max(0, lastDeliveredAt + config.cardPacingMs - clock());
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
      await treeService.markSurfaced(card.concept_id);
      return {
        deliver: false,
        state: 'queue-full',
        message: 'Five lessons are already waiting. Osmosis marked this concept for later.',
      };
    }

    return { deliver: true };
  }

  async function markDelivered(conceptId) {
    if (!enabled()) {
      return;
    }
    lastDeliveredAt = clock();
    await treeService.markSurfaced(conceptId);
  }

  return { beforeDelivery, enabled, markDelivered, prepare };
}

module.exports = {
  createCurriculumService,
  unansweredCount,
};
