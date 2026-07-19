'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { PROJECT_ID_PATTERN } = require('./project-registry');

const LEDGER_STATES = new Set(['observed', 'waiting', 'suppressed', 'skipped', 'failed', 'delivered']);
const TERMINAL_STATES = new Set(['suppressed', 'skipped', 'failed', 'delivered']);

function defaultNow() {
  return new Date().toISOString();
}

function boundedText(value, maximum = 1_024) {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.slice(0, maximum);
}

function normalizeProjectId(projectId) {
  if (projectId === undefined || projectId === null || projectId === '') {
    return 'unregistered';
  }
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    throw new TypeError('Ledger project_id must be a safe registered project id.');
  }
  return projectId;
}

function normalizeEntry(projectId, entry, now = defaultNow) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('Ledger entries must be objects.');
  }
  const state = entry.state || 'observed';
  if (!LEDGER_STATES.has(state)) {
    throw new TypeError(`Unsupported ledger state: ${state}.`);
  }
  const event = boundedText(entry.event, 96);
  if (!event) {
    throw new TypeError('Ledger entries need an event.');
  }

  const normalized = {
    ts: typeof entry.ts === 'string' ? entry.ts : typeof entry.at === 'string' ? entry.at : now(),
    project_id: normalizeProjectId(projectId),
    event,
    state,
  };
  for (const [key, maximum] of [
    ['report_id', 128],
    ['card_id', 128],
    ['concept_id', 256],
    ['message', 2_048],
    ['reason', 256],
    ['source', 96],
  ]) {
    const value = boundedText(entry[key], maximum);
    if (value) {
      normalized[key] = value;
    }
  }
  return normalized;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function parseJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return value && typeof value === 'object' ? [value] : [];
        } catch {
          // A crash can leave a partial final line. It must not make the
          // activity drawer unavailable after restart.
          return [];
        }
      });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function serializeWithinLimit(entry, maxBytes) {
  let candidate = { ...entry };
  let line = `${JSON.stringify(candidate)}\n`;
  if (Buffer.byteLength(line) <= maxBytes) {
    return line;
  }

  if (candidate.message) {
    const overhead = Buffer.byteLength(line) - Buffer.byteLength(candidate.message);
    const available = Math.max(0, maxBytes - overhead - 4);
    candidate.message = Buffer.from(candidate.message).subarray(0, available).toString('utf8');
    line = `${JSON.stringify(candidate)}\n`;
    if (Buffer.byteLength(line) <= maxBytes) {
      return line;
    }
  }

  candidate = {
    ts: candidate.ts,
    project_id: candidate.project_id,
    event: 'truncated',
    state: candidate.state,
  };
  line = `${JSON.stringify(candidate)}\n`;
  // A normal production cap is hundreds of KiB. The fallback is useful for
  // small test caps too, while preserving one valid JSONL record whenever it
  // can fit at all.
  return line;
}

/**
 * User-level durable trace storage for the activity drawer. Each project has
 * an independently readable JSONL file, with one previous generation kept as
 * a bounded rotation. It never writes into a source repository.
 */
function createLedger({ profileDir, ledgerDir, maxBytes = 512 * 1024, ringSize = 200, now = defaultNow } = {}) {
  if (typeof ledgerDir !== 'string' && typeof profileDir !== 'string') {
    throw new TypeError('createLedger needs profileDir or ledgerDir.');
  }
  const directory = ledgerDir || path.join(profileDir, 'ledger');
  const byteLimit = Math.max(128, Number.isInteger(maxBytes) ? maxBytes : 512 * 1024);
  const memoryLimit = Math.max(1, Number.isInteger(ringSize) ? ringSize : 200);
  const ring = new Map();
  let writeTail = Promise.resolve();

  function filePathFor(projectId) {
    return path.join(directory, `${normalizeProjectId(projectId)}.jsonl`);
  }

  function rotationPathFor(projectId) {
    return `${filePathFor(projectId)}.1`;
  }

  function remember(entry) {
    const entries = ring.get(entry.project_id) || [];
    entries.push(entry);
    if (entries.length > memoryLimit) {
      entries.splice(0, entries.length - memoryLimit);
    }
    ring.set(entry.project_id, entries);
  }

  function enqueue(work) {
    const next = writeTail.then(work);
    writeTail = next.catch(() => {});
    return next;
  }

  async function rotateIfNeeded(projectId, line) {
    const currentPath = filePathFor(projectId);
    try {
      const info = await fs.stat(currentPath);
      if (info.size === 0 || info.size + Buffer.byteLength(line) <= byteLimit) {
        return;
      }
      const rotatedPath = rotationPathFor(projectId);
      if (await exists(rotatedPath)) {
        await fs.unlink(rotatedPath);
      }
      await fs.rename(currentPath, rotatedPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  function append(projectId, entry) {
    const normalized = normalizeEntry(projectId, entry, now);
    const line = serializeWithinLimit(normalized, byteLimit);
    return enqueue(async () => {
      await fs.mkdir(directory, { recursive: true });
      await rotateIfNeeded(normalized.project_id, line);
      await fs.appendFile(filePathFor(normalized.project_id), line, { encoding: 'utf8', mode: 0o600 });
      remember(normalized);
      return { ...normalized };
    });
  }

  async function list(projectId, { limit = 100 } = {}) {
    const id = normalizeProjectId(projectId);
    await writeTail;
    const safeLimit = Math.max(1, Math.min(1_000, Number.isInteger(limit) ? limit : 100));
    const diskEntries = [
      ...(await parseJsonLines(rotationPathFor(id))),
      ...(await parseJsonLines(filePathFor(id))),
    ];
    if (diskEntries.length > 0) {
      return diskEntries.slice(-safeLimit);
    }
    return (ring.get(id) || []).slice(-safeLimit).map((entry) => ({ ...entry }));
  }

  async function reconcileDangling(projectId, { retainReportIds = [], retainCardIds = [] } = {}) {
    const entries = await list(projectId, { limit: memoryLimit * 2 });
    const retainedReports = new Set(
      (Array.isArray(retainReportIds) ? retainReportIds : [])
        .filter((reportId) => typeof reportId === 'string' && reportId),
    );
    const retainedCards = new Set(
      (Array.isArray(retainCardIds) ? retainCardIds : [])
        .filter((cardId) => typeof cardId === 'string' && cardId),
    );
    const byReport = new Map();
    for (const entry of entries) {
      if (entry.report_id) {
        byReport.set(entry.report_id, entry);
      }
    }
    const reconciled = [];
    for (const entry of byReport.values()) {
      // Studio candidates, in-flight work, the visible current card, and the
      // hidden Next buffer all have durable state outside the ledger. The
      // exclusive owner supplies both trace keys before reconciliation so a
      // live lesson can never be falsely called "lost at restart".
      if (
        (entry.report_id && retainedReports.has(entry.report_id))
        || (entry.card_id && retainedCards.has(entry.card_id))
      ) {
        continue;
      }
      if (!TERMINAL_STATES.has(entry.state)) {
        reconciled.push(
          await append(projectId, {
            event: 'reconcile',
            report_id: entry.report_id,
            state: 'skipped',
            message: 'lost at restart',
          }),
        );
      }
    }
    return reconciled;
  }

  function forProject(projectId) {
    const id = normalizeProjectId(projectId);
    return {
      append: (entry) => append(id, entry),
      appendEvent: (entry) => append(id, entry),
      filePath: () => filePathFor(id),
      list: (options) => list(id, options),
      recent: (options) => list(id, options),
      reconcile: (options) => reconcileDangling(id, options),
      reconcileDangling: (options) => reconcileDangling(id, options),
      record: (entry) => append(id, entry),
    };
  }

  return {
    append,
    appendEvent: append,
    directory,
    filePathFor,
    forProject,
    list,
    recent: list,
    reconcile: reconcileDangling,
    reconcileDangling,
    record: append,
    rotationPathFor,
    whenIdle: () => writeTail,
  };
}

module.exports = {
  LEDGER_STATES,
  TERMINAL_STATES,
  createLedger,
  normalizeEntry,
  normalizeProjectId,
  parseJsonLines,
};
