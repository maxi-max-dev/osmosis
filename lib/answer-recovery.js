'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { createAnswerReceiptStore, normalizeReceipt } = require('./answer-receipt-store');
const { createProfileStore, writeJsonAtomic } = require('./profile-store');

function integerAtLeast(value, minimum = 0) {
  return Number.isInteger(value) && value >= minimum ? value : minimum;
}

function laterTimestamp(left, right) {
  const leftMs = Date.parse(left || '');
  const rightMs = Date.parse(right || '');
  if (Number.isFinite(leftMs) && (!Number.isFinite(rightMs) || leftMs >= rightMs)) return left;
  return right;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function projectRootFor(profileDir, projectId) {
  const document = await readJson(path.join(profileDir, 'projects.json'));
  const project = Array.isArray(document?.projects)
    ? document.projects.find((item) => item?.project_id === projectId)
    : null;
  if (!project || typeof project.root !== 'string' || !project.root) {
    throw new Error('The receipt project is not registered locally, so Osmosis will not guess a card file.');
  }
  return project.root;
}

function matchingCard(card, receipt) {
  return card?.card_id === receipt.card_id && card?.concept_id === receipt.concept_id;
}

function cardAlreadyMatches(card, receipt) {
  return card?.state?.answered === true
    && card.state.chosen_index === receipt.chosen_index
    && card.state.correct === receipt.correct;
}

function applyReceiptToProfile(fresh, receipt) {
  const current = fresh[receipt.concept_id] && typeof fresh[receipt.concept_id] === 'object'
    ? fresh[receipt.concept_id]
    : {};
  fresh[receipt.concept_id] = {
    ...current,
    ...(typeof receipt.concept_name === 'string' && receipt.concept_name ? { name: receipt.concept_name } : {}),
    strength: Math.max(integerAtLeast(current.strength), receipt.resulting_strength),
    seen: Math.max(integerAtLeast(current.seen), receipt.resulting_seen),
    correct: Math.max(integerAtLeast(current.correct), receipt.resulting_correct),
    updated_at: laterTimestamp(current.updated_at, receipt.answered_at) || receipt.answered_at,
  };
  return fresh[receipt.concept_id];
}

function manualReceiptFor({ cardId, chosenIndex, conceptId, conceptName = '', correct, projectId, resultingStrength }) {
  const material = JSON.stringify({ cardId, chosenIndex, conceptId, correct, projectId, resultingStrength });
  const receiptId = `manual-${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
  return normalizeReceipt({
    answered_at: new Date().toISOString(),
    card_id: cardId,
    chosen_index: chosenIndex,
    concept_id: conceptId,
    ...(conceptName ? { concept_name: conceptName } : {}),
    correct,
    evidence: 'operator-confirmed-historical',
    project_id: projectId,
    receipt_id: receiptId,
    resulting_correct: correct ? 1 : 0,
    resulting_seen: 1,
    resulting_strength: resultingStrength,
  });
}

/**
 * Recover exactly one operator-confirmed answer receipt. This intentionally
 * never reads the delivery/activity ledger: a durable answer receipt is the
 * only evidence strong enough to mutate a card or shared mastery profile.
 */
async function recoverAnswerReceipt({ confirm = false, manualReceipt = null, profileDir, receiptId } = {}) {
  if (confirm !== true) {
    throw new Error('Recovery is deliberate. Re-run with --confirm after stopping every Osmosis wall process.');
  }
  if (typeof profileDir !== 'string' || !profileDir) {
    throw new TypeError('recoverAnswerReceipt needs profileDir.');
  }
  const receipts = createAnswerReceiptStore({ profileDir });
  const supplied = manualReceipt ? normalizeReceipt(manualReceipt) : null;
  const targetReceiptId = supplied?.receipt_id || receiptId;
  if (typeof targetReceiptId !== 'string' || !targetReceiptId) {
    throw new TypeError('recoverAnswerReceipt needs a receiptId or an operator-confirmed manual receipt.');
  }
  // The exclusive lease covers the full check → profile/card mutation →
  // consumed-marker sequence. A second CLI cannot observe an unconsumed
  // receipt between those steps and apply the same historical answer again.
  return receipts.withRestoreLease(targetReceiptId, async () => {
    if (await receipts.wasRestored(targetReceiptId)) {
      throw new Error('This answer receipt has already been restored; Osmosis will not apply it twice.');
    }
    // Historical answers predate receipts. Their only supported route is a
    // fully specified operator-confirmed declaration; we persist that exact
    // declaration before use so it becomes equally auditable from now on.
    const receipt = supplied
      ? await receipts.ensure(supplied)
      : await receipts.find(targetReceiptId);
    if (!receipt) {
      throw new Error('No durable answer receipt with that id was found. Osmosis will not infer one from a delivery ledger.');
    }

    const root = await projectRootFor(profileDir, receipt.project_id);
    const cardsPath = path.join(root, '.osmosis', 'cards.json');
    const document = await readJson(cardsPath);
    if (!Array.isArray(document?.cards)) {
      throw new Error('The registered project has no valid cards document, so recovery stopped without writing.');
    }
    const card = document.cards.find((item) => matchingCard(item, receipt));
    if (!card) {
      throw new Error('The exact card from this receipt is absent, so recovery stopped without creating a replacement.');
    }
    if (card.state?.answered === true && !cardAlreadyMatches(card, receipt)) {
      throw new Error('The current card answer conflicts with this receipt, so recovery stopped without overwriting it.');
    }

    const profileStore = createProfileStore({ profilePath: path.join(profileDir, 'profile.json') });
    await profileStore.update((fresh) => applyReceiptToProfile(fresh, receipt));

    let cardRestored = false;
    if (!cardAlreadyMatches(card, receipt)) {
      card.state = {
        answered: true,
        chosen_index: receipt.chosen_index,
        correct: receipt.correct,
      };
      card.answer_receipt = receipt;
      await writeJsonAtomic(cardsPath, document);
      cardRestored = true;
    }

    await receipts.markRestored(receipt);
    return {
      card_restored: cardRestored,
      concept_id: receipt.concept_id,
      project_id: receipt.project_id,
      receipt_id: receipt.receipt_id,
      resulting_strength: profileStore.strengths[receipt.concept_id]?.strength || receipt.resulting_strength,
    };
  });
}

module.exports = {
  applyReceiptToProfile,
  manualReceiptFor,
  recoverAnswerReceipt,
};
