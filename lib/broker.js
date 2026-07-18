'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { createAnswerService } = require('./answer-service');
const { createCardService } = require('./card-service');
const { createCurriculumService, unansweredCount } = require('./curriculum-service');
const { createLedger } = require('./ledger');
const { renderInlineCard } = require('./inline-card');
const { log } = require('./log');
const { createProfileStore } = require('./profile-store');
const { resolveProjectIdentity } = require('./project-identity');
const { createProjectRegistry } = require('./project-registry');
const { createProvider } = require('./provider');
const { createReportPipeline } = require('./report-pipeline');
const { createReplayService } = require('./replay');
const { createPersistence, loadProjectState, snapshotFor } = require('./state');
const { createTreeService } = require('./tree-service');

function projectConfig(baseConfig, summary) {
  const stateDir = path.join(summary.root, '.osmosis');
  return {
    ...baseConfig,
    cwd: summary.root,
    projectId: summary.project_id,
    projectRoot: summary.root,
    replayPath: path.join(stateDir, 'replay.json'),
    stateDir,
    treePath: path.join(stateDir, 'tree.json'),
  };
}

function safeQueueCap(config) {
  const value = Number.isInteger(config?.globalReportQueueCap)
    ? config.globalReportQueueCap
    : config?.unansweredCardCap;
  return Math.max(1, Number.isInteger(value) ? value : 5);
}

/**
 * A bounded fair scheduler shared by all hydrated channels. One channel gets
 * at most one active generation at a time; available slots rotate through
 * project buckets, so a busy rollout cannot consume every slot before a
 * quieter project reaches its first lesson.
 */
function createFairReportScheduler({ maxPending = 5, onError = () => {} } = {}) {
  const queues = new Map();
  const activeProjects = new Set();
  let active = 0;
  let cursor = 0;
  let closed = false;
  let idleResolvers = [];

  function queuedCount() {
    let count = 0;
    for (const queue of queues.values()) {
      count += queue.length;
    }
    return count;
  }

  function totalCount() {
    return active + queuedCount();
  }

  function resolveIdle() {
    if (totalCount() !== 0) {
      return;
    }
    for (const resolve of idleResolvers) {
      resolve();
    }
    idleResolvers = [];
  }

  function dropForFairness(incomingProjectId) {
    const candidates = [...queues.entries()]
      .filter(([projectId, queue]) => projectId !== incomingProjectId && queue.length > 0)
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
    const victim = candidates[0];
    if (!victim) {
      return false;
    }
    const dropped = victim[1].pop();
    if (victim[1].length === 0) {
      queues.delete(victim[0]);
    }
    try {
      dropped?.onDropped?.();
    } catch (error) {
      onError(error);
    }
    return Boolean(dropped);
  }

  function nextProjectId() {
    const ids = [...queues.keys()].filter((projectId) => !activeProjects.has(projectId)).sort();
    if (ids.length === 0) {
      return null;
    }
    const index = cursor % ids.length;
    cursor += 1;
    return ids[index];
  }

  function pump() {
    if (closed) {
      return;
    }
    while (active < maxPending) {
      const projectId = nextProjectId();
      if (!projectId) {
        break;
      }
      const queue = queues.get(projectId);
      const item = queue.shift();
      if (queue.length === 0) {
        queues.delete(projectId);
      }
      if (!item) {
        continue;
      }
      active += 1;
      activeProjects.add(projectId);
      Promise.resolve()
        .then(item.run)
        .catch((error) => onError(error))
        .finally(() => {
          active = Math.max(0, active - 1);
          activeProjects.delete(projectId);
          pump();
          resolveIdle();
        });
    }
    resolveIdle();
  }

  function enqueue(projectId, { onDropped, run } = {}) {
    if (closed || typeof projectId !== 'string' || typeof run !== 'function') {
      return false;
    }
    if (totalCount() >= maxPending) {
      // A new project displaces one queued noisy-neighbour item if possible.
      // We never cancel an in-flight provider request.
      if (!dropForFairness(projectId)) {
        return false;
      }
    }
    const queue = queues.get(projectId) || [];
    queue.push({ onDropped, run });
    queues.set(projectId, queue);
    pump();
    return true;
  }

  function whenIdle() {
    if (totalCount() === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => idleResolvers.push(resolve));
  }

  return {
    close() {
      closed = true;
      for (const queue of queues.values()) {
        for (const item of queue) {
          try {
            item.onDropped?.();
          } catch (error) {
            onError(error);
          }
        }
      }
      queues.clear();
      resolveIdle();
    },
    enqueue,
    getDebugState: () => ({ active, maxPending, queued: queuedCount(), total: totalCount() }),
    whenIdle,
  };
}

function createBroker({ config, hub, getBaseUrl = () => `http://${config.host}:${config.port}` } = {}) {
  if (!config || !hub) {
    throw new TypeError('createBroker needs config and an SSE hub.');
  }

  const registry = createProjectRegistry({
    archiveAfterMs: config.projectArchiveAfterMs,
    profileDir: config.profileDir,
  });
  const profileStore = createProfileStore({ profilePath: config.profilePath });
  const ledger = createLedger({ profileDir: config.profileDir });
  const scheduler = createFairReportScheduler({
    maxPending: safeQueueCap(config),
    onError: (error) => log('broker report queue failed', error && error.stack ? error.stack : error),
  });
  let defaultProjectId = null;
  let defaultIdentity = null;
  let initialized = null;
  let closed = false;

  async function initialize() {
    if (initialized) {
      return initialized;
    }
    initialized = (async () => {
      await Promise.all([profileStore.load(), registry.load()]);
      defaultIdentity = await resolveProjectIdentity(config.cwd);
      const summary = await registry.ensureProject(defaultIdentity, { touch: true, unarchive: true });
      defaultProjectId = summary.project_id;
      await registry.archiveInactive({ exceptProjectId: defaultProjectId });
      // Do not call ensureChannel here: it correctly waits for initialize()
      // for external callers, which would make this first hydration await the
      // promise currently executing.
      await registry.hydrateProject(defaultProjectId, makeChannel);
      return summary;
    })();
    return initialized;
  }

  function baseUrl() {
    return getBaseUrl();
  }

  function publishProjects() {
    hub.broadcast('projects', { projects: registry.listProjects() });
  }

  function touch(projectId, state) {
    void registry
      .markActivity(projectId, { unansweredCount: unansweredCount(state.cards) })
      .then(publishProjects)
      .catch((error) => log('could not update project summary', error && error.message ? error.message : error));
  }

  function channelHub(projectId, state) {
    return {
      broadcast(type, payload) {
        const envelope = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? { ...payload, project_id: projectId }
          : { project_id: projectId, value: payload };
        // The project event is the v2 channel surface. Legacy event names
        // remain default-channel-only so an older wall cannot accidentally
        // merge cards from a background project.
        hub.broadcast(`project-${type}`, envelope);
        if (projectId === defaultProjectId) {
          hub.broadcast(type, payload);
        }
        if (['card', 'snapshot', 'status', 'strength'].includes(type)) {
          touch(projectId, state);
        }
      },
    };
  }

  async function makeChannel(summary) {
    const channelConfig = projectConfig(config, summary);
    const state = await loadProjectState(channelConfig, profileStore.strengths);
    const persistence = createPersistence(channelConfig, { profileStore });
    const localHub = channelHub(summary.project_id, state);
    const provider = createProvider(channelConfig);
    const replayService = await createReplayService({ config: channelConfig, persistence, state });
    const treeService = createTreeService({
      hub: localHub,
      persistence,
      projectId: summary.project_id,
      provider,
      state,
    });
    const curriculumService = createCurriculumService({
      config: channelConfig,
      hub: localHub,
      provider,
      state,
      treeService,
    });
    const cardService = createCardService({ state, hub: localHub, persistence });
    cardService.setRequeueDeliveryGate({
      afterDelivered: (card) => curriculumService.markDelivered(card.concept_id),
      beforeDelivery: curriculumService.beforeDelivery,
    });
    const channelLedger = {
      append(entry) {
        return ledger.append(summary.project_id, entry);
      },
    };
    const reportPipeline = createReportPipeline({
      cardService,
      config: channelConfig,
      curriculumService,
      hub: localHub,
      ledger: channelLedger,
      provider,
      replayService,
      state,
    });
    const answerService = createAnswerService({
      cardService,
      hub: localHub,
      persistence,
      profileStore,
      state,
    });
    await ledger.reconcileDangling(summary.project_id).catch((error) =>
      log('could not reconcile project activity', error && error.message ? error.message : error),
    );
    return {
      answer: answerService.answer,
      cardService,
      config: channelConfig,
      curriculumService,
      id: summary.project_id,
      ledger: channelLedger,
      provider,
      reportPipeline,
      replayService,
      state,
      treeService,
      close() {
        provider.close?.();
      },
    };
  }

  async function ensureChannel(projectId = defaultProjectId) {
    await initializeIfNeeded();
    const id = projectId || defaultProjectId;
    if (!id) {
      return null;
    }
    return registry.hydrateProject(id, makeChannel);
  }

  async function initializeIfNeeded() {
    if (!initialized) {
      await initialize();
    } else {
      await initialized;
    }
  }

  async function recordBrokerRefusal(projectId, report, reason) {
    await ledger.append(projectId, {
      event: 'accept',
      report_id: report.report_id,
      source: report.source === 'observed' ? 'observed' : 'agent',
      state: 'observed',
    });
    await ledger.append(projectId, {
      event: 'refusal',
      reason,
      report_id: report.report_id,
      source: report.source === 'observed' ? 'observed' : 'agent',
      state: 'waiting',
    });
  }

  async function submitReport(projectId, report) {
    const channel = await ensureChannel(projectId);
    if (!channel || closed) {
      return false;
    }
    const traced = {
      ...report,
      report_id: typeof report?.report_id === 'string' && report.report_id ? report.report_id : randomUUID(),
    };
    touch(channel.id, channel.state);
    const accepted = scheduler.enqueue(channel.id, {
      onDropped() {
        void recordBrokerRefusal(channel.id, traced, 'broker-queue-full');
        channelHub(channel.id, channel.state).broadcast('status', {
          state: 'queue-full',
          message: 'Osmosis is fairly sharing its lesson queue across projects.',
          provider: channel.provider.name,
        });
      },
      async run() {
        const result = channel.reportPipeline.enqueue(traced);
        if (!result.accepted) {
          return result.done;
        }
        return result.done;
      },
    });
    if (!accepted) {
      await recordBrokerRefusal(channel.id, traced, 'broker-queue-full');
      channelHub(channel.id, channel.state).broadcast('status', {
        state: 'queue-full',
        message: 'Osmosis is fairly sharing its lesson queue across projects.',
        provider: channel.provider.name,
      });
    }
    return accepted;
  }

  async function register(root) {
    await initializeIfNeeded();
    const identity = await resolveProjectIdentity(root);
    const registration = await registry.register(identity);
    publishProjects();
    return { project_id: registration.project_id, token: registration.token };
  }

  async function acceptRelayReport(projectId, token, report) {
    await initializeIfNeeded();
    // Old relays predate registration. Keep their no-query request pointed at
    // the default channel, but never infer another channel from untrusted raw
    // paths in a report request.
    if (!projectId) {
      return submitReport(defaultProjectId, { ...report, source: 'agent' });
    }
    if (!registry.getProject(projectId) || !registry.validateToken(projectId, token)) {
      return false;
    }
    return submitReport(projectId, { ...report, source: 'agent' });
  }

  async function acceptLocalReport(report, projectId = defaultProjectId) {
    await initializeIfNeeded();
    return submitReport(projectId, { ...report, source: report.source || 'agent' });
  }

  async function answer(projectId, value) {
    const channel = await ensureChannel(projectId);
    if (!channel) {
      const error = new Error('Unknown project.');
      error.statusCode = 404;
      throw error;
    }
    const result = await channel.answer(value);
    touch(channel.id, channel.state);
    return result;
  }

  async function inlineCardHtml(projectId) {
    const channel = await ensureChannel(projectId);
    if (!channel) {
      return null;
    }
    const encodedId = encodeURIComponent(channel.id);
    return renderInlineCard({
      answerUrl: `${baseUrl()}/answer?project=${encodedId}`,
      refreshUrl: `${baseUrl()}/inline-card?project=${encodedId}`,
      state: channel.state,
    });
  }

  async function projectSnapshot(projectId) {
    const channel = await ensureChannel(projectId);
    if (!channel) {
      return null;
    }
    const project = registry.getProject(channel.id);
    return {
      project,
      project_id: channel.id,
      ...snapshotFor(channel.state),
    };
  }

  async function initialEvents() {
    await initializeIfNeeded();
    const current = await projectSnapshot(defaultProjectId);
    const legacy = { cards: current.cards, strengths: current.strengths, tree: current.tree };
    const projects = registry.listProjects();
    return [
      { type: 'snapshot', payload: legacy },
      {
        type: 'snapshot-v2',
        payload: {
          active_project_id: defaultProjectId,
          channel: current,
          channels: { [defaultProjectId]: current },
          default_project_id: defaultProjectId,
          projects,
          strengths: profileStore.strengths,
          v: 2,
          version: 2,
        },
      },
    ];
  }

  async function listProjects() {
    await initializeIfNeeded();
    return registry.listProjects();
  }

  async function activity(projectId, limit) {
    await initializeIfNeeded();
    const id = projectId || defaultProjectId;
    if (!registry.getProject(id)) {
      return null;
    }
    return { entries: await ledger.list(id, { limit }), project_id: id };
  }

  async function archiveProject(projectId) {
    return setProjectArchived(projectId, true);
  }

  async function unarchiveProject(projectId) {
    return setProjectArchived(projectId, false);
  }

  async function setProjectArchived(projectId, archived) {
    await initializeIfNeeded();
    const project = await registry.setArchived(projectId, archived);
    if (project) {
      publishProjects();
    }
    return project;
  }

  async function recentReports(projectId) {
    const channel = await ensureChannel(projectId);
    return channel ? channel.reportPipeline.recentReports() : null;
  }

  async function resolveAmbientProject(cwd) {
    await initializeIfNeeded();
    const identity = await resolveProjectIdentity(cwd);
    const summary = registry.findByRoot(identity.root);
    return summary
      ? { project_id: summary.project_id, root: summary.root }
      : { registered: false, root: identity.root };
  }

  async function recordUnregisteredActivity(entry) {
    return ledger.append(undefined, entry);
  }

  async function reloadHydrated() {
    await initializeIfNeeded();
    for (const summary of registry.listProjects()) {
      const channel = registry.getHydratedProject(summary.project_id);
      if (!channel) {
        continue;
      }
      const refreshed = await loadProjectState(channel.config, profileStore.strengths);
      channel.state.cards = refreshed.cards;
      channel.state.tree = refreshed.tree;
    }
  }

  function health() {
    return {
      default_project_id: defaultProjectId,
      projects: registry.listProjects(),
    };
  }

  function close() {
    closed = true;
    scheduler.close();
    for (const summary of registry.listProjects()) {
      registry.getHydratedProject(summary.project_id)?.close?.();
    }
  }

  async function whenIdle() {
    await scheduler.whenIdle();
    for (const summary of registry.listProjects()) {
      await registry.getHydratedProject(summary.project_id)?.reportPipeline?.whenIdle?.();
    }
    await Promise.all([
      ledger.whenIdle?.(),
      profileStore.whenIdle?.(),
      registry.whenIdle?.(),
    ]);
  }

  return {
    acceptLocalReport,
    acceptRelayReport,
    activity,
    answer,
    archiveProject,
    close,
    ensureChannel,
    get defaultProjectId() {
      return defaultProjectId;
    },
    get profileStore() {
      return profileStore;
    },
    health,
    initialEvents,
    initialize,
    inlineCardHtml,
    listProjects,
    recentReports,
    recordUnregisteredActivity,
    register,
    registry,
    reloadHydrated,
    resolveAmbientProject,
    scheduler,
    projectSnapshot,
    unarchiveProject,
    whenIdle,
  };
}

module.exports = {
  createBroker,
  createFairReportScheduler,
  projectConfig,
};
