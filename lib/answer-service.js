'use strict';

const { entryFor, nextStrength, normalizeStrength } = require('./mastery');
const { snapshotFor } = require('./state');

function validationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validateAnswer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('Answer data must be an object.');
  }

  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('card_id') ||
    !keys.includes('chosen_index') ||
    typeof value.card_id !== 'string' ||
    !Number.isInteger(value.chosen_index) ||
    value.chosen_index < 0 ||
    value.chosen_index > 2
  ) {
    throw validationError('Answer data must include a card_id and an option index from 0 to 2.');
  }

  return value;
}

function createAnswerService({ state, hub, persistence, cardService, profileStore = null, studio = null }) {
  let answerQueue = Promise.resolve();

  function answerEntry(card, previous, correct, now) {
    const previousStrength = normalizeStrength(previous?.strength);
    const strength = nextStrength(previousStrength, correct);
    const masteryChanged = strength > previousStrength;
    return {
      masteryChanged,
      previousStrength,
      value: {
        name: card.concept_name,
        strength,
        seen: Number.isInteger(previous?.seen) ? previous.seen + 1 : 1,
        correct: Number.isInteger(previous?.correct) ? previous.correct + (correct ? 1 : 0) : correct ? 1 : 0,
        updated_at: masteryChanged || !previous?.updated_at ? now : previous.updated_at,
      },
    };
  }

  async function answer(value) {
    const work = answerQueue.then(() => answerNow(value));
    answerQueue = work.catch(() => {});
    return work;
  }

  async function answerNow(value) {
    const { card_id: cardId, chosen_index: chosenIndex } = validateAnswer(value);
    const card = state.cards.find((item) => item.card_id === cardId);
    if (!card) {
      throw validationError('That lesson is no longer available.', 404);
    }
    // A Studio channel has exactly one question in the learner's hands.
    // Hidden Next cards stay durable in the project state, but they cannot be
    // answered through the frozen two-key endpoint before promotion.
    if (studio && typeof studio.currentCardId === 'function') {
      const currentCardId = studio.currentCardId();
      if (currentCardId && currentCardId !== cardId) {
        throw validationError('That lesson is not the question you are working on.', 409);
      }
    }

    if (card.state.answered) {
      const entry = state.strengths[card.concept_id];
      return {
        correct: card.state.correct,
        explanation: card.explanation,
        strength: entry ? entry.strength : card.state.correct ? 2 : 1,
      };
    }

    const correct = chosenIndex === card.correct_index;
    const now = new Date().toISOString();
    let entry;
    if (profileStore && typeof profileStore.update === 'function') {
      // Answers in separate broker/relay processes can land together. The
      // store rereads under its cross-process lock, so this computation uses
      // the newest strength rather than a stale channel snapshot.
      entry = await profileStore.update((freshStrengths) => {
        const next = answerEntry(card, entryFor(freshStrengths, card.concept_id), correct, now).value;
        freshStrengths[card.concept_id] = next;
        return next;
      });
    } else {
      const next = answerEntry(card, entryFor(state.strengths, card.concept_id), correct, now);
      entry = next.value;
      state.strengths[card.concept_id] = entry;
    }
    const strength = entry.strength;

    card.state = {
      answered: true,
      chosen_index: chosenIndex,
      correct,
    };
    // `profileStore.update` mutates this shared object in place. Preserve the
    // assignment as a defensive fallback for an injected store that returns
    // a value but does not expose the same object reference.
    state.strengths[card.concept_id] = entry;

    const clearedStudioPending = correct && typeof studio?.clearPendingByConcept === 'function'
      ? await studio.clearPendingByConcept(card.concept_id, card.card_id)
      : 0;
    const clearedPending = correct ? cardService.clearPendingByConcept(card.concept_id, card.card_id) : 0;

    await cardService.persistCards();
    if (!profileStore || typeof profileStore.update !== 'function') {
      await persistence.saveProfile(state.strengths);
    }

    // The old wall uses deferred review cards. A Studio keeps one focused
    // Now question instead; the answered lesson remains in its review route
    // and must not bypass the one-Now/one-Next watermark later.
    if (!correct && strength < 2 && !studio) {
      cardService.queueRequeue(card);
    }

    hub.broadcast('strength', { concept_id: card.concept_id, strength });
    hub.broadcast('tree', state.tree);
    studio?.afterAnswer?.(card, { correct, strength });
    if (clearedPending + clearedStudioPending > 0) {
      hub.broadcast('snapshot', snapshotFor(state));
    }

    return {
      correct,
      explanation: card.explanation,
      strength,
    };
  }

  return { answer };
}

module.exports = { createAnswerService };
