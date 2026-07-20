'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WARMUP_CATALOG,
  WARMUP_CATALOG_PATH,
  canonicalWarmupConceptId,
  catalogEntryForConceptId,
  loadWarmupCatalog,
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
    'jq',
    'tmux',
    'fetch',
    'SSE',
    'curl -N',
    'grep',
    'CSS',
  ]);

  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.ok(WARMUP_CATALOG.concepts.length >= 20);
  assert.equal(WARMUP_CATALOG.catalog_version, 1);
  assert.equal(path.extname(WARMUP_CATALOG_PATH), '.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(WARMUP_CATALOG_PATH, 'utf8')), WARMUP_CATALOG);

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

test('the JSON catalog has exact structured triggers for the newly required technologies', () => {
  const cases = [
    {
      concept: 'json-query-with-jq',
      event: execEvent(JSON.stringify({ cmd: 'jq .items data.json' })),
      rejected: execEvent(JSON.stringify({ cmd: 'echo jq' })),
    },
    {
      concept: 'terminal-multiplexing',
      event: execEvent({ argv: ['tmux', 'new-session', '-d'] }),
      rejected: execEvent(JSON.stringify({ cmd: 'echo tmux' })),
    },
    {
      concept: 'web-fetch',
      event: mcpEvent('web', 'fetch'),
      rejected: mcpEvent('web', 'Fetch'),
    },
    {
      concept: 'server-sent-events',
      event: execEvent(JSON.stringify({ cmd: 'curl -N http://127.0.0.1:4321/events' })),
      rejected: execEvent(JSON.stringify({ cmd: 'curl http://127.0.0.1:4321/events' })),
    },
    {
      concept: 'regular-expression-search',
      event: execEvent(JSON.stringify({ cmd: 'grep -E "warmup_[a-z]+" ledger.jsonl' })),
      rejected: execEvent(JSON.stringify({ cmd: 'echo grep' })),
    },
  ];

  for (const { concept, event, rejected } of cases) {
    assert.ok(matchIds(event).includes(concept), `${concept} should match its precise structured event`);
    assert.equal(matchIds(rejected).includes(concept), false, `${concept} must not match text alone or a near miss`);
  }

  const cssMatches = matchIds(patchEvent({ '/private/project/public/status.css': 'redacted source' }));
  assert.equal(cssMatches[0], 'css-animation', 'the exact .css extension selects the specific animation warmup first');
  assert.ok(cssMatches.includes('style-change'), 'the pre-existing generic style lesson remains allowlisted');
  assert.equal(
    matchIds(patchEvent({ '/private/project/public/status.cssx': 'redacted source' })).includes('css-animation'),
    false,
    'a longer filename suffix is not a .css extension match',
  );
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
  assert.match(validation.errors.join(' '), /at least twenty concepts/);
  assert.doesNotMatch(validation.errors.join(' '), /[\u3400-\u9fff]/u, 'developer-facing validation errors stay in English');

  const result = qualifyWarmupEvent({
    catalog: invalid,
    event: execEvent(JSON.stringify({ cmd: 'rg --files' })),
  });
  assert.deepEqual(result.qualified, false);
  assert.equal(result.reason, 'catalog-invalid');
  assert.equal(result.matches.length, 0);
});

test('the JSON loader contains parse and schema failures as catalog-invalid suppressions', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'osmosis-warmup-catalog-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const malformedPath = path.join(directory, 'malformed.json');
  fs.writeFileSync(malformedPath, '{not valid json}', 'utf8');
  const malformed = loadWarmupCatalog(malformedPath);
  assert.equal(malformed, null);
  assert.equal(validateWarmupCatalog(malformed).valid, false);

  const malformedResult = qualifyWarmupEvent({
    catalog: malformed,
    event: execEvent(JSON.stringify({ cmd: 'jq .items data.json' })),
  });
  assert.equal(malformedResult.reason, 'catalog-invalid');

  const wrongSchemaPath = path.join(directory, 'wrong-schema.json');
  fs.writeFileSync(wrongSchemaPath, JSON.stringify({
    catalog_version: 1,
    concepts: [],
    unexpected: true,
  }), 'utf8');
  const wrongSchema = loadWarmupCatalog(wrongSchemaPath);
  assert.equal(wrongSchema, null, 'schema-invalid JSON never becomes a loaded catalog');
  assert.equal(validateWarmupCatalog(wrongSchema).valid, false);
  assert.equal(
    qualifyWarmupEvent({
      catalog: wrongSchema,
      event: execEvent(JSON.stringify({ cmd: 'jq .items data.json' })),
    }).reason,
    'catalog-invalid',
  );
});
