'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  WARMUP_CATALOG,
  canonicalWarmupConceptId,
  catalogEntryForConceptId,
  makeWarmupCandidate,
  matchesForWarmupEvent,
  observationsFromEvent,
  qualifyWarmupEvent,
  structuredArgvFromInput,
  validateWarmupCatalog,
} = require('../lib/warmup-catalog');

function execEvent(input) {
  return {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input,
    },
  };
}

function patchEvent(changes) {
  return {
    type: 'event_msg',
    payload: {
      type: 'patch_apply_end',
      success: true,
      changes,
    },
  };
}

function mcpEvent(server, tool) {
  return {
    type: 'event_msg',
    payload: {
      type: 'mcp_tool_call_end',
      invocation: { server, tool },
    },
  };
}

function matchIds(event) {
  return matchesForWarmupEvent(event).map((match) => match.concept.concept_id);
}

test('the warmup catalog is a valid Chinese fixed library with at least twenty concepts', () => {
  const result = validateWarmupCatalog();
  const permittedCodeSpans = new Set([
    'rg',
    'node --test',
    'npm',
    'npm run',
    'git status',
    'git diff',
    'git commit',
    'node --watch',
  ]);

  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.ok(WARMUP_CATALOG.concepts.length >= 20);
  assert.equal(WARMUP_CATALOG.catalog_version, 1);

  for (const concept of WARMUP_CATALOG.concepts) {
    const userCopy = [concept.title, concept.lesson, concept.question, ...concept.options, concept.explanation];
    for (const text of userCopy) {
      assert.match(text, /[\u3400-\u9fff]/u, `${concept.concept_id} needs natural Chinese copy`);
      assert.doesNotMatch(
        text.replace(/`[^`\r\n]+`/g, ''),
        /[A-Za-z]/,
        `${concept.concept_id} may only use non-Chinese identifiers in code style`,
      );
      for (const match of text.matchAll(/`([^`\r\n]+)`/g)) {
        assert.equal(
          permittedCodeSpans.has(match[1]),
          true,
          `${concept.concept_id} contains a non-identifier English code span: ${match[1]}`,
        );
      }
    }
  }
});

test('warmup exec matching uses the first parsed argv and never guesses from shell text', () => {
  assert.deepEqual(structuredArgvFromInput(JSON.stringify({ cmd: 'rg --files src' })), ['rg', '--files', 'src']);
  assert.deepEqual(matchIds(execEvent(JSON.stringify({ cmd: 'rg --files src' }))), ['search-with-rg']);
  assert.deepEqual(matchIds(execEvent({ argv: ['/usr/local/bin/rg', '--files'] })), ['search-with-rg']);

  // A word that happens to mention rg is not an argv match, and composing two
  // shell commands is intentionally unparseable rather than best-effort.
  assert.deepEqual(matchIds(execEvent(JSON.stringify({ cmd: 'echo rg' }))), []);
  assert.deepEqual(matchIds(execEvent(JSON.stringify({ cmd: 'rg todo && npm test' }))), []);
  assert.equal(structuredArgvFromInput(JSON.stringify({ cmd: 'rg todo && npm test' })), null);
  assert.deepEqual(matchIds(execEvent(JSON.stringify({ cmd: 'sh -c "rg todo"' }))), []);

  assert.deepEqual(matchIds(execEvent(JSON.stringify({ cmd: 'node --test test/unit.js' }))), ['node-test-runner']);
  assert.deepEqual(matchIds(execEvent(JSON.stringify({ cmd: 'node test/unit.js' }))), []);
});

test('a multi-match structured command has one deterministic warmup concept, never two local cards', () => {
  const event = execEvent(JSON.stringify({ cmd: 'npm run lint' }));
  assert.deepEqual(matchIds(event), ['package-script', 'code-linting']);

  const qualification = qualifyWarmupEvent({
    activity_epoch_id: 'observation-multi-match',
    event,
    observation_id: 'observation-multi-match',
    warmup_id: 'warmup-multi-match',
  });
  assert.equal(qualification.qualified, true);
  assert.equal(qualification.concept_id, 'package-script', 'the first catalog match is the sole deterministic warmup selection');
  assert.equal(qualification.candidate.warmup_id, 'warmup-multi-match');
});

test('warmup patch matching considers only declared extensions and exact MCP pairs', () => {
  assert.deepEqual(matchIds(patchEvent({ '/private/project/src/view.ts': 'secret body' })), ['typescript-change']);
  assert.deepEqual(matchIds(patchEvent({ '/private/project/rg.txt': 'contains rg in its name' })), []);
  assert.deepEqual(matchIds(patchEvent({ '/private/project/view.ts.txt': 'not a TypeScript extension' })), []);

  assert.deepEqual(matchIds(mcpEvent('browser', 'open')), ['browser-navigation']);
  assert.deepEqual(matchIds(mcpEvent('browser', 'Open')), []);
  assert.deepEqual(matchIds(mcpEvent('browser-secret', 'open')), []);
  assert.deepEqual(matchIds(mcpEvent('browser', 'open_page')), []);
  assert.deepEqual(observationsFromEvent(mcpEvent('browser', 'open')), [{ type: 'mcp', server: 'browser', tool: 'open' }]);
});

test('canonical tags map aliases and namespaced true cards without relying on titles', () => {
  assert.equal(canonicalWarmupConceptId('rg'), 'search-with-rg');
  assert.equal(canonicalWarmupConceptId('project-a:rg'), 'search-with-rg');
  assert.equal(canonicalWarmupConceptId('project-a:search-with-rg'), 'search-with-rg');
  assert.equal(canonicalWarmupConceptId('not-a-catalog-concept'), '');
  assert.equal(catalogEntryForConceptId('project-a:node:test').concept_id, 'node-test-runner');
});

test('qualification returns stable suppression reasons and produces a full warmup card only when eligible', () => {
  const event = execEvent(JSON.stringify({ cmd: 'rg --files' }));
  const baseline = {
    event,
    observation_id: 'observation-1',
    warmup_id: 'warmup-1',
    activity_epoch_id: 'observation-1',
  };

  const accepted = qualifyWarmupEvent(baseline);
  assert.equal(accepted.qualified, true);
  assert.equal(accepted.candidate.kind, 'warmup');
  assert.equal(accepted.candidate.catalog_version, WARMUP_CATALOG.catalog_version);
  assert.equal(accepted.candidate.concept_id, 'search-with-rg');
  assert.equal(accepted.candidate.observation_id, 'observation-1');
  assert.equal(accepted.candidate.activity_epoch_id, 'observation-1');
  assert.deepEqual(accepted.candidate.state, { answered: false, chosen_index: null, correct: null });

  const card = makeWarmupCandidate(accepted.matches[0], {
    observation_id: 'observation-2',
    warmup_id: 'warmup-2',
  });
  assert.equal(card.warmup_id, 'warmup-2');
  assert.equal(card.concept_name, card.title);

  const cases = [
    [{ paused: true }, 'learning-paused'],
    [{ registered: false }, 'project-unregistered'],
    [{ carried: false }, 'project-uncarried'],
    [{ event: execEvent(JSON.stringify({ cmd: 'echo no-match' })) }, 'trigger-not-allowlisted'],
    [{ masteredConceptIds: ['project-a:rg'] }, 'mastered'],
    [{ servedConceptIds: ['rg'] }, 'epoch-duplicate'],
    [{ nowKind: 'real' }, 'current-real'],
    [{ nowKind: 'warmup' }, 'current-warmup'],
    [{ nowKind: 'other' }, 'current-occupied'],
    [{ nextReady: true }, 'next-ready'],
    [{ rateLimited: true }, 'rate-limited'],
  ];
  for (const [extra, reason] of cases) {
    const result = qualifyWarmupEvent({ ...baseline, ...extra });
    assert.equal(result.qualified, false, reason);
    assert.equal(result.reason, reason);
  }
});

test('a malformed catalog is rejected before selection and explains the catalog suppression', () => {
  const invalid = {
    catalog_version: 1,
    concepts: WARMUP_CATALOG.concepts.slice(0, 19),
  };
  const validation = validateWarmupCatalog(invalid);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(' '), /二十/);

  const result = qualifyWarmupEvent({
    catalog: invalid,
    event: execEvent(JSON.stringify({ cmd: 'rg --files' })),
  });
  assert.deepEqual(result.qualified, false);
  assert.equal(result.reason, 'catalog-invalid');
  assert.equal(result.matches.length, 0);
});
