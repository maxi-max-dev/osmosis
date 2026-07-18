'use strict';

const { isMastered } = require('./mastery');

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

function treeNodes(tree) {
  return Array.isArray(tree?.nodes) ? tree.nodes : [];
}

function cardGeneratingLeaves(tree) {
  const parents = new Set(treeNodes(tree).map((node) => node.parent_id).filter(Boolean));
  return treeNodes(tree).filter((node) => !parents.has(node.concept_id));
}

function selectableLeaves(tree, strengths, cards) {
  const pendingConceptIds = new Set(
    (Array.isArray(cards) ? cards : [])
      .filter((card) => !card.state?.answered)
      .map((card) => card.concept_id),
  );

  return cardGeneratingLeaves(tree).filter(
    (node) => !isMastered(strengths, node.concept_id) && !pendingConceptIds.has(node.concept_id),
  );
}

function masteredConceptIds(strengths) {
  return Object.keys(strengths || {}).filter((conceptId) => isMastered(strengths, conceptId));
}

function compressedConcepts(nodes) {
  return nodes.map((node) => ({
    concept_id: node.concept_id,
    concept_name: node.concept_name,
    parent_id: node.parent_id,
  }));
}

function terms(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

function directConceptForReport(report, nodes) {
  const reportTerms = new Set(terms([report?.task, report?.what_i_did, ...(report?.stack_hints || [])].join(' ')));
  let closest = null;

  for (const node of nodes) {
    const conceptTerms = new Set(terms(`${node.concept_id} ${node.concept_name}`));
    const score = [...conceptTerms].filter((term) => term.length > 2 && reportTerms.has(term)).length;
    if (score > 0 && (!closest || score > closest.score)) {
      closest = { node, score };
    }
  }

  return closest?.node || null;
}

module.exports = {
  cardGeneratingLeaves,
  compressedConcepts,
  directConceptForReport,
  masteredConceptIds,
  normalizeConceptId,
  selectableLeaves,
};
