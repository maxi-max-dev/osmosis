(function exposeProjectState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.OsmosisProjectState = api;
  }
})(typeof globalThis === 'undefined' ? null : globalThis, function createProjectStateApi() {
  'use strict';

  // Keep the two state transitions that matter most for a multi-project wall
  // small and independently testable: only a user action may select a tab;
  // background work may unarchive and mark another tab ready, never select it.
  function selectProjectFromUser(state, projectId) {
    if (!state || typeof projectId !== 'string') {
      return false;
    }
    state.activeProjectId = projectId;
    state.readyProjectIds?.delete(projectId);
    return true;
  }

  function applyBackgroundActivity(state, projectId, ensureProject, timestamp = new Date().toISOString()) {
    if (!state || typeof projectId !== 'string' || typeof ensureProject !== 'function') {
      return null;
    }
    const project = ensureProject(projectId);
    project.summary.archived = false;
    project.summary.last_activity_at = timestamp;
    if (projectId !== state.activeProjectId) {
      state.readyProjectIds?.add(projectId);
    }
    return project;
  }

  return { applyBackgroundActivity, selectProjectFromUser };
});
