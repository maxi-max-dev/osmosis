'use strict';

function normalizeStrength(value) {
  if (!Number.isInteger(value)) {
    return 0;
  }
  return Math.min(2, Math.max(0, value));
}

function strengthFor(strengths, conceptId) {
  return normalizeStrength(strengths[conceptId]?.strength);
}

function isMastered(strengths, conceptId) {
  return strengthFor(strengths, conceptId) >= 2;
}

function nextStrength(previousStrength, correct) {
  return Math.max(normalizeStrength(previousStrength), correct ? 2 : 1);
}

module.exports = {
  isMastered,
  nextStrength,
  normalizeStrength,
  strengthFor,
};
