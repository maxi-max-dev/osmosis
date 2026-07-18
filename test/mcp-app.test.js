'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { EMPTY_STATE_COPY, INLINE_CARD_URI, renderInlineCard } = require('../lib/inline-card');
const { createMcpServer } = require('../lib/mcp');

const ANSWER_URL = 'http://127.0.0.1:4321/answer';

function request(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

function reportArguments() {
  return {
    task: 'Inline card milestone',
    what_i_did: 'Connected a lesson to the current agent milestone.',
    stack_hints: ['MCP Apps', 'JSON-RPC'],
  };
}

function lessonCard({
  cardId,
  conceptId,
  conceptName,
  source,
  lesson,
  question,
  options,
  correctIndex = 0,
  answered = false,
}) {
  return {
    card_id: cardId,
    concept_id: conceptId,
    concept_name: conceptName,
    lesson,
    question,
    options,
    correct_index: correctIndex,
    explanation: 'The explanation belongs to this focused lesson.',
    source,
    state: {
      answered,
      chosen_index: null,
      correct: null,
    },
  };
}

function createHarness(state) {
  const responses = [];
  const reports = [];
  const mcp = createMcpServer({
    onReport(report) {
      reports.push(report);
    },
    getInlineCardHtml() {
      return renderInlineCard({ state, answerUrl: ANSWER_URL });
    },
    getInlineAnswerOrigin() {
      return ANSWER_URL;
    },
    output: {
      write(raw) {
        responses.push(JSON.parse(raw));
      },
    },
  });

  return {
    reports,
    call(message) {
      const before = responses.length;
      mcp.handle(message);
      assert.equal(responses.length, before + 1, `MCP did not respond to ${message.method}.`);
      return responses.at(-1);
    },
  };
}

test('MCP Apps declares the inline resource on report tools and calls', () => {
  const harness = createHarness({ cards: [], strengths: {}, tree: { meta: {}, nodes: [] } });

  const initialized = harness.call(
    request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    }),
  );
  assert.deepEqual(initialized.result.capabilities, { tools: {}, resources: {} });

  const tools = harness.call(request(2, 'tools/list'));
  assert.equal(tools.result.tools[0].name, 'osmosis_report');
  assert.equal(tools.result.tools[0]._meta.ui.resourceUri, INLINE_CARD_URI);

  const resources = harness.call(request(3, 'resources/list'));
  assert.deepEqual(resources.result.resources, [
    {
      uri: INLINE_CARD_URI,
      name: 'Osmosis inline lesson',
      description: 'The newest unanswered Osmosis lesson for the Codex conversation.',
      mimeType: 'text/html',
    },
  ]);

  const report = harness.call(
    request(4, 'tools/call', {
      name: 'osmosis_report',
      arguments: reportArguments(),
    }),
  );
  assert.equal(report.result._meta.ui.resourceUri, INLINE_CARD_URI);
  assert.deepEqual(harness.reports, [reportArguments()]);
});

test('resources/read renders the newest unanswered lesson and local CSP allowance', () => {
  const older = lessonCard({
    cardId: 'older-card',
    conceptId: 'older-concept',
    conceptName: 'Older concept',
    source: { task: 'Older milestone', what_i_did: 'Older source should not be shown.' },
    lesson: 'Older lesson.',
    question: 'Older question?',
    options: ['Older one', 'Older two', 'Older three'],
  });
  const latest = lessonCard({
    cardId: 'latest-card',
    conceptId: 'latest-concept',
    conceptName: 'Latest concept',
    source: {
      task: 'Latest local change',
      what_i_did: 'Latest source came from local Codex activity.',
      kind: 'observed-change',
    },
    lesson: 'A latest lesson explains the exact technology now in use.',
    question: 'Which lesson should Osmosis show?',
    options: ['The latest unanswered lesson.', 'The oldest answered lesson.', 'A random unrelated lesson.'],
    correctIndex: 0,
  });
  const state = {
    cards: [older, latest],
    strengths: {
      'older-concept': { strength: 2, updated_at: '2026-07-17T00:00:00.000Z' },
    },
    tree: {
      meta: { created_at: '2026-07-18T00:00:00.000Z' },
      nodes: [
        { concept_id: 'older-concept', concept_name: 'Older concept', parent_id: null },
        { concept_id: 'latest-concept', concept_name: 'Latest concept', parent_id: 'older-concept' },
      ],
    },
  };
  const harness = createHarness(state);

  const resource = harness.call(request(1, 'resources/read', { uri: INLINE_CARD_URI }));
  const content = resource.result.contents[0];

  assert.equal(content.uri, INLINE_CARD_URI);
  assert.equal(content.mimeType, 'text/html');
  assert.equal(content._meta.ui.csp.connectDomains[0], 'http://127.0.0.1:4321');
  assert.deepEqual(content._meta.ui.csp.resourceDomains, []);
  assert.match(content.text, /Local Codex change/);
  assert.doesNotMatch(content.text, /Latest local change/);
  assert.match(content.text, /Osmosis observed a local Codex change/);
  assert.doesNotMatch(content.text, /Latest source came from local Codex activity/);
  assert.match(content.text, /Observed change/);
  assert.doesNotMatch(content.text, /Reported by agent/);
  assert.match(content.text, /A latest lesson explains the exact technology now in use/);
  assert.match(content.text, /Which lesson should Osmosis show/);
  assert.match(content.text, /The latest unanswered lesson/);
  assert.match(content.text, /Tree lit<\/span>1 \/ 2/);
  assert.match(content.text, /Queue<\/span>2/);
  assert.match(content.text, /http:\/\/127\.0\.0\.1:4321\/answer/);
  assert.doesNotMatch(content.text, /Older source should not be shown/);
});

test('inline cards default missing provenance to the agent report label', () => {
  const html = renderInlineCard({
    state: {
      cards: [
        lessonCard({
          cardId: 'agent-card',
          conceptId: 'mcp',
          conceptName: 'MCP',
          source: { task: 'Agent milestone', what_i_did: 'The agent reported a tool call.' },
          lesson: 'A lesson.',
          question: 'A question?',
          options: ['One', 'Two', 'Three'],
        }),
      ],
      strengths: {},
      tree: { meta: {}, nodes: [] },
    },
  });

  assert.match(html, /Reported by agent/);
  assert.match(html, /source-label--agent/);
  assert.doesNotMatch(html, /Observed change/);
  assert.doesNotMatch(html, /Observed activity/);
});

test('inline cards reserve observed change for patches and use observed activity otherwise', () => {
  const activityHtml = renderInlineCard({
    state: {
      cards: [
        lessonCard({
          cardId: 'activity-card',
          conceptId: 'node',
          conceptName: 'Node.js',
          source: {
            kind: 'observed-activity',
            task: 'untrusted-rollout-identifier.js',
            what_i_did: 'Observed the node command and .js extension.',
          },
          lesson: 'A lesson.',
          question: 'A question?',
          options: ['One', 'Two', 'Three'],
        }),
      ],
      strengths: {},
      tree: { meta: {}, nodes: [] },
    },
  });
  const legacyHtml = renderInlineCard({
    state: {
      cards: [
        lessonCard({
          cardId: 'legacy-observed-card',
          conceptId: 'mcp',
          conceptName: 'MCP',
          source: { kind: 'observed', what_i_did: 'Observed local Codex activity.' },
          lesson: 'A lesson.',
          question: 'A question?',
          options: ['One', 'Two', 'Three'],
        }),
      ],
      strengths: {},
      tree: { meta: {}, nodes: [] },
    },
  });

  assert.match(activityHtml, /Observed activity/);
  assert.match(activityHtml, /source-label--observed-activity/);
  assert.doesNotMatch(activityHtml, /Observed change/);
  assert.doesNotMatch(activityHtml, /untrusted-rollout-identifier\.js/);
  assert.match(legacyHtml, /Observed activity/);
  assert.match(legacyHtml, /source-label--observed-activity/);
  assert.doesNotMatch(legacyHtml, /Observed change/);
});

test('resources/read returns a calm inline empty state when no lesson is waiting', () => {
  const harness = createHarness({
    cards: [],
    strengths: {},
    tree: { meta: {}, nodes: [{ concept_id: 'root', concept_name: 'Project', parent_id: null }] },
  });

  const resource = harness.call(request(1, 'resources/read', { uri: INLINE_CARD_URI }));
  const content = resource.result.contents[0];

  assert.equal(content.mimeType, 'text/html');
  assert.match(content.text, new RegExp(EMPTY_STATE_COPY));
  assert.match(content.text, /CARRIED OVER/);
  assert.match(content.text, /data-osmosis-inline-card="pending"/);
  assert.match(content.text, /http:\/\/127\.0\.0\.1:4321\/inline-card/);
  assert.match(content.text, /Tree lit<\/span>0 \/ 1/);
  assert.match(content.text, /Queue<\/span>0/);
});
