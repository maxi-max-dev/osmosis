'use strict';

const { localConceptId, splitNamespacedConceptId } = require('./project-concepts');

function normalizeStrength(value) {
  if (!Number.isInteger(value)) {
    return 0;
  }
  return Math.min(2, Math.max(0, value));
}

function strengthFor(strengths, conceptId) {
  const direct = strengths?.[conceptId];
  if (direct) {
    return normalizeStrength(direct.strength);
  }
  // Projects created before broker v1 stored generated concepts without a
  // project prefix. Read that legacy record while the new namespace becomes
  // the write target, so an existing user's progress never disappears.
  if (splitNamespacedConceptId(conceptId)) {
    return normalizeStrength(strengths?.[localConceptId(conceptId)]?.strength);
  }
  return 0;
}

function entryFor(strengths, conceptId) {
  if (strengths?.[conceptId]) {
    return strengths[conceptId];
  }
  if (splitNamespacedConceptId(conceptId)) {
    return strengths?.[localConceptId(conceptId)] || null;
  }
  return null;
}

function isMastered(strengths, conceptId) {
  return strengthFor(strengths, conceptId) >= 2;
}

function nextStrength(previousStrength, correct) {
  return Math.max(normalizeStrength(previousStrength), correct ? 2 : 1);
}

module.exports = {
  entryFor,
  isMastered,
  nextStrength,
  normalizeStrength,
  strengthFor,
};
