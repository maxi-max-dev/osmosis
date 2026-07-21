'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  cardGeneratingLeaves,
  deriveMapCoverage,
  isVisibleCoverage,
  strengthFor,
} = require('../public/map-coverage');

function coverageTree() {
  return {
    meta: { surfaced_concept_ids: ['project-a:surfaced-meta', 'project-a:mastered'] },
    nodes: [
      { concept_id: 'project-a:root', concept_name: 'Root', parent_id: null },
      { concept_id: 'project-a:mastered', concept_name: 'Mastered', parent_id: 'project-a:root' },
      { concept_id: 'project-a:surfaced-meta', concept_name: 'Surfaced meta', parent_id: 'project-a:root' },
      { concept_id: 'project-a:real-card', concept_name: 'Real card', parent_id: 'project-a:root' },
      { concept_id: 'project-a:warmup-only', concept_name: 'Warmup only', parent_id: 'project-a:root' },
      { concept_id: 'project-a:waiting', concept_name: 'Waiting', parent_id: 'project-a:root' },
    ],
  };
}

test('Project map coverage uses card-generating leaves and keeps M + L + W invariant while excluding warmups', () => {
  const tree = coverageTree();
  assert.deepEqual(cardGeneratingLeaves(tree).map((node) => node.concept_id), [
    'project-a:mastered',
    'project-a:surfaced-meta',
    'project-a:real-card',
    'project-a:warmup-only',
    'project-a:waiting',
  ]);

  const coverage = deriveMapCoverage({
    cards: [{ card_id: 'real-card', concept_id: 'project-a:real-card' }],
    strengths: { 'project-a:mastered': { strength: 2 } },
    studio: {
      current: { concept_id: 'project-a:warmup-only', warmup_id: 'warmup-1' },
      now: { kind: 'warmup', card_ref: 'warmup-1' },
    },
    tree,
  });

  assert.deepEqual(coverage, { mastered: 1, surfaced: 2, total: 5, waiting: 2 });
  assert.equal(coverage.total, coverage.mastered + coverage.surfaced + coverage.waiting);
  assert.equal(coverage.waiting, 2, 'a warmup-only concept remains unsurfaced for coverage');
});

test('browser mastery reads use the server priority: direct zero wins, then valid namespaced legacy only', () => {
  const strengths = {
    'project-a:direct-zero': { strength: 0 },
    'direct-zero': { strength: 2 },
    legacy: { strength: 2 },
    local: { strength: 2 },
    many: { strength: 2 },
  };

  assert.equal(strengthFor(strengths, 'project-a:direct-zero'), 0, 'a direct zero must never fall back to legacy mastery');
  assert.equal(strengthFor(strengths, 'project-a:legacy'), 2, 'an absent direct valid namespace may read its legacy local entry');
  assert.equal(strengthFor(strengths, 'feedback-loop'), 0, 'a global id never falls back to an unrelated local record');
  assert.equal(strengthFor(strengths, 'Project-A:local'), 0, 'an invalid namespace never falls back');
  assert.equal(strengthFor(strengths, 'project-a:too:many'), 0, 'a multi-colon namespace never falls back');
});

test('Project map coverage is visible only for a carried project with at least one leaf', () => {
  const activation = { carry: true, state: 'carried' };
  assert.equal(isVisibleCoverage(activation, { total: 1 }), true);
  assert.equal(isVisibleCoverage(null, { total: 1 }), false);
  assert.equal(isVisibleCoverage({ carry: true, state: 'activation-pending' }, { total: 1 }), false);
  assert.equal(isVisibleCoverage(activation, { total: 0 }), false);
});

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map((part) => Number.parseInt(part, 16) / 255);
  const linear = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(left, right) {
  const [light, dark] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test('coverage count copy meets 4.5:1 contrast on the sidebar surface', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const color = (name) => css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  const background = color('--surface-warm');
  for (const variable of ['--map-coverage-mastered-copy', '--map-coverage-surfaced-copy', '--map-coverage-waiting-copy']) {
    assert.ok(contrastRatio(color(variable), background) >= 4.5, `${variable} must meet 4.5:1 on the sidebar`);
  }
});
