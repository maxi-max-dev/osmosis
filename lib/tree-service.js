'use strict';

const { normalizeConceptId } = require('./concepts');

function hasTree(tree) {
  return Array.isArray(tree?.nodes) && tree.nodes.length > 0;
}

function validateTreeNodes(rawNodes) {
  if (!Array.isArray(rawNodes) || rawNodes.length < 12 || rawNodes.length > 14) {
    throw new Error('The initial tree must contain 12 to 14 nodes.');
  }

  const nodes = rawNodes.map((node) => {
    if (
      !node ||
      typeof node !== 'object' ||
      Array.isArray(node) ||
      Object.keys(node).length !== 3 ||
      !['concept_id', 'concept_name', 'parent_id'].every((field) => field in node)
    ) {
      throw new Error('Every tree node must be an object.');
    }
    const conceptId = normalizeConceptId(node.concept_id);
    const conceptName = typeof node.concept_name === 'string' ? node.concept_name.trim() : '';
    const parentId = node.parent_id === null ? null : normalizeConceptId(node.parent_id);
    if (!conceptId || !conceptName || (node.parent_id !== null && !parentId)) {
      throw new Error('Tree nodes need normalized ids, names, and valid parent ids.');
    }
    return { concept_id: conceptId, concept_name: conceptName, parent_id: parentId };
  });

  const byId = new Map(nodes.map((node) => [node.concept_id, node]));
  if (byId.size !== nodes.length) {
    throw new Error('Tree concept ids must be unique.');
  }

  const roots = nodes.filter((node) => node.parent_id === null);
  if (roots.length !== 1) {
    throw new Error('The initial tree must have exactly one root.');
  }

  for (const node of nodes) {
    if (node.parent_id === null) {
      continue;
    }
    if (node.parent_id === node.concept_id || !byId.has(node.parent_id)) {
      throw new Error('Every non-root tree node needs an existing parent.');
    }

    const visited = new Set([node.concept_id]);
    let current = node;
    while (current.parent_id !== null) {
      if (visited.has(current.parent_id)) {
        throw new Error('Tree nodes cannot contain a cycle.');
      }
      visited.add(current.parent_id);
      current = byId.get(current.parent_id);
    }
  }

  const parents = new Set(nodes.map((node) => node.parent_id).filter(Boolean));
  const leaves = nodes.filter((node) => !parents.has(node.concept_id));
  const branches = nodes.filter((node) => node.parent_id !== null && parents.has(node.concept_id));
  if (branches.length < 3 || branches.length > 5 || leaves.length < 8 || leaves.length > 10) {
    throw new Error('The initial tree needs 3 to 5 branches and 8 to 10 card-generating leaves.');
  }

  return nodes;
}

function treeMeta(tree) {
  if (!tree.meta || typeof tree.meta !== 'object' || Array.isArray(tree.meta)) {
    tree.meta = {};
  }
  return tree.meta;
}

function createTreeService({ state, persistence, hub, provider }) {
  async function ensureInitialTree(report) {
    if (hasTree(state.tree)) {
      return state.tree;
    }

    const generated = await provider.generateInitialTree({ report });
    const nodes = validateTreeNodes(generated?.nodes);
    state.tree = {
      meta: {
        created_at: new Date().toISOString(),
        surfaced_concept_ids: [],
      },
      nodes,
    };
    await persistence.saveTree(state.tree);
    hub.broadcast('tree', state.tree);
    return state.tree;
  }

  async function markSurfaced(conceptId) {
    if (!hasTree(state.tree) || !state.tree.nodes.some((node) => node.concept_id === conceptId)) {
      return false;
    }

    const meta = treeMeta(state.tree);
    const surfaced = Array.isArray(meta.surfaced_concept_ids) ? meta.surfaced_concept_ids : [];
    if (surfaced.includes(conceptId)) {
      return false;
    }

    meta.surfaced_concept_ids = [...surfaced, conceptId];
    await persistence.saveTree(state.tree);
    hub.broadcast('tree', state.tree);
    return true;
  }

  return { ensureInitialTree, markSurfaced };
}

module.exports = {
  createTreeService,
  hasTree,
  validateTreeNodes,
};
