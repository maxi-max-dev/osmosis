'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CARD_SCHEMA_PATH,
  TREE_SCHEMA_PATH,
  codexExecArgs,
  createProvider,
} = require('../lib/provider');

function validCard() {
  return {
    concept_id: 'http',
    concept_name: 'HTTP',
    lesson: 'HTTP is the message path between your browser and a server, like a labeled envelope moving between two places.',
    question: 'What does HTTP help your app do?',
    options: ['Send a request and receive a response.', 'Draw every screen pixel.', 'Store passwords in a browser tab.'],
    correct_index: 0,
    explanation: 'HTTP carries a request to a server and brings a response back.',
  };
}

test('the Codex provider uses strict schema prompts and silently retries one failed card attempt', async () => {
  const calls = [];
  const provider = createProvider(
    { codexTimeoutMs: 60_000, cwd: process.cwd(), provider: 'codex' },
    {
      runCodex: async (request) => {
        calls.push(request);
        if (calls.length === 1) {
          return { invalid: true };
        }
        return validCard();
      },
    },
  );

  const card = await provider.generateCard({
    concepts: [{ concept_id: 'http', concept_name: 'HTTP', parent_id: 'data' }],
    masteredConceptIds: ['css'],
    report: { task: 'HTTP route', what_i_did: 'Added an HTTP route.', stack_hints: ['HTTP'] },
  });

  assert.equal(card.concept_id, 'http');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].schemaPath, CARD_SCHEMA_PATH);
  assert.equal(calls[0].timeoutMs, 60_000);
  assert.match(calls[0].prompt, /threejs/);
  assert.match(calls[0].prompt, /render-loop/);
  assert.match(calls[0].prompt, /AVAILABLE_CONCEPTS/);
});

test('the Codex command arguments retain the target-safe read-only flags and strict output schema', () => {
  const args = codexExecArgs({ outputPath: '/tmp/result.json', prompt: 'Generate JSON.', schemaPath: CARD_SCHEMA_PATH });

  assert.deepEqual(args.slice(0, 10), [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--ephemeral',
    '--output-schema',
    CARD_SCHEMA_PATH,
    '--output-last-message',
    '/tmp/result.json',
    'Generate JSON.',
  ]);
  assert.equal(TREE_SCHEMA_PATH.endsWith('tree-output.schema.json'), true);
});

test('the Codex provider stops after one silent retry when generation keeps failing', async () => {
  let calls = 0;
  const provider = createProvider(
    { codexTimeoutMs: 60_000, cwd: process.cwd(), provider: 'codex' },
    {
      runCodex: async () => {
        calls += 1;
        throw new Error('temporary generator failure');
      },
    },
  );

  await assert.rejects(
    provider.generateCard({ concepts: [], masteredConceptIds: [], report: { task: 'M1', what_i_did: 'Completed work.', stack_hints: [] } }),
    /failed after one retry/,
  );
  assert.equal(calls, 2);
});

test('the future OpenAI provider keeps the same curriculum interface without claiming availability', async () => {
  const provider = createProvider({ provider: 'openai' });

  assert.equal(provider.supportsLiveCurriculum, true);
  await assert.rejects(provider.generateInitialTree({ report: {} }), /not enabled yet/);
  await assert.rejects(provider.generateCard({ report: {} }), /not enabled yet/);
});
