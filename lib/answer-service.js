'use strict';

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

function createAnswerService({ state, hub, persistence, cardService }) {
  async function answer(value) {
    const { card_id: cardId, chosen_index: chosenIndex } = validateAnswer(value);
    const card = state.cards.find((item) => item.card_id === cardId);
    if (!card) {
      throw validationError('That lesson is no longer available.', 404);
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
    const previous = state.strengths[card.concept_id] || {
      name: card.concept_name,
      strength: 0,
      seen: 0,
      correct: 0,
      updated_at: now,
    };
    const strength = correct ? 2 : 1;

    card.state = {
      answered: true,
      chosen_index: chosenIndex,
      correct,
    };
    state.strengths[card.concept_id] = {
      name: card.concept_name,
      strength: Math.min(2, strength),
      seen: Number.isInteger(previous.seen) ? previous.seen + 1 : 1,
      correct: Number.isInteger(previous.correct) ? previous.correct + (correct ? 1 : 0) : correct ? 1 : 0,
      updated_at: now,
    };

    await cardService.persistCards();
    await persistence.saveProfile(state.strengths);

    if (!correct) {
      cardService.queueRequeue(card);
    }

    hub.broadcast('strength', { concept_id: card.concept_id, strength });
    hub.broadcast('tree', state.tree);

    return {
      correct,
      explanation: card.explanation,
      strength,
    };
  }

  return { answer };
}

module.exports = { createAnswerService };
