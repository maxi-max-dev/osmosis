(function exposeMapCoverage(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OsmosisMapCoverage = api;
})(typeof globalThis === 'undefined' ? null : globalThis, function createMapCoverageApi() {
  'use strict';

  function hasOwn(value, key) {
    return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));
  }

  function normalizeConceptId(value) {
    if (typeof value !== 'string') return '';
    return value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // This intentionally mirrors lib/project-concepts.js. A legacy mastery
  // lookup is allowed for exactly one valid project/local separator, never
  // for shared global ids or malformed values.
  function splitNamespacedConceptId(conceptId) {
    if (typeof conceptId !== 'string') return null;
    const separator = conceptId.indexOf(':');
    if (separator <= 0 || separator === conceptId.length - 1 || conceptId.indexOf(':', separator + 1) !== -1) {
      return null;
    }
    const projectId = conceptId.slice(0, separator);
    const localId = conceptId.slice(separator + 1);
    if (normalizeConceptId(projectId) !== projectId || normalizeConceptId(localId) !== localId) return null;
    return { localId, projectId };
  }

  function normalizeStrength(value) {
    if (!Number.isInteger(value)) return 0;
    return Math.min(2, Math.max(0, value));
  }

  /**
   * Keep browser trail and coverage reads aligned with lib/mastery.js. A
   * direct record is authoritative even when its strength is zero: only a
   * fully absent record may use the legacy local-id read path.
   */
  function strengthFor(strengths, conceptId) {
    if (typeof conceptId !== 'string' || !conceptId) return 0;
    if (hasOwn(strengths, conceptId)) return normalizeStrength(strengths[conceptId]?.strength);
    const namespaced = splitNamespacedConceptId(conceptId);
    if (!namespaced) return 0;
    return normalizeStrength(strengths?.[namespaced.localId]?.strength);
  }

  // This is the browser-side equivalent of lib/concepts.js:22. The tree is
  // already server-validated; the small guard merely keeps a stale snapshot
  // from making the view throw while it reconnects.
  function cardGeneratingLeaves(tree) {
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const parents = new Set(nodes.map((node) => node?.parent_id).filter(Boolean));
    return nodes.filter((node) => typeof node?.concept_id === 'string' && !parents.has(node.concept_id));
  }

  function surfacedConceptIds(tree, cards, studio) {
    const surfaced = new Set(
      (Array.isArray(tree?.meta?.surfaced_concept_ids) ? tree.meta.surfaced_concept_ids : [])
        .filter((conceptId) => typeof conceptId === 'string'),
    );
    const realCards = Array.isArray(cards) ? [...cards] : [];
    if (studio?.now?.kind === 'real' && studio.current) realCards.push(studio.current);
    for (const card of realCards) {
      // Warmups have a warmup_id, never a card_id. Requiring the latter makes
      // their local orientation deliberately invisible to the project map.
      if (typeof card?.card_id === 'string' && typeof card?.concept_id === 'string') {
        surfaced.add(card.concept_id);
      }
    }
    return surfaced;
  }

  function deriveMapCoverage({ tree, strengths, cards, studio } = {}) {
    const leaves = cardGeneratingLeaves(tree);
    const surfaced = surfacedConceptIds(tree, cards, studio);
    let mastered = 0;
    let surfacedNotMastered = 0;
    let waiting = 0;

    for (const leaf of leaves) {
      if (strengthFor(strengths, leaf.concept_id) >= 2) {
        mastered += 1;
      } else if (surfaced.has(leaf.concept_id)) {
        surfacedNotMastered += 1;
      } else {
        waiting += 1;
      }
    }

    return {
      mastered,
      surfaced: surfacedNotMastered,
      total: leaves.length,
      waiting,
    };
  }

  function isVisibleCoverage(activation, coverage) {
    return activation?.carry === true && activation?.state === 'carried' && Number(coverage?.total) > 0;
  }

  return {
    cardGeneratingLeaves,
    deriveMapCoverage,
    isVisibleCoverage,
    splitNamespacedConceptId,
    strengthFor,
  };
});
