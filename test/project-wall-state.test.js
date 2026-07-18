'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { applyBackgroundActivity, selectProjectFromUser } = require('../public/project-state');

test('background activity restores an archived project with a ready badge without activating it', () => {
  const projects = new Map([
    ['project-a', { summary: { archived: false, name: 'A' } }],
    ['project-b', { summary: { archived: true, name: 'B' } }],
  ]);
  const state = {
    activeProjectId: 'project-a',
    projects,
    readyProjectIds: new Set(),
  };

  applyBackgroundActivity(state, 'project-b', (projectId) => projects.get(projectId), '2026-07-19T10:00:00.000Z');
  assert.equal(state.activeProjectId, 'project-a');
  assert.equal(projects.get('project-b').summary.archived, false);
  assert.equal(projects.get('project-b').summary.last_activity_at, '2026-07-19T10:00:00.000Z');
  assert.equal(state.readyProjectIds.has('project-b'), true);

  assert.equal(selectProjectFromUser(state, 'project-b'), true);
  assert.equal(state.activeProjectId, 'project-b');
  assert.equal(state.readyProjectIds.has('project-b'), false);
});
