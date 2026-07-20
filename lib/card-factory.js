'use strict';

const { randomUUID } = require('node:crypto');

const STARTER_REPORT = {
  task: 'Step 1 Skeleton',
  what_i_did: 'Osmosis opened a learning space and queued its first template lesson.',
};

function createTemplateGeneratedCard() {
  return {
    concept_id: 'feedback-loop',
    concept_name: 'The feedback loop',
    lesson:
      'When your agent finishes a small piece of work, that is a useful pause point. A feedback loop turns that pause into a quick check: what changed, why it changed, and whether you understand it. You do not need to read every line of code first. By answering one focused question while the next task begins, you slowly connect the work happening in your project to the ideas behind it.',
    question: 'What is Osmosis using an agent milestone for?',
    options: [
      'A short learning moment about the work that just happened.',
      'A request to replace the agent with a different coding tool.',
      'A signal to erase the project and begin from scratch.',
    ],
    correct_index: 0,
    explanation:
      'Exactly. A milestone becomes a small, timely lesson so waiting for an agent can become learning time.',
  };
}

function createRuntimeCard(generatedCard, report = STARTER_REPORT) {
  const sourceKind = report.source === 'observed'
    ? report.observed_kind === 'change'
      ? 'observed-change'
      : 'observed-activity'
    : 'agent';

  return {
    card_id: randomUUID(),
    created_at: new Date().toISOString(),
    concept_id: generatedCard.concept_id,
    concept_name: generatedCard.concept_name,
    lesson: generatedCard.lesson,
    question: generatedCard.question,
    options: [...generatedCard.options],
    correct_index: generatedCard.correct_index,
    explanation: generatedCard.explanation,
    source: {
      task: report.task,
      what_i_did: report.what_i_did,
      kind: sourceKind,
      ...(typeof report.report_id === 'string' ? { report_id: report.report_id } : {}),
      ...(typeof report.activity_epoch_id === 'string' ? { activity_epoch_id: report.activity_epoch_id } : {}),
      // Ambient supplies an opaque installation-HMAC id only.  Raw rollout
      // session ids and local prompt titles never reach a card source.
      ...(typeof report.conversation_id === 'string' && /^[a-f0-9]{24,64}$/i.test(report.conversation_id)
        ? { conversation_id: report.conversation_id }
        : {}),
    },
    state: {
      answered: false,
      chosen_index: null,
      correct: null,
    },
  };
}

function createTemplateCard(report) {
  return createRuntimeCard(createTemplateGeneratedCard(), report);
}

module.exports = {
  STARTER_REPORT,
  createRuntimeCard,
  createTemplateCard,
  createTemplateGeneratedCard,
};
