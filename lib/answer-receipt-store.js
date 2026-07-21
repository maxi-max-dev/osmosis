'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { PROJECT_ID_PATTERN } = require('./project-registry');
const { acquireProfileLock } = require('./profile-store');

const RECEIPT_FORMAT = 'osmosis-answer-receipt-v1';
const RESTORE_FORMAT = 'osmosis-answer-restore-v1';

function boundedText(value, maximum) {
  return typeof value === 'string' && value ? value.slice(0, maximum) : null;
}

function nonNegativeInteger(value, fallback = null) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function receiptDirectory(profileDir) {
  return path.join(profileDir, 'receipts');
}

function receiptPathFor(profileDir, projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new TypeError('Answer receipt project_id must be a safe registered project id.');
  }
  return path.join(receiptDirectory(profileDir), `${projectId}.jsonl`);
}

function restorePathFor(profileDir) {
  return path.join(receiptDirectory(profileDir), 'restores.jsonl');
}

function restoreLeasePathFor(profileDir, receiptId) {
  if (typeof receiptId !== 'string' || !receiptId) {
    throw new TypeError('Answer receipt restore lease needs a receipt id.');
  }
  const digest = createHash('sha256').update(receiptId, 'utf8').digest('hex');
  return path.join(receiptDirectory(profileDir), `.restore-${digest}.lock`);
}

function normalizeReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Answer receipts must be objects.');
  }
  const receiptId = boundedText(value.receipt_id, 128);
  const projectId = boundedText(value.project_id, 192);
  const cardId = boundedText(value.card_id, 128);
  const conceptId = boundedText(value.concept_id, 256);
  const conceptName = boundedText(value.concept_name, 256);
  const chosenIndex = nonNegativeInteger(value.chosen_index);
  const resultingStrength = nonNegativeInteger(value.resulting_strength);
  const resultingSeen = nonNegativeInteger(value.resulting_seen);
  const resultingCorrect = nonNegativeInteger(value.resulting_correct);
  const evidence = boundedText(value.evidence, 128);
  if (
    !receiptId
    || !projectId
    || !PROJECT_ID_PATTERN.test(projectId)
    || !cardId
    || !conceptId
    || chosenIndex === null
    || chosenIndex > 2
    || typeof value.correct !== 'boolean'
    || resultingStrength === null
    || resultingStrength > 2
    || resultingSeen === null
    || resultingCorrect === null
  ) {
    throw new TypeError('Answer receipt has invalid stable answer fields.');
  }
  return {
    answered_at: boundedText(value.answered_at, 64) || new Date().toISOString(),
    card_id: cardId,
    chosen_index: chosenIndex,
    concept_id: conceptId,
    ...(conceptName ? { concept_name: conceptName } : {}),
    correct: value.correct,
    ...(evidence ? { evidence } : {}),
    format: RECEIPT_FORMAT,
    project_id: projectId,
    receipt_id: receiptId,
    resulting_correct: resultingCorrect,
    resulting_seen: resultingSeen,
    resulting_strength: resultingStrength,
  };
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text.split('\n').filter(Boolean).flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
      } catch {
        // A torn final append should never make a later recovery impossible.
        return [];
      }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Immutable answer evidence lives separately from the bounded activity
 * ledger. It deliberately never reuses a ledger state, so the six-state
 * activity contract remains untouched while a past answer stays recoverable.
 */
function createAnswerReceiptStore({ profileDir } = {}) {
  if (typeof profileDir !== 'string' || !profileDir) {
    throw new TypeError('createAnswerReceiptStore needs profileDir.');
  }
  const receiptIds = new Map();
  let writeTail = Promise.resolve();

  function enqueue(work) {
    const next = writeTail.then(work);
    writeTail = next.catch(() => {});
    return next;
  }

  async function idsFor(projectId) {
    if (receiptIds.has(projectId)) return receiptIds.get(projectId);
    const ids = new Set(
      (await readJsonLines(receiptPathFor(profileDir, projectId)))
        .map((entry) => entry?.receipt_id)
        .filter((receiptId) => typeof receiptId === 'string' && receiptId),
    );
    receiptIds.set(projectId, ids);
    return ids;
  }

  function ensure(value) {
    const receipt = normalizeReceipt(value);
    return enqueue(async () => {
      const ids = await idsFor(receipt.project_id);
      if (ids.has(receipt.receipt_id)) {
        return { ...receipt, duplicate: true };
      }
      const directory = receiptDirectory(profileDir);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.appendFile(receiptPathFor(profileDir, receipt.project_id), `${JSON.stringify(receipt)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      ids.add(receipt.receipt_id);
      return { ...receipt };
    });
  }

  async function find(receiptId) {
    if (typeof receiptId !== 'string' || !receiptId) return null;
    let files;
    try {
      files = await fs.readdir(receiptDirectory(profileDir), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    for (const file of files.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!file.isFile() || !file.name.endsWith('.jsonl') || file.name === 'restores.jsonl') continue;
      const entries = await readJsonLines(path.join(receiptDirectory(profileDir), file.name));
      const receipt = entries.find((entry) => entry?.format === RECEIPT_FORMAT && entry?.receipt_id === receiptId);
      if (receipt) return normalizeReceipt(receipt);
    }
    return null;
  }

  async function wasRestored(receiptId) {
    return (await readJsonLines(restorePathFor(profileDir))).some(
      (entry) => entry?.format === RESTORE_FORMAT && entry?.receipt_id === receiptId,
    );
  }

  function markRestored(receipt) {
    const normalized = normalizeReceipt(receipt);
    return enqueue(async () => {
      const existing = await readJsonLines(restorePathFor(profileDir));
      if (existing.some((entry) => entry?.format === RESTORE_FORMAT && entry?.receipt_id === normalized.receipt_id)) {
        return { receipt_id: normalized.receipt_id, duplicate: true };
      }
      const directory = receiptDirectory(profileDir);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const record = {
        format: RESTORE_FORMAT,
        project_id: normalized.project_id,
        receipt_id: normalized.receipt_id,
        restored_at: new Date().toISOString(),
      };
      await fs.appendFile(restorePathFor(profileDir), `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return record;
    });
  }

  async function withRestoreLease(receiptId, work) {
    if (typeof work !== 'function') {
      throw new TypeError('Answer receipt restore lease needs work.');
    }
    const lock = await acquireProfileLock({ lockPath: restoreLeasePathFor(profileDir, receiptId) });
    try {
      return await work();
    } finally {
      await lock.release();
    }
  }

  return {
    ensure,
    find,
    markRestored,
    receiptDirectory: () => receiptDirectory(profileDir),
    receiptPathFor: (projectId) => receiptPathFor(profileDir, projectId),
    restoreLeasePathFor: (receiptId) => restoreLeasePathFor(profileDir, receiptId),
    wasRestored,
    withRestoreLease,
    whenIdle: () => writeTail,
  };
}

module.exports = {
  RECEIPT_FORMAT,
  RESTORE_FORMAT,
  createAnswerReceiptStore,
  normalizeReceipt,
  readJsonLines,
  receiptDirectory,
  receiptPathFor,
  restoreLeasePathFor,
  restorePathFor,
};
