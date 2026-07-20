(function exposeProjectLabels(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OsmosisProjectLabels = api;
})(typeof globalThis === 'undefined' ? null : globalThis, function createProjectLabelsApi() {
  'use strict';

  function safeText(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  // The visible list can reorder by recent activity, but a same-name suffix
  // may never do so. Full project id order gives a stable, explainable label.
  function displayNames(projects, { fallback = '项目' } = {}) {
    const names = new Map();
    const groups = new Map();
    for (const project of Array.isArray(projects) ? projects : []) {
      const summary = project?.summary || project || {};
      const projectId = safeText(summary.project_id);
      if (!projectId) continue;
      const name = safeText(summary.name, fallback);
      const group = groups.get(name) || [];
      group.push({ projectId, name });
      groups.set(name, group);
    }
    for (const group of groups.values()) {
      group.sort((left, right) => left.projectId.localeCompare(right.projectId));
      group.forEach((project, index) => {
        names.set(project.projectId, group.length > 1 ? `${project.name} ·${index + 1}` : project.name);
      });
    }
    return names;
  }

  function tooltipId(projectId) {
    return `project-tooltip-${safeText(projectId).replaceAll(/[^A-Za-z0-9_-]/g, '') || 'unknown'}`;
  }

  function accessiblePath(rootPath, displayName, locale = 'zh-CN') {
    const path = safeText(rootPath, displayName);
    return locale === 'en' ? `Full path: ${path}` : `完整路径：${path}`;
  }

  return { accessiblePath, displayNames, tooltipId };
});
