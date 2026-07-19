'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { PROJECT_ID_PATTERN } = require('./project-registry');

const GLOBAL_LEARNING_ON = 'on';
const GLOBAL_LEARNING_PAUSED = 'paused';
const CAPTURE_AGENT_REPORTS_ONLY = 'agent-reports-only';
const CAPTURE_EXPERIMENTAL_AMBIENT = 'experimental-ambient';
const LESSON_LOCALE_ENGLISH = 'en';
const LESSON_LOCALE_SIMPLIFIED_CHINESE = 'zh-CN';

const GLOBAL_LEARNING_VALUES = new Set([GLOBAL_LEARNING_ON, GLOBAL_LEARNING_PAUSED]);
const CAPTURE_MODE_VALUES = new Set([CAPTURE_AGENT_REPORTS_ONLY, CAPTURE_EXPERIMENTAL_AMBIENT]);
const LESSON_LOCALE_VALUES = new Set([LESSON_LOCALE_ENGLISH, LESSON_LOCALE_SIMPLIFIED_CHINESE]);
const MAX_PENDING_ACTIVATION_REPORTS = 2;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultSettings() {
  return {
    version: 1,
    global_learning: GLOBAL_LEARNING_ON,
    lesson_locale: LESSON_LOCALE_ENGLISH,
    // This private queue keeps explicit agent milestones safe while a person
    // answers the one-time activation prompt. It is deliberately separate
    // from project state: an undecided project must not get a channel, tab,
    // tree, or project ledger merely because its runner has started.
    pending_activation: {},
    projects: {},
    // Private migration bookkeeping. It never appears in the browser-facing
    // settings snapshot, but distinguishes an old forced agent-only entry
    // from a learner's later explicit capture choice.
    migration: {
      ambient_capture_reviewed: {},
    },
  };
}

function normalizedCaptureMode(value) {
  return CAPTURE_MODE_VALUES.has(value) ? value : CAPTURE_AGENT_REPORTS_ONLY;
}

function normalizedLocale(value) {
  return LESSON_LOCALE_VALUES.has(value) ? value : LESSON_LOCALE_ENGLISH;
}

function normalizeProjectSetting(value) {
  if (!isPlainObject(value) || typeof value.carry !== 'boolean') {
    return null;
  }
  return {
    auto_advance: Boolean(value.auto_advance),
    carry: value.carry,
    capture_mode: normalizedCaptureMode(value.capture_mode),
  };
}

function normalizePendingReport(value) {
  if (!isPlainObject(value)
    || typeof value.task !== 'string'
    || typeof value.what_i_did !== 'string'
    || !Array.isArray(value.stack_hints)) {
    return null;
  }
  const stackHints = value.stack_hints
    .filter((hint) => typeof hint === 'string')
    .map((hint) => hint.slice(0, 120))
    .slice(0, 12);
  if (!value.task.trim() || !value.what_i_did.trim() || stackHints.length === 0) {
    return null;
  }
  return {
    task: value.task.slice(0, 240),
    what_i_did: value.what_i_did.slice(0, 4_000),
    stack_hints: stackHints,
    ...(typeof value.report_id === 'string' && value.report_id ? { report_id: value.report_id.slice(0, 128) } : {}),
    ...(value.source === 'observed' ? { source: 'observed' } : {}),
  };
}

function normalizeSettings(value) {
  const fallback = defaultSettings();
  if (!isPlainObject(value)) {
    return fallback;
  }
  const projects = {};
  if (isPlainObject(value.projects)) {
    for (const [projectId, setting] of Object.entries(value.projects)) {
      if (!PROJECT_ID_PATTERN.test(projectId)) {
        continue;
      }
      const normalized = normalizeProjectSetting(setting);
      if (normalized) {
        projects[projectId] = normalized;
      }
    }
  }
  const pendingActivation = {};
  if (isPlainObject(value.pending_activation)) {
    for (const [projectId, reports] of Object.entries(value.pending_activation)) {
      if (!PROJECT_ID_PATTERN.test(projectId) || !Array.isArray(reports)) {
        continue;
      }
      const normalizedReports = reports
        .map(normalizePendingReport)
        .filter(Boolean)
        .slice(-MAX_PENDING_ACTIVATION_REPORTS);
      if (normalizedReports.length > 0) {
        pendingActivation[projectId] = normalizedReports;
      }
    }
  }
  const ambientCaptureReviewed = {};
  if (isPlainObject(value.migration?.ambient_capture_reviewed)) {
    for (const [projectId, reviewed] of Object.entries(value.migration.ambient_capture_reviewed)) {
      if (PROJECT_ID_PATTERN.test(projectId) && reviewed === true) {
        ambientCaptureReviewed[projectId] = true;
      }
    }
  }
  return {
    version: 1,
    global_learning: GLOBAL_LEARNING_VALUES.has(value.global_learning)
      ? value.global_learning
      : fallback.global_learning,
    lesson_locale: normalizedLocale(value.lesson_locale),
    migration: { ambient_capture_reviewed: ambientCaptureReviewed },
    pending_activation: pendingActivation,
    projects,
  };
}

async function readSettings(settingsPath, fsApi = fs) {
  try {
    return normalizeSettings(JSON.parse(await fsApi.readFile(settingsPath, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return defaultSettings();
    }
    // A settings file must never keep the local learning wall from opening.
    // Treat a malformed document like a fresh profile; the next intentional
    // settings change overwrites it atomically with the public schema.
    if (error instanceof SyntaxError) {
      return defaultSettings();
    }
    throw error;
  }
}

async function writeSettingsAtomic(settingsPath, value, fsApi = fs) {
  const directory = path.dirname(settingsPath);
  await fsApi.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fsApi.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsApi.rename(temporaryPath, settingsPath);
  } catch (error) {
    await fsApi.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function activationFor(settings, projectId) {
  if (!PROJECT_ID_PATTERN.test(projectId || '')) {
    throw new TypeError('A settings activation needs a safe project id.');
  }
  const project = settings?.projects?.[projectId];
  const shared = {
    auto_advance: Boolean(project?.auto_advance),
    capture_mode: normalizedCaptureMode(project?.capture_mode),
    lesson_locale: normalizedLocale(settings?.lesson_locale),
    project_id: projectId,
  };
  if (!project) {
    return { ...shared, carry: null, state: 'activation-pending' };
  }
  return {
    ...shared,
    carry: project.carry,
    state: project.carry ? 'carried' : 'uncarried',
  };
}

function publicSettings(settings) {
  const snapshot = clone(settings);
  const pending = snapshot.pending_activation || {};
  delete snapshot.migration;
  delete snapshot.pending_activation;
  snapshot.pending_activation_counts = Object.fromEntries(
    Object.entries(pending).map(([projectId, reports]) => [projectId, Array.isArray(reports) ? reports.length : 0]),
  );
  return snapshot;
}

/**
 * User-level Learning Studio preferences. Project membership intentionally
 * lives here rather than being inferred from the broker registry: a project
 * only enters that registry after the user explicitly chooses Carry.
 */
function createSettingsStore({ profileDir, settingsPath, fsApi = fs } = {}) {
  if (typeof settingsPath !== 'string' && typeof profileDir !== 'string') {
    throw new TypeError('createSettingsStore needs profileDir or settingsPath.');
  }
  const filePath = settingsPath || path.join(profileDir, 'settings.json');
  let settings = defaultSettings();
  let loaded = false;
  let loading = null;
  let writeTail = Promise.resolve();

  async function load() {
    if (loaded) {
      return snapshot();
    }
    if (!loading) {
      loading = readSettings(filePath, fsApi).then((value) => {
        settings = value;
        loaded = true;
        return snapshot();
      });
    }
    return loading;
  }

  function snapshot() {
    return publicSettings(settings);
  }

  function project(projectId) {
    return activationFor(settings, projectId);
  }

  function enqueueWrite(work) {
    const next = writeTail.then(work);
    writeTail = next.catch(() => {});
    return next;
  }

  async function update(mutator) {
    await load();
    return enqueueWrite(async () => {
      const next = normalizeSettings(await mutator(clone(settings)));
      await writeSettingsAtomic(filePath, next, fsApi);
      settings = next;
      return snapshot();
    });
  }

  async function setGlobalLearning(globalLearning) {
    if (!GLOBAL_LEARNING_VALUES.has(globalLearning)) {
      throw new TypeError('Global learning must be "on" or "paused".');
    }
    return update((current) => ({ ...current, global_learning: globalLearning }));
  }

  async function setLessonLocale(lessonLocale) {
    if (!LESSON_LOCALE_VALUES.has(lessonLocale)) {
      throw new TypeError('Lesson locale must be "en" or "zh-CN".');
    }
    return update((current) => ({ ...current, lesson_locale: lessonLocale }));
  }

  async function setProject(projectId, patch) {
    if (!PROJECT_ID_PATTERN.test(projectId || '')) {
      throw new TypeError('Project settings need a safe project id.');
    }
    if (!isPlainObject(patch) || typeof patch.carry !== 'boolean' || !CAPTURE_MODE_VALUES.has(patch.capture_mode)) {
      throw new TypeError('Project settings need boolean carry and a supported capture_mode.');
    }
    return update((current) => ({
      ...current,
      projects: {
        ...current.projects,
        [projectId]: {
          auto_advance: typeof patch.auto_advance === 'boolean'
            ? patch.auto_advance
            : Boolean(current.projects[projectId]?.auto_advance),
          carry: patch.carry,
          capture_mode: patch.capture_mode,
        },
      },
    }));
  }

  function captureReviewed(projectId) {
    return settings.migration?.ambient_capture_reviewed?.[projectId] === true;
  }

  async function markCaptureReviewed(projectId) {
    if (!PROJECT_ID_PATTERN.test(projectId || '')) {
      throw new TypeError('Project settings need a safe project id.');
    }
    await update((current) => ({
      ...current,
      migration: {
        ...(current.migration || {}),
        ambient_capture_reviewed: {
          ...(current.migration?.ambient_capture_reviewed || {}),
          [projectId]: true,
        },
      },
    }));
  }

  /**
   * One-time owner migration for pre-Stage-1 carried projects. Once recorded,
   * a later explicit agent-only selection is never silently changed again.
   */
  async function preserveAmbientForLegacyProject(projectId) {
    if (!PROJECT_ID_PATTERN.test(projectId || '')) {
      throw new TypeError('Project settings need a safe project id.');
    }
    let changedCapture = false;
    let migrated = false;
    await update((current) => {
      const project = current.projects?.[projectId];
      if (!project?.carry || current.migration?.ambient_capture_reviewed?.[projectId] === true) {
        return current;
      }
      migrated = true;
      changedCapture = project.capture_mode !== CAPTURE_EXPERIMENTAL_AMBIENT;
      return {
        ...current,
        migration: {
          ...(current.migration || {}),
          ambient_capture_reviewed: {
            ...(current.migration?.ambient_capture_reviewed || {}),
            [projectId]: true,
          },
        },
        projects: {
          ...current.projects,
          [projectId]: {
            ...project,
            capture_mode: CAPTURE_EXPERIMENTAL_AMBIENT,
          },
        },
      };
    });
    return { changedCapture, migrated };
  }

  async function holdActivationReport(projectId, report) {
    if (!PROJECT_ID_PATTERN.test(projectId || '')) {
      throw new TypeError('Pending activation reports need a safe project id.');
    }
    const normalized = normalizePendingReport(report);
    if (!normalized) {
      throw new TypeError('Pending activation reports need the frozen report fields.');
    }
    return update((current) => {
      const reports = [...(current.pending_activation[projectId] || []), normalized];
      const retained = reports.slice(-MAX_PENDING_ACTIVATION_REPORTS);
      return {
        ...current,
        pending_activation: {
          ...current.pending_activation,
          [projectId]: retained,
        },
      };
    });
  }

  async function takePendingActivationReports(projectId) {
    if (!PROJECT_ID_PATTERN.test(projectId || '')) {
      throw new TypeError('Pending activation reports need a safe project id.');
    }
    await load();
    let reports = [];
    await enqueueWrite(async () => {
      reports = (settings.pending_activation[projectId] || []).map((report) => clone(report));
      if (reports.length === 0) {
        return;
      }
      const pendingActivation = { ...settings.pending_activation };
      delete pendingActivation[projectId];
      const next = normalizeSettings({ ...settings, pending_activation: pendingActivation });
      await writeSettingsAtomic(filePath, next, fsApi);
      settings = next;
    });
    return reports;
  }

  function pendingActivationReports(projectId) {
    if (!PROJECT_ID_PATTERN.test(projectId || '')) {
      throw new TypeError('Pending activation reports need a safe project id.');
    }
    return (settings.pending_activation[projectId] || []).map((report) => clone(report));
  }

  return {
    activationFor: project,
    get filePath() {
      return filePath;
    },
    isPaused: () => settings.global_learning === GLOBAL_LEARNING_PAUSED,
    load,
    project,
    setGlobalLearning,
    setLessonLocale,
    setProject,
    holdActivationReport,
    isCaptureReviewed: captureReviewed,
    markCaptureReviewed,
    pendingActivationReports,
    preserveAmbientForLegacyProject,
    snapshot,
    takePendingActivationReports,
    update,
    whenIdle: () => writeTail,
  };
}

module.exports = {
  CAPTURE_AGENT_REPORTS_ONLY,
  CAPTURE_EXPERIMENTAL_AMBIENT,
  GLOBAL_LEARNING_ON,
  GLOBAL_LEARNING_PAUSED,
  LESSON_LOCALE_ENGLISH,
  LESSON_LOCALE_SIMPLIFIED_CHINESE,
  MAX_PENDING_ACTIVATION_REPORTS,
  activationFor,
  createSettingsStore,
  defaultSettings,
  normalizeSettings,
  readSettings,
  writeSettingsAtomic,
};
