'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { accessiblePath, displayNames, tooltipId } = require('../public/project-labels');

test('same-name project suffixes are stable by project id, not recent activity order', () => {
  const firstOrdering = [
    { summary: { project_id: 'project-z', name: 'demo', last_activity_at: '2026-07-20T01:00:00Z' } },
    { summary: { project_id: 'project-a', name: 'demo', last_activity_at: '2026-07-20T02:00:00Z' } },
  ];
  const secondOrdering = [...firstOrdering].reverse();
  assert.deepEqual([...displayNames(firstOrdering).entries()], [
    ['project-a', 'demo ·1'],
    ['project-z', 'demo ·2'],
  ]);
  assert.deepEqual([...displayNames(secondOrdering).entries()], [
    ['project-a', 'demo ·1'],
    ['project-z', 'demo ·2'],
  ]);
});

test('full project paths have an escaped-attribute-safe id and a screen-reader phrase', () => {
  assert.equal(tooltipId('project<unsafe>.1'), 'project-tooltip-projectunsafe1');
  assert.equal(accessiblePath('/tmp/<demo>', 'demo'), '完整路径：/tmp/<demo>');
  assert.equal(accessiblePath('/tmp/demo', 'demo', 'en'), 'Full path: /tmp/demo');
});
