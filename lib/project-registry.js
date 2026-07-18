'use strict';

const { randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const DEFAULT_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1_000;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultNow() {
  return new Date().toISOString();
}

function timestampMs(value) {
  if (Number.isFinite(value)) {
    return Number(value);
  }
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function defaultToken() {
  return randomBytes(24).toString('base64url');
}

function summaryFromIdentity(identity, previous, { now = defaultNow, touch = true, unarchive = true } = {}) {
  if (!isPlainObject(identity) || !PROJECT_ID_PATTERN.test(identity.project_id || '') || typeof identity.root !== 'string' || !identity.root) {
    throw new TypeError('A project identity needs a safe project_id and canonical root.');
  }

  const lastActivity = touch ? now() : previous?.last_activity_at || null;
  return {
    project_id: identity.project_id,
    root: identity.root,
    name: typeof identity.name === 'string' && identity.name.trim() ? identity.name.trim().slice(0, 160) : path.basename(identity.root) || 'project',
    unanswered_count: nonNegativeInteger(identity.unanswered_count, previous?.unanswered_count || 0),
    last_activity_at: lastActivity,
    archived: unarchive ? false : Boolean(previous?.archived),
  };
}

function normalizeSummary(value) {
  if (!isPlainObject(value) || !PROJECT_ID_PATTERN.test(value.project_id || '') || typeof value.root !== 'string' || !value.root) {
    return null;
  }
  return {
    project_id: value.project_id,
    root: value.root,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 160) : path.basename(value.root) || 'project',
    unanswered_count: nonNegativeInteger(value.unanswered_count),
    last_activity_at: typeof value.last_activity_at === 'string' ? value.last_activity_at : null,
    archived: Boolean(value.archived),
  };
}

async function readIndex(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (!isPlainObject(parsed) || !Array.isArray(parsed.projects)) {
      return [];
    }
    return parsed.projects.map(normalizeSummary).filter(Boolean);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

/**
 * Registry metadata intentionally stays small. Service graphs live outside
 * this module and are attached lazily with hydrateProject(), so merely
 * reconnecting the wall never constructs every old project channel.
 */
function createProjectRegistry({
  profileDir,
  projectsPath,
  now = defaultNow,
  tokenFactory = defaultToken,
  archiveAfterMs = DEFAULT_ARCHIVE_AFTER_MS,
} = {}) {
  if (typeof projectsPath !== 'string' && typeof profileDir !== 'string') {
    throw new TypeError('createProjectRegistry needs profileDir or projectsPath.');
  }

  const indexPath = projectsPath || path.join(profileDir, 'projects.json');
  const inactivityLimit = Number.isFinite(archiveAfterMs) && archiveAfterMs > 0
    ? archiveAfterMs
    : DEFAULT_ARCHIVE_AFTER_MS;
  const summaries = new Map();
  // More than one local MCP process can represent the same project (Codex
  // commonly starts a companion process). Keep all live capabilities rather
  // than invalidating the first relay when the second one registers.
  const tokens = new Map();
  const channels = new Map();
  const hydrations = new Map();
  let loaded = false;
  let loading = null;
  let writeTail = Promise.resolve();

  async function load() {
    if (loaded) {
      return listProjects();
    }
    if (!loading) {
      loading = readIndex(indexPath).then((entries) => {
        for (const entry of entries) {
          summaries.set(entry.project_id, entry);
        }
        loaded = true;
        return listProjects();
      });
    }
    return loading;
  }

  function document() {
    return {
      version: 1,
      projects: [...summaries.values()]
        .map((summary) => clone(summary))
        .sort((left, right) => left.project_id.localeCompare(right.project_id)),
    };
  }

  function enqueueWrite(work) {
    const next = writeTail.then(work);
    writeTail = next.catch(() => {});
    return next;
  }

  function persist() {
    return enqueueWrite(() => writeJsonAtomic(indexPath, document()));
  }

  function listProjects() {
    return [...summaries.values()]
      .map((summary) => clone(summary))
      .sort((left, right) => {
        const leftTime = Date.parse(left.last_activity_at || '') || 0;
        const rightTime = Date.parse(right.last_activity_at || '') || 0;
        return rightTime - leftTime || left.name.localeCompare(right.name) || left.project_id.localeCompare(right.project_id);
      });
  }

  function getProject(projectId) {
    const summary = summaries.get(projectId);
    return summary ? clone(summary) : null;
  }

  function findByRoot(root) {
    for (const summary of summaries.values()) {
      if (summary.root === root) {
        return clone(summary);
      }
    }
    return null;
  }

  async function ensureProject(identity, options = {}) {
    await load();
    const previous = summaries.get(identity?.project_id);
    if (previous && previous.root !== identity.root) {
      throw new Error(`Project id collision for ${identity.project_id}.`);
    }
    const summary = summaryFromIdentity(identity, previous, { now, ...options });
    summaries.set(summary.project_id, summary);
    await persist();
    return clone(summary);
  }

  async function registerProject(identity) {
    const project = await ensureProject(identity, { touch: true, unarchive: true });
    const token = tokenFactory();
    if (typeof token !== 'string' || token.length < 16) {
      throw new Error('Registration token factory returned an unsafe token.');
    }
    // Tokens are capability secrets for live relay processes. Do not write
    // them to projects.json; a fresh broker requires a fresh registration.
    const projectTokens = tokens.get(project.project_id) || new Set();
    projectTokens.add(token);
    tokens.set(project.project_id, projectTokens);
    return { project_id: project.project_id, token, project };
  }

  async function updateProject(projectId, patch) {
    await load();
    const previous = summaries.get(projectId);
    if (!previous) {
      return null;
    }
    const update = typeof patch === 'function' ? patch(clone(previous)) : patch;
    if (!isPlainObject(update)) {
      throw new TypeError('Project summary updates must be an object or a function returning one.');
    }
    const next = {
      ...previous,
      name: typeof update.name === 'string' && update.name.trim() ? update.name.trim().slice(0, 160) : previous.name,
      unanswered_count: Object.hasOwn(update, 'unanswered_count')
        ? nonNegativeInteger(update.unanswered_count, previous.unanswered_count)
        : previous.unanswered_count,
      last_activity_at:
        typeof update.last_activity_at === 'string'
          ? update.last_activity_at
          : update.touch
            ? now()
            : previous.last_activity_at,
      archived: Object.hasOwn(update, 'archived') ? Boolean(update.archived) : previous.archived,
    };
    summaries.set(projectId, next);
    await persist();
    return clone(next);
  }

  async function markActivity(projectId, { unansweredCount } = {}) {
    return updateProject(projectId, {
      touch: true,
      archived: false,
      ...(Number.isInteger(unansweredCount) ? { unanswered_count: unansweredCount } : {}),
    });
  }

  async function setUnansweredCount(projectId, unansweredCount) {
    return updateProject(projectId, { unanswered_count: unansweredCount });
  }

  async function setArchived(projectId, archived = true) {
    return updateProject(projectId, { archived: Boolean(archived) });
  }

  /**
   * Move dormant channels to the archived group without removing any
   * registration, cards, tree data, or ledger history. The broker excludes
   * its current default channel so opening Osmosis never hides the project
   * the user is actively working in.
   */
  async function archiveInactive({ exceptProjectId = null, at = now() } = {}) {
    await load();
    const currentTime = timestampMs(at);
    if (!Number.isFinite(currentTime)) {
      return [];
    }
    const archived = [];
    for (const [projectId, summary] of summaries) {
      if (projectId === exceptProjectId || summary.archived) {
        continue;
      }
      const lastActivity = timestampMs(summary.last_activity_at);
      if (!Number.isFinite(lastActivity) || currentTime - lastActivity < inactivityLimit) {
        continue;
      }
      const next = { ...summary, archived: true };
      summaries.set(projectId, next);
      archived.push(clone(next));
    }
    if (archived.length > 0) {
      await persist();
    }
    return archived;
  }

  function validateToken(projectId, candidate) {
    const expectedTokens = tokens.get(projectId);
    if (!(expectedTokens instanceof Set) || typeof candidate !== 'string') {
      return false;
    }
    const right = Buffer.from(candidate);
    let matched = false;
    for (const expected of expectedTokens) {
      const left = Buffer.from(expected);
      // Compare every registered token rather than exiting on the first
      // match, so the result does not expose which relay capability matched.
      matched = (left.length === right.length && timingSafeEqual(left, right)) || matched;
    }
    return matched;
  }

  function revokeToken(projectId, token) {
    if (token === undefined) {
      tokens.delete(projectId);
      return;
    }
    const projectTokens = tokens.get(projectId);
    if (!projectTokens) {
      return;
    }
    projectTokens.delete(token);
    if (projectTokens.size === 0) {
      tokens.delete(projectId);
    }
  }

  function getHydratedProject(projectId) {
    return channels.get(projectId) || null;
  }

  async function hydrateProject(projectId, factory) {
    await load();
    if (channels.has(projectId)) {
      return channels.get(projectId);
    }
    if (!summaries.has(projectId)) {
      return null;
    }
    if (hydrations.has(projectId)) {
      return hydrations.get(projectId);
    }
    if (typeof factory !== 'function') {
      throw new TypeError('hydrateProject needs a channel factory.');
    }
    const pending = Promise.resolve()
      .then(() => factory(clone(summaries.get(projectId))))
      .then((channel) => {
        if (!channel) {
          throw new Error(`Could not hydrate project ${projectId}.`);
        }
        channels.set(projectId, channel);
        return channel;
      })
      .finally(() => {
        hydrations.delete(projectId);
      });
    hydrations.set(projectId, pending);
    return pending;
  }

  function attachHydratedProject(projectId, channel) {
    if (!summaries.has(projectId)) {
      throw new Error(`Cannot attach an unregistered project: ${projectId}.`);
    }
    channels.set(projectId, channel);
    return channel;
  }

  function releaseHydratedProject(projectId) {
    channels.delete(projectId);
  }

  return {
    archiveInactive,
    attachHydratedProject,
    ensureChannel: hydrateProject,
    ensureProject,
    findByRoot,
    getOrHydrate: hydrateProject,
    getChannel: getHydratedProject,
    getHydratedProject,
    getProject,
    getSummary: getProject,
    hydrateProject,
    indexPath,
    listProjects,
    listSummaries: listProjects,
    load,
    markActivity,
    ready: load,
    register: registerProject,
    registerProject,
    releaseHydratedProject,
    revokeToken,
    setArchived,
    setUnansweredCount,
    touchProject: markActivity,
    updateProject,
    validateToken,
    whenIdle: () => writeTail,
  };
}

module.exports = {
  DEFAULT_ARCHIVE_AFTER_MS,
  PROJECT_ID_PATTERN,
  createProjectRegistry,
  normalizeSummary,
  summaryFromIdentity,
  writeJsonAtomic,
};
