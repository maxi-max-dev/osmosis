'use strict';

const { randomUUID } = require('node:crypto');

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
  const requeues = [];

  function deliver(card) {
    const next = deliveryQueue.then(() => persistAndBroadcast(card));
    deliveryQueue = next.catch(() => {});
    return next;
  }

  async function persistAndBroadcast(card) {
    state.cards.push(card);
    await persistence.saveCards(state.cards);
    deliveryCount += 1;
    hub.broadcast('card', cardForClient(card));
    await releaseEligibleRequeues();
  }

  function queueRequeue(card) {
    requeues.push({
      card: cloneForRequeue(card),
      eligibleAfter: deliveryCount + 2,
    });
  }

  async function releaseEligibleRequeues() {
    while (requeues.length > 0 && requeues[0].eligibleAfter <= deliveryCount) {
      const { card } = requeues.shift();
      await persistAndBroadcast(card);
    }
  }

  function persistCards() {
    return persistence.saveCards(state.cards);
  }

  return { deliver, persistCards, queueRequeue };
}

module.exports = { createCardService };
