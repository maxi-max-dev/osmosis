'use strict';

const { randomUUID } = require('node:crypto');

const { isMastered } = require('./mastery');
const { cardForClient } = require('./state');

function cloneForRequeue(card) {
  return {
    ...card,
    card_id: randomUUID(),
    created_at: new Date().toISOString(),
    options: [...card.options],
    source: { ...card.source },
    state: {
      answered: false,
      chosen_index: null,
      correct: null,
    },
  };
}

function createCardService({ state, hub, persistence }) {
  let deliveryCount = 0;
  let deliveryQueue = Promise.resolve();
  let requeueDeliveryGate = null;
  const requeues = [];

  function deliver(card, { afterPersisted, beforePersist } = {}) {
    const next = deliveryQueue.then(async () => {
      const decision = beforePersist ? await beforePersist(card) : { deliver: true };
      if (!decision || decision.deliver === false) {
        return { delivered: false, ...(decision || {}) };
      }
      await persistAndBroadcast(card, { afterPersisted });
      return { delivered: true };
    });
    deliveryQueue = next.catch(() => {});
    return next;
  }

  async function persistAndBroadcast(card, { afterPersisted } = {}) {
    state.cards.push(card);
    await persistence.saveCards(state.cards);
    deliveryCount += 1;
    hub.broadcast('card', cardForClient(card));
    await afterPersisted?.(card);
    await releaseEligibleRequeues();
  }

  function queueRequeue(card) {
    if (isMastered(state.strengths, card.concept_id)) {
      return;
    }

    requeues.push({
      card: cloneForRequeue(card),
      eligibleAfter: deliveryCount + 2,
    });
  }

  function clearPendingByConcept(conceptId, exceptCardId) {
    let removed = 0;
    for (let index = state.cards.length - 1; index >= 0; index -= 1) {
      const card = state.cards[index];
      if (card.concept_id === conceptId && card.card_id !== exceptCardId && !card.state.answered) {
        state.cards.splice(index, 1);
        removed += 1;
      }
    }

    for (let index = requeues.length - 1; index >= 0; index -= 1) {
      if (requeues[index].card.concept_id === conceptId) {
        requeues.splice(index, 1);
        removed += 1;
      }
    }

    return removed;
  }

  async function releaseEligibleRequeues() {
    while (requeues.length > 0 && requeues[0].eligibleAfter <= deliveryCount) {
      const { card } = requeues[0];
      if (isMastered(state.strengths, card.concept_id)) {
        requeues.shift();
        continue;
      }
      const decision = requeueDeliveryGate ? await requeueDeliveryGate.beforeDelivery(card) : { deliver: true };
      if (!decision || decision.deliver === false) {
        // A full wall needs a future delivery to make room; keep the review
        // queued rather than bypassing the same pacing/cap boundary used by
        // every report-driven card.
        return;
      }
      requeues.shift();
      await persistAndBroadcast(card, {
        afterPersisted: requeueDeliveryGate ? requeueDeliveryGate.afterDelivered : undefined,
      });
    }
  }

  function persistCards() {
    return persistence.saveCards(state.cards);
  }

  function setRequeueDeliveryGate(gate) {
    if (
      gate &&
      typeof gate.beforeDelivery === 'function' &&
      typeof gate.afterDelivered === 'function'
    ) {
      requeueDeliveryGate = gate;
    } else {
      requeueDeliveryGate = null;
    }
  }

  return { clearPendingByConcept, deliver, persistCards, queueRequeue, setRequeueDeliveryGate };
}

module.exports = { createCardService };
