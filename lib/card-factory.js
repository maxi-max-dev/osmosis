'use strict';

const { randomUUID } = require('node:crypto');

function createTemplateCard(report) {
  const createdAt = new Date().toISOString();
  const source = report
    ? {
        task: report.task,
        what_i_did: report.what_i_did,
      }
    : {
        task: 'Step 1 Skeleton',
        what_i_did: 'Osmosis opened a learning space and queued its first template lesson.',
      };

  return {
    card_id: randomUUID(),
    created_at: createdAt,
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
    source,
    state: {
      answered: false,
      chosen_index: null,
      correct: null,
    },
  };
}

module.exports = { createTemplateCard };
