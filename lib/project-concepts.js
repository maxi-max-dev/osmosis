'use strict';

// Keep this tiny normalizer local rather than importing `concepts`: that
// module reads mastery, and mastery needs these namespace helpers. Avoiding
// the cycle keeps legacy mastery reads reliable during process startup.
function normalizeConceptId(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Template curriculum is intentionally shared. It teaches how Osmosis itself
// works, rather than a fact discovered from one particular project.
const GLOBAL_CONCEPT_IDS = new Set(['feedback-loop']);

function isGlobalConceptId(conceptId) {
  return GLOBAL_CONCEPT_IDS.has(conceptId);
}

function splitNamespacedConceptId(conceptId) {
  if (typeof conceptId !== 'string') {
    return null;
  }
  const separator = conceptId.indexOf(':');
  if (separator <= 0 || separator === conceptId.length - 1 || conceptId.indexOf(':', separator + 1) !== -1) {
    return null;
  }
  const projectId = conceptId.slice(0, separator);
  const localId = conceptId.slice(separator + 1);
  if (normalizeConceptId(projectId) !== projectId || normalizeConceptId(localId) !== localId) {
    return null;
  }
  return { localId, projectId };
}

function localConceptId(conceptId) {
  return splitNamespacedConceptId(conceptId)?.localId || conceptId;
}

function namespaceConceptId(projectId, conceptId) {
  const localId = normalizeConceptId(localConceptId(conceptId));
  if (!localId) {
    return '';
  }
  if (isGlobalConceptId(localId)) {
    return localId;
  }
  const normalizedProjectId = normalizeConceptId(projectId);
  return normalizedProjectId ? `${normalizedProjectId}:${localId}` : localId;
}

function namespaceTreeNodes(projectId, nodes) {
  const idMap = new Map();
  for (const node of nodes) {
    idMap.set(node.concept_id, namespaceConceptId(projectId, node.concept_id));
  }
  return nodes.map((node) => ({
    ...node,
    concept_id: idMap.get(node.concept_id),
    parent_id: node.parent_id === null ? null : idMap.get(node.parent_id),
  }));
}

function validProviderConceptId(conceptId) {
  if (typeof conceptId !== 'string' || !conceptId) {
    return false;
  }
  const namespaced = splitNamespacedConceptId(conceptId);
  return Boolean(namespaced || normalizeConceptId(conceptId) === conceptId);
}

module.exports = {
  GLOBAL_CONCEPT_IDS,
  isGlobalConceptId,
  localConceptId,
  namespaceConceptId,
  namespaceTreeNodes,
  splitNamespacedConceptId,
  validProviderConceptId,
};
