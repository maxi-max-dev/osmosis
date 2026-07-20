'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { createAnswerService } = require('./answer-service');
const { createCardService } = require('./card-service');
const { createConversationStore } = require('./conversation-store');
const { createCurriculumService, unansweredCount } = require('./curriculum-service');
const { createLedger } = require('./ledger');
const { renderInlineCard } = require('./inline-card');
const { log } = require('./log');
const { createProfileStore } = require('./profile-store');
const { migrateTreeConceptNamespace } = require('./project-concepts');
const { resolveProjectIdentity } = require('./project-identity');
const { createProjectRegistry } = require('./project-registry');
const { createProvider } = require('./provider');
const { createReportPipeline } = require('./report-pipeline');
const { createReplayService } = require('./replay');
const {
  CAPTURE_AGENT_REPORTS_ONLY,
  CAPTURE_EXPERIMENTAL_AMBIENT,
  createSettingsStore,
} = require('./settings-store');
const {
  cardForClient,
  createPersistence,
  loadProjectState,
  snapshotFor,
  studioReadyCard,
} = require('./state');
const { createStudioService } = require('./studio-service');
const { createTreeService } = require('./tree-service');
const { WARMUP_CATALOG, qualifyWarmupEvent } = require('./warmup-catalog');

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

async function hasPersistedProjectState(root) {
  const stateDir = path.join(root, '.osmosis');
  for (const name of ['cards.json', 'replay.json', 'tree.json']) {
    try {
      await fs.access(path.join(stateDir, name));
      return true;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return false;
}

const DEFAULT_ARCHIVE_SWEEP_MS = 60 * 60 * 1_000;

/**
 * A bounded fair scheduler shared by all hydrated channels. One channel gets
 * at most one active generation at a time; available slots rotate through
 * project buckets, so a busy rollout cannot consume every slot before a
 * quieter project reaches its first lesson.
 */
function createFairReportScheduler({ maxPending = 5, onError = () => {}, onSlotAvailable = () => {} } = {}) {
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
          // A Studio signal can be durable but intentionally outside this
          // bounded scheduler while the global queue is full. Let the broker
          // offer the newly freed slot back to those channels; each channel
          // still owns its one-in-flight and one-ready watermark.
          try {
            onSlotAvailable();
          } catch (error) {
            onError(error);
          }
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

function createBroker({
  config,
  hub,
  getBaseUrl = () => `http://${config.host}:${config.port}`,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  archiveSweepMs = config?.projectArchiveSweepMs,
  now,
  settingsStore = null,
  warmupCatalog = WARMUP_CATALOG,
} = {}) {
  if (!config || !hub) {
    throw new TypeError('createBroker needs config and an SSE hub.');
  }

  const registry = createProjectRegistry({
    archiveAfterMs: config.projectArchiveAfterMs,
    profileDir: config.profileDir,
    ...(typeof now === 'function' ? { now } : {}),
  });
  const profileStore = createProfileStore({ profilePath: config.profilePath });
  const settings = settingsStore || createSettingsStore({
    profileDir: config.profileDir,
    settingsPath: config.settingsPath,
  });
  const ledger = createLedger({ profileDir: config.profileDir });
  const conversationStore = createConversationStore({ profileDir: config.profileDir });
  let wakeStudioChannels = () => {};
  const scheduler = createFairReportScheduler({
    maxPending: safeQueueCap(config),
    onError: (error) => log('broker report queue failed', error && error.stack ? error.stack : error),
    onSlotAvailable: () => wakeStudioChannels(),
  });
  let defaultProjectId = null;
  let defaultIdentity = null;
  const knownIdentities = new Map();
  // A relay needs an opaque capability even before someone has chosen Carry.
  // These ephemeral tokens route its reports only into the activation-pending
  // queue; they never create a registry entry or a project-state write.
  const pendingRelayTokens = new Map();
  let initialized = null;
  let closed = false;
  let archiveSweepTimer = null;
  let archiveSweepInFlight = null;
  let studioWakeScheduled = false;
  let ownerStarted = false;
  let ownerEpoch = 0;
  // Startup migrations can make a small, user-relevant preservation decision.
  // Keep that as runtime UI data rather than polluting the durable project
  // contract; a restarted browser can still see it during this owner epoch.
  const startupNotices = [];
  const safeArchiveSweepMs = Number.isInteger(archiveSweepMs) && archiveSweepMs > 0
    ? archiveSweepMs
    : DEFAULT_ARCHIVE_SWEEP_MS;

  function rememberIdentity(identity) {
    if (identity?.project_id && identity?.root) {
      knownIdentities.set(identity.project_id, identity);
    }
    return identity;
  }

  function identityFor(projectId) {
    if (projectId === defaultProjectId && defaultIdentity) {
      return defaultIdentity;
    }
    if (knownIdentities.has(projectId)) {
      return knownIdentities.get(projectId);
    }
    const existing = registry.getProject(projectId);
    if (!existing) {
      return null;
    }
    return rememberIdentity({
      name: existing.name,
      project_id: existing.project_id,
      root: existing.root,
    });
  }

  function activationFor(projectId = defaultProjectId) {
    if (!projectId) {
      return null;
    }
    return settings.activationFor(projectId);
  }

  function projectIsCarried(projectId = defaultProjectId) {
    return activationFor(projectId)?.carry === true;
  }

  function learningIsPaused() {
    return settings.isPaused();
  }

  async function publicReportWithConversation(report) {
    const input = report && typeof report === 'object' ? report : {};
    const local = input.__osmosis_local_conversation;
    const publicReport = { ...input };
    delete publicReport.__osmosis_local_conversation;
    if (!local || typeof local !== 'object' || typeof local.session_id !== 'string') {
      return publicReport;
    }
    try {
      const conversationId = await conversationStore.observe({
        enabled: settings.snapshot().local_conversation_titles === true,
        sessionId: local.session_id,
        title: local.title,
      });
      return conversationId ? { ...publicReport, conversation_id: conversationId } : publicReport;
    } catch (error) {
      // Conversation context is optional presentation data. A local storage
      // problem must never block Ambient capture or expose its raw payload.
      log('could not store a local conversation title', error && error.message ? error.message : error);
      return publicReport;
    }
  }

  function requestStudioWake() {
    // A passive broker may hydrate a document for inspection or a direct
    // library caller, but only the HTTP-owning lifecycle may resume durable
    // provider work. Server relays never construct a broker at all; this
    // guard keeps the invariant true if that boundary is reused elsewhere.
    if (closed || !ownerStarted || studioWakeScheduled) {
      return;
    }
    studioWakeScheduled = true;
    queueMicrotask(() => {
      studioWakeScheduled = false;
      if (closed || learningIsPaused()) {
        return;
      }
      for (const summary of registry.listProjects()) {
        const channel = registry.getHydratedProject(summary.project_id);
        if (!channel?.studio) {
          continue;
        }
        void channel.studio.pump().catch((error) =>
          log('could not resume a Studio candidate', error && error.message ? error.message : error),
        );
      }
    });
  }

  wakeStudioChannels = requestStudioWake;

  function pendingTokenFor(projectId) {
    const token = randomUUID();
    const tokens = pendingRelayTokens.get(projectId) || new Set();
    tokens.add(token);
    pendingRelayTokens.set(projectId, tokens);
    return token;
  }

  function validatesPendingToken(projectId, token) {
    return typeof token === 'string' && Boolean(pendingRelayTokens.get(projectId)?.has(token));
  }

  function recordStartupNotice(projectId, message, code = 'ambient-watch-preserved') {
    if (!projectId || startupNotices.some((notice) => notice.code === code && notice.project_id === projectId)) {
      return;
    }
    startupNotices.push({ code, message, project_id: projectId });
  }

  function startupNoticesSnapshot() {
    return startupNotices.map((notice) => ({ ...notice }));
  }

  /**
   * Pre-Studio state means a learner had already elected to carry the project.
   * If this machine is explicitly Ambient-enabled, preserve that effective
   * capture behavior instead of silently forcing old projects to reports-only.
   * The settings store remembers this migration so a later deliberate choice
   * of reports-only remains a deliberate choice.
   */
  async function migrateLegacyProjectPreference(projectId) {
    const preference = activationFor(projectId);
    if (preference?.state === 'activation-pending') {
      await settings.setProject(projectId, {
        carry: true,
        capture_mode: config.ambientEnabled
          ? CAPTURE_EXPERIMENTAL_AMBIENT
          : CAPTURE_AGENT_REPORTS_ONLY,
      });
    }
    if (!config.ambientEnabled) {
      return;
    }
    const migration = await settings.preserveAmbientForLegacyProject(projectId);
    if (migration.migrated) {
      recordStartupNotice(projectId, 'Ambient Watch preserved — review settings');
    }
  }

  async function initialize() {
    if (initialized) {
      return initialized;
    }
    initialized = (async () => {
      await Promise.all([profileStore.load(), registry.load(), settings.load()]);
      defaultIdentity = rememberIdentity(await resolveProjectIdentity(config.cwd));
      defaultProjectId = defaultIdentity.project_id;
      // Pre-Studio registry entries are already explicit durable user state.
      // Migrate *every* one of them into Carry before emitting summaries; a
      // background project must never turn into an activation-pending tab
      // merely because the browser broker was upgraded first.
      for (const legacyProject of registry.listProjects()) {
        rememberIdentity({
          name: legacyProject.name,
          project_id: legacyProject.project_id,
          root: legacyProject.root,
        });
        await migrateLegacyProjectPreference(legacyProject.project_id);
      }
      // A pre-registry local state directory is likewise an explicit durable
      // choice. Brand-new projects with no registry/state stay undecided.
      const legacySummary = registry.findByRoot(defaultIdentity.root);
      const legacyState = await hasPersistedProjectState(defaultIdentity.root);
      if (legacySummary || legacyState) {
        await migrateLegacyProjectPreference(defaultProjectId);
      }
      let summary = null;
      if (projectIsCarried(defaultProjectId)) {
        summary = await registry.ensureProject(defaultIdentity, { touch: true, unarchive: true });
        defaultProjectId = summary.project_id;
      }
      await archiveInactiveProjects();
      // Do not call ensureChannel here: it correctly waits for initialize()
      // for external callers, which would make this first hydration await the
      // promise currently executing.
      if (summary) {
        await registry.hydrateProject(defaultProjectId, makeChannel);
      }
      startArchiveSweep();
      return summary || activationFor(defaultProjectId);
    })();
    return initialized;
  }

  function baseUrl() {
    return getBaseUrl();
  }

  function publishProjects() {
    hub.broadcast('projects', { projects: registry.listProjects() });
  }

  async function archiveInactiveProjects() {
    if (closed || !defaultProjectId) {
      return [];
    }
    if (archiveSweepInFlight) {
      return archiveSweepInFlight;
    }

    const work = (async () => {
      try {
        const archived = await registry.archiveInactive({ exceptProjectId: defaultProjectId });
        if (archived.length > 0) {
          publishProjects();
        }
        return archived;
      } catch (error) {
        log('could not archive inactive project channels', error && error.message ? error.message : error);
        return [];
      }
    })();
    archiveSweepInFlight = work;
    try {
      return await work;
    } finally {
      if (archiveSweepInFlight === work) {
        archiveSweepInFlight = null;
      }
    }
  }

  function startArchiveSweep() {
    if (closed || archiveSweepTimer || typeof setIntervalFn !== 'function') {
      return;
    }
    archiveSweepTimer = setIntervalFn(() => archiveInactiveProjects(), safeArchiveSweepMs);
    archiveSweepTimer?.unref?.();
  }

  function touch(projectId, state) {
    void registry
      .markActivity(projectId, { unansweredCount: unansweredCount(state.cards, state.studio) })
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
        if (['card', 'snapshot', 'status', 'strength', 'studio'].includes(type)) {
          touch(projectId, state);
        }
      },
    };
  }

  async function makeChannel(summary) {
    const channelConfig = projectConfig(config, summary);
    const state = await loadProjectState(channelConfig, profileStore.strengths);
    const persistence = createPersistence(channelConfig, { profileStore });
    if (state.studio_migrated) {
      // Persist the one-buffer migration before provider work resumes. An old
      // ready_card_id document must not survive long enough to be observed by
      // a second owner during a local relay takeover.
      await persistence.saveCards(state.cards, state.studio);
      delete state.studio_migrated;
    }
    const treeMigration = migrateTreeConceptNamespace(summary.project_id, state.tree);
    if (treeMigration.migrated) {
      state.tree = treeMigration.tree;
      // A hydration migration must be durable before the provider sees the
      // selectable leaves; otherwise a restart could generate more unsalted
      // cards from the same legacy tree.
      await persistence.saveTree(state.tree);
    }
    const localHub = channelHub(summary.project_id, state);
    const provider = createProvider(channelConfig);
    const replayService = await createReplayService({ config: channelConfig, persistence, state });
    const treeService = createTreeService({
      canCommit: () => !closed,
      hub: localHub,
      persistence,
      projectId: summary.project_id,
      provider,
      state,
    });
    const curriculumService = createCurriculumService({
      canCommit: () => !closed,
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
      appendIdempotent(entry) {
        return ledger.appendIdempotent(summary.project_id, entry);
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
    let studio = null;
    if (channelConfig.mode === 'live') {
      // The fair scheduler is deliberately wrapped around provider work, not
      // around signal intake. Signals first become durable bounded Studio
      // candidates; only one candidate per channel can ask the broker for a
      // generation slot at a time.
      const runStudioGeneration = (report, candidate = null) => new Promise((resolve) => {
        let settled = false;
        // A broker is constructed only by the HTTP owner in production. Keep
        // the fence tied to its irreversible close rather than
        // `ownerStarted`, so focused hydration/recovery callers can exercise
        // a channel before invoking the lifecycle helper without creating a
        // second writer in the server path.
        const canRun = () => !closed;
        const settle = (result) => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        };
        if (!canRun() || learningIsPaused()) {
          settle({ reason: !canRun() ? 'broker-closed' : 'learning-paused', state: 'waiting' });
          return;
        }
        const accepted = scheduler.enqueue(summary.project_id, {
          onDropped() {
            settle({ reason: 'broker-queue-full', state: 'waiting' });
          },
          async run() {
            if (!canRun() || learningIsPaused()) {
              const paused = { reason: !canRun() ? 'broker-closed' : 'learning-paused', state: 'waiting' };
              settle(paused);
              return paused;
            }
            localHub.broadcast('status', {
              state: 'generating',
              message: provider.isSlow ? 'Generating (this provider is slower).' : 'Osmosis is preparing a lesson.',
              provider: provider.name,
              report,
            });
            const result = await reportPipeline.generateForStudio(report, {
              canCommit: canRun,
              // The warmup owner transition is the sole author of this
              // candidate field. Keeping it on the candidate (rather than
              // in the report schema) lets an owner restart retain the exact
              // canonical target for its same-epoch true follow-up.
              targetConceptId: candidate?.warmup_target_concept_id || null,
            });
            settle(result);
            return result;
          },
        });
        if (!accepted) {
          settle({ reason: 'broker-queue-full', state: 'waiting' });
        }
      });

      studio = createStudioService({
        canCommit: () => !closed,
        generate: runStudioGeneration,
        hub: localHub,
        ledger: channelLedger,
        persistCard: async (card, placement) => {
          if (learningIsPaused()) {
            return false;
          }
          if (placement === 'ready') {
            return true;
          }
          const decision = await curriculumService.beforeDelivery(card);
          if (!decision?.deliver) {
            localHub.broadcast('status', {
              state: decision?.state || 'waiting',
              message: decision?.message || 'Osmosis is waiting before the next lesson.',
              provider: provider.name,
            });
            return false;
          }
          return true;
        },
        afterDelivery: async (card, placement) => {
          if (placement === 'current' || placement === 'replace-warmup') {
            await curriculumService.markDelivered(card.concept_id);
          }
        },
        persistence,
        state,
        warmupCatalog,
      });
      reportPipeline.setStudio(studio);
    }
    const answerService = createAnswerService({
      cardService,
      hub: localHub,
      persistence,
      profileStore,
      state,
      studio,
    });
    return {
      answer: answerService.answer,
      cardService,
      config: channelConfig,
      curriculumService,
      id: summary.project_id,
      ledger: channelLedger,
      provider,
      persistence,
      reportPipeline,
      replayService,
      state,
      studio,
      treeService,
      close() {
        provider.close?.();
      },
    };
  }

  async function ensureChannel(projectId = defaultProjectId) {
    await initializeIfNeeded();
    const id = projectId || defaultProjectId;
    if (!id || !projectIsCarried(id)) {
      return null;
    }
    const identity = identityFor(id);
    if (identity && !registry.getProject(id)) {
      await registry.ensureProject(identity, { touch: true, unarchive: true });
      publishProjects();
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

  function durableStudioTrace(state) {
    const reportIds = new Set();
    const cardIds = new Set();
    const studio = state?.studio || {};
    const candidates = [
      ...(Array.isArray(studio.candidates) ? studio.candidates : []),
      ...(studio.generation?.candidate ? [studio.generation.candidate] : []),
      ...(studio.deferred_epoch_candidate ? [studio.deferred_epoch_candidate] : []),
    ];
    for (const candidate of candidates) {
      for (const reportId of candidate?.report_ids || []) {
        if (typeof reportId === 'string' && reportId) reportIds.add(reportId);
      }
      if (typeof candidate?.report?.report_id === 'string' && candidate.report.report_id) {
        reportIds.add(candidate.report.report_id);
      }
    }
    const current = typeof studio.current_card_id === 'string'
      ? state?.cards?.find((card) => card?.card_id === studio.current_card_id) || null
      : null;
    const ready = studioReadyCard(studio, state?.cards || []);
    for (const card of [current, ready]) {
      if (!card) continue;
      if (typeof card.card_id === 'string' && card.card_id) cardIds.add(card.card_id);
      if (typeof card.source?.report_id === 'string' && card.source.report_id) reportIds.add(card.source.report_id);
    }
    const warmup = studio.now?.kind === 'warmup' ? studio.current_warmup : null;
    for (const warmupEntry of [warmup, ...(Array.isArray(studio.warmup_history) ? studio.warmup_history : [])]) {
      if (typeof warmupEntry?.observation_id === 'string' && warmupEntry.observation_id) {
        reportIds.add(`observed-${warmupEntry.observation_id}`);
      }
    }
    for (const outbox of studio.ledger_outbox || []) {
      const entry = outbox?.entry || {};
      if (typeof entry.report_id === 'string' && entry.report_id) reportIds.add(entry.report_id);
      if (typeof entry.card_id === 'string' && entry.card_id) cardIds.add(entry.card_id);
    }
    return { cardIds: [...cardIds], reportIds: [...reportIds] };
  }

  async function flushPersistedStudioOutbox(summary) {
    const channel = registry.getHydratedProject(summary.project_id);
    if (channel?.studio?.flushLedgerOutbox) {
      const result = await channel.studio.flushLedgerOutbox();
      if (!result.ok) {
        throw new Error('studio ledger outbox remains pending');
      }
      return channel.state;
    }
    const channelConfig = projectConfig(config, summary);
    const state = await loadProjectState(channelConfig, profileStore.strengths);
    const pending = [...(state.studio?.ledger_outbox || [])];
    for (const item of pending) {
      await ledger.appendIdempotent(summary.project_id, {
        ...item.entry,
        outbox_id: item.outbox_id,
      });
    }
    if (pending.length > 0) {
      state.studio.ledger_outbox = [];
      const persistence = createPersistence(channelConfig, { profileStore });
      await persistence.saveCards(state.cards, state.studio);
    }
    return state;
  }

  async function reconcileOwnerStartup() {
    const summaries = registry.listProjects().filter((summary) => projectIsCarried(summary.project_id));
    for (const summary of summaries) {
      try {
        const state = await flushPersistedStudioOutbox(summary);
        const trace = durableStudioTrace(state);
        await ledger.reconcileDangling(summary.project_id, {
          retainCardIds: trace.cardIds,
          retainReportIds: trace.reportIds,
        });
      } catch (error) {
        log('could not reconcile project activity during exclusive owner startup', error && error.message ? error.message : error);
      }
    }
  }

  /**
   * The server calls this only after it has acquired the HTTP port. Keeping
   * resume/reconciliation out of channel hydration prevents thin MCP relays
   * from becoming accidental writers or provider runners.
   */
  async function startOwner() {
    await initializeIfNeeded();
    if (ownerStarted) {
      return;
    }
    ownerStarted = true;
    ownerEpoch += 1;
    await reconcileOwnerStartup();
    requestStudioWake();
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

  async function recordUncarriedReport(projectId, report, { reason, state = 'waiting' } = {}) {
    const source = report.source === 'observed' ? 'observed' : 'agent';
    // The unregistered ledger is intentionally the only durable trace for an
    // uncarried project. Do not resolve/hydrate a channel just to explain why
    // nothing appeared: that would itself violate carry-before-state.
    await ledger.append(undefined, {
      event: 'refusal',
      report_id: report.report_id,
      reason,
      source,
      state,
    });
    hub.broadcast('activation', {
      project_id: projectId,
      reason,
      state,
    });
  }

  async function holdActivationPending(projectId, report) {
    await settings.holdActivationReport(projectId, report);
    await recordUncarriedReport(projectId, report, { reason: 'activation-pending', state: 'waiting' });
  }

  async function submitReport(projectId, report) {
    await initializeIfNeeded();
    if (closed) {
      return false;
    }
    const traced = {
      ...(await publicReportWithConversation(report)),
      report_id: typeof report?.report_id === 'string' && report.report_id ? report.report_id : randomUUID(),
    };
    const id = projectId || defaultProjectId;
    // Pausing is a hard capture boundary. In particular, an undecided
    // project's reports must not accumulate in activation-pending while the
    // learner has explicitly paused all new learning work.
    if (learningIsPaused()) {
      const channel = projectIsCarried(id) ? await ensureChannel(id) : null;
      const targetHub = channel ? channelHub(channel.id, channel.state) : hub;
      targetHub.broadcast('status', {
        state: 'paused',
        message: 'Learning is paused. Your lesson history is still here.',
        ...(channel ? { provider: channel.provider.name } : {}),
      });
      return true;
    }
    const activation = activationFor(id);
    if (!activation || activation.carry !== true) {
      if (activation?.state === 'activation-pending' && traced.source !== 'observed') {
        await holdActivationPending(id, traced);
      } else {
        await recordUncarriedReport(id, traced, {
          reason: activation?.state === 'uncarried' ? 'project-not-carried' : 'unregistered-project',
          state: 'suppressed',
        });
      }
      return true;
    }
    const channel = await ensureChannel(id);
    if (!channel) {
      return false;
    }
    touch(channel.id, channel.state);
    if (channel.studio) {
      // ReportPipeline keeps the bounded debug/replay trace while delegating
      // the live delivery state machine to Studio.
      const result = channel.reportPipeline.enqueue(traced);
      if (!result.accepted) {
        await recordBrokerRefusal(channel.id, traced, 'studio-candidate-rejected');
        channelHub(channel.id, channel.state).broadcast('status', {
          state: 'queue-full',
          message: 'Osmosis is holding the current learning signal.',
          provider: channel.provider.name,
        });
      }
      return result.accepted;
    }
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
    const identity = rememberIdentity(await resolveProjectIdentity(root));
    const preference = activationFor(identity.project_id);
    if (preference?.carry === true) {
      const registration = await registry.register(identity);
      publishProjects();
      return { project_id: registration.project_id, token: registration.token };
    }
    // Registration is an identity handshake, not an implicit permission to
    // create learning state. The relay still receives an opaque token so its
    // explicit reports can be held and later released after Carry.
    const pending = {
      activation_pending: preference?.state === 'activation-pending',
      project_id: identity.project_id,
      token: pendingTokenFor(identity.project_id),
    };
    hub.broadcast('activation', activation(identity.project_id));
    return pending;
  }

  async function acceptRelayReport(projectId, token, report) {
    await initializeIfNeeded();
    // Old relays predate registration. Keep their no-query request pointed at
    // the default channel, but never infer another channel from untrusted raw
    // paths in a report request.
    if (!projectId) {
      return submitReport(defaultProjectId, { ...report, source: 'agent' });
    }
    const registered = registry.getProject(projectId) && registry.validateToken(projectId, token);
    if (!registered && !validatesPendingToken(projectId, token)) {
      return false;
    }
    return submitReport(projectId, { ...report, source: 'agent' });
  }

  async function acceptLocalReport(report, projectId = defaultProjectId) {
    await initializeIfNeeded();
    return submitReport(projectId, { ...report, source: report.source || 'agent' });
  }

  function warmupLedgerEntry(observation, reason, state = 'suppressed') {
    return {
      // A warmup epoch is exactly one qualifying observation, never a caller
      // supplied grouping id. Keeping this fixed also makes takeover replay
      // and the same-epoch replacement proof unambiguous.
      activity_epoch_id: observation?.observation_id,
      event: 'warmup_suppressed',
      observation_id: observation?.observation_id,
      reason,
      source: 'observed',
      state,
    };
  }

  function masteredConceptIds(strengths) {
    return Object.entries(strengths || {})
      .filter(([, entry]) => Number(entry?.strength) >= 2)
      .map(([conceptId]) => conceptId);
  }

  /**
   * Owner-only Ambient fast path. It never invokes a generator itself: the
   * Studio transition persistently installs a warmup and the same-epoch real
   * generation candidate, then its normal fair scheduler decides when that
   * candidate can run.
   */
  async function acceptWarmupCandidate(projectId, observation) {
    if (!ownerStarted || closed) {
      return { handled: false, reason: 'not-owner' };
    }
    const expectedOwnerEpoch = ownerEpoch;
    const ownsWriterEpoch = () => !closed && ownerStarted && ownerEpoch === expectedOwnerEpoch;
    // A thin relay must be able to call this defensively without causing an
    // initialization, migration, hydration, provider run, or state write.
    // Only startOwner() establishes the exclusive writer before this point.
    await initializeIfNeeded();
    if (!ownsWriterEpoch()) {
      return { handled: false, reason: 'not-owner' };
    }
    // The Ambient watcher owns the canonical cwd → project resolution. Never
    // let a caller steer an observed event into a different channel by
    // supplying a competing id; this path is a project-isolation boundary.
    const routedProjectId = observation?.route?.registered === true
      && typeof observation.route.project_id === 'string'
      && observation.route.project_id
      ? observation.route.project_id
      : null;
    if (!routedProjectId) {
      const rawReason = observation?.route?.reason;
      const reason = rawReason === 'learning-paused'
        ? 'learning-paused'
        : rawReason === 'project-not-carried'
          ? 'project-uncarried'
          : 'project-unregistered';
      if (!ownsWriterEpoch()) return { handled: false, reason: 'not-owner' };
      await ledger.append(undefined, warmupLedgerEntry(observation, reason));
      return { handled: true, reason };
    }
    if (routedProjectId && projectId && projectId !== routedProjectId) {
      if (!ownsWriterEpoch()) return { handled: false, reason: 'not-owner' };
      await ledger.append(undefined, warmupLedgerEntry(observation, 'project-route-mismatch'));
      return { handled: true, reason: 'project-route-mismatch' };
    }
    const id = routedProjectId;
    const observationId = typeof observation?.observation_id === 'string' ? observation.observation_id : '';
    const epochId = observationId;
    const rolloutIdentity = typeof observation?.rollout_identity === 'string'
      ? observation.rollout_identity.slice(0, 160)
      : '';
    if (!observationId || !epochId || !rolloutIdentity) {
      return { handled: false, reason: 'invalid-observation' };
    }
    if (learningIsPaused()) {
      if (!ownsWriterEpoch()) return { handled: false, reason: 'not-owner' };
      await ledger.append(projectIsCarried(id) ? id : undefined, warmupLedgerEntry(observation, 'learning-paused'));
      return { handled: true, reason: 'learning-paused' };
    }
    const activation = activationFor(id);
    if (!activation) {
      if (!ownsWriterEpoch()) return { handled: false, reason: 'not-owner' };
      await ledger.append(undefined, warmupLedgerEntry(observation, 'project-unregistered'));
      return { handled: true, reason: 'project-unregistered' };
    }
    if (activation.carry !== true) {
      if (!ownsWriterEpoch()) return { handled: false, reason: 'not-owner' };
      await ledger.append(undefined, warmupLedgerEntry(observation, activation.state === 'uncarried' ? 'project-uncarried' : 'project-unregistered'));
      return { handled: true, reason: activation.state === 'uncarried' ? 'project-uncarried' : 'project-unregistered' };
    }
    const channel = await ensureChannel(id);
    if (!ownsWriterEpoch()) {
      return { handled: false, reason: 'not-owner' };
    }
    if (!channel?.studio) {
      return { handled: false, reason: 'studio-unavailable' };
    }
    const report = {
      ...(await publicReportWithConversation(
        observation?.report && typeof observation.report === 'object' ? observation.report : {},
      )),
      activity_epoch_id: epochId,
      report_id: typeof observation?.report?.report_id === 'string'
        ? observation.report.report_id
        : `observed-${observationId}`,
      source: 'observed',
    };
    const qualification = qualifyWarmupEvent({
      activity_epoch_id: epochId,
      catalog: warmupCatalog,
      event: observation?.event,
      masteredConceptIds: masteredConceptIds(channel.state.strengths),
      observation_id: observationId,
      // Now/Next are decided inside the Studio's owner transition queue so a
      // simultaneously answered/replaced lesson cannot race this snapshot.
      nowKind: null,
      nextReady: false,
      warmup_id: `warmup-${observationId}`.slice(0, 128),
    });
    if (!qualification.qualified) {
      if (qualification.reason === 'trigger-not-allowlisted') {
        // Keep the ordinary 45-second aggregation path, but make the
        // fast-path decision visible in the activity drawer as well.
        await channel.studio.recordWarmupSuppression({
          activity_epoch_id: epochId,
          observation_id: observationId,
          reason: qualification.reason,
        });
        if (!ownsWriterEpoch()) {
          return { handled: false, reason: 'not-owner' };
        }
        return { handled: false, reason: qualification.reason };
      }
      await channel.studio.recordWarmupSuppression({
        activity_epoch_id: epochId,
        concept_id: qualification.concept_id || '',
        observation_id: observationId,
        reason: qualification.reason,
      });
      if (!ownsWriterEpoch()) {
        return { handled: false, reason: 'not-owner' };
      }
      return { handled: true, reason: qualification.reason };
    }
    const dedupeKey = `${channel.id}:${rolloutIdentity}:${qualification.concept_id}`;
    const result = await channel.studio.onWarmupCandidate({
      activity_epoch_id: epochId,
      concept_id: qualification.concept_id,
      dedupe_key: dedupeKey,
      observation_id: observationId,
      report,
      warmup: qualification.candidate,
    });
    if (!ownsWriterEpoch()) {
      return { handled: false, reason: 'not-owner' };
    }
    // A structured event can deterministically match more than one fixed
    // catalog trigger (for example `npm run lint`). Serve only the first
    // catalog concept for this epoch and expose every skipped sibling rather
    // than silently treating it as a second lesson opportunity.
    for (const extra of qualification.matches.slice(1)) {
      await channel.studio.recordWarmupSuppression({
        activity_epoch_id: epochId,
        concept_id: extra.concept?.concept_id || '',
        observation_id: observationId,
        reason: 'rate-limited',
      });
      if (!ownsWriterEpoch()) {
        return { handled: false, reason: 'not-owner' };
      }
    }
    // The Studio transition above deliberately does not run a provider: it
    // only persists the fixed Chinese warmup and paired source candidate.
    // Wake the normal owner scheduler after that durable boundary so Codex
    // generation, if configured, remains outside the hot catalog path.
    if (result.should_wake && ownsWriterEpoch()) {
      requestStudioWake();
    }
    touch(channel.id, channel.state);
    return { handled: true, ...result };
  }

  function activation(projectId = defaultProjectId) {
    const preference = activationFor(projectId);
    const identity = identityFor(projectId);
    if (!preference) {
      return null;
    }
    return {
      ...preference,
      global_learning: settings.snapshot().global_learning,
      name: identity?.name || registry.getProject(projectId)?.name || 'project',
      pending_report_count: settings.pendingActivationReports(projectId).length,
    };
  }

  function activations() {
    const ids = new Set([
      ...knownIdentities.keys(),
      ...registry.listProjects().map((project) => project.project_id),
    ]);
    if (defaultProjectId) {
      ids.add(defaultProjectId);
    }
    return [...ids]
      .map((projectId) => activation(projectId))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name) || left.project_id.localeCompare(right.project_id));
  }

  async function getSettings() {
    await initializeIfNeeded();
    return {
      ...settings.snapshot(),
      activation: activation(defaultProjectId),
      activations: activations(),
      notices: startupNoticesSnapshot(),
    };
  }

  async function updateSettings(patch) {
    await initializeIfNeeded();
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('Settings updates need an object.');
    }
    const keys = Object.keys(patch);
    if (keys.some((key) => !['global_learning', 'lesson_locale', 'ui_locale', 'mascot_enabled', 'local_conversation_titles'].includes(key))) {
      throw new TypeError('Only supported global Studio preferences can be changed here.');
    }
    const wasPaused = learningIsPaused();
    if (Object.hasOwn(patch, 'global_learning')) {
      await settings.setGlobalLearning(patch.global_learning);
    }
    if (Object.hasOwn(patch, 'lesson_locale')) {
      await settings.setLessonLocale(patch.lesson_locale);
    }
    if (Object.hasOwn(patch, 'ui_locale')) {
      await settings.setUiLocale(patch.ui_locale);
    }
    if (Object.hasOwn(patch, 'mascot_enabled')) {
      await settings.setMascotEnabled(patch.mascot_enabled);
    }
    if (Object.hasOwn(patch, 'local_conversation_titles')) {
      await settings.setLocalConversationTitles(patch.local_conversation_titles);
      if (patch.local_conversation_titles === false) {
        await conversationStore.clear();
      }
    }
    const result = await getSettings();
    hub.broadcast('settings', result);
    if (wasPaused && !learningIsPaused()) {
      requestStudioWake();
    }
    return result;
  }

  async function activateProject(projectId, payload) {
    await initializeIfNeeded();
    const identity = identityFor(projectId);
    if (!identity) {
      const error = new Error('Unknown activation project.');
      error.statusCode = 404;
      throw error;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('Activation needs carry, capture_mode, and lesson_locale.');
    }
    const keys = Object.keys(payload);
    if (keys.some((key) => !['carry', 'capture_mode', 'lesson_locale', 'auto_advance'].includes(key))) {
      throw new TypeError('Activation contains unsupported fields.');
    }
    if (
      typeof payload.carry !== 'boolean'
      || typeof payload.capture_mode !== 'string'
      || typeof payload.lesson_locale !== 'string'
      || (Object.hasOwn(payload, 'auto_advance') && typeof payload.auto_advance !== 'boolean')
    ) {
      throw new TypeError('Activation needs boolean carry, capture_mode, and lesson_locale.');
    }
    await settings.setLessonLocale(payload.lesson_locale);
    await settings.setProject(projectId, {
      ...(typeof payload.auto_advance === 'boolean' ? { auto_advance: payload.auto_advance } : {}),
      carry: payload.carry,
      capture_mode: payload.capture_mode,
    });
    // From this point forward the capture setting is a learner action, never
    // a legacy default eligible for the owner-startup preservation migration.
    await settings.markCaptureReviewed(projectId);

    if (!payload.carry) {
      // A deliberate No clears raw queued agent messages while retaining the
      // honest activation-pending ledger entries in the user-level trace.
      await settings.takePendingActivationReports(projectId);
      const result = activation(projectId);
      hub.broadcast('activation', result);
      hub.broadcast('settings', await getSettings());
      return { activation: result, released: 0 };
    }

    await registry.ensureProject(identity, { touch: true, unarchive: true });
    publishProjects();
    const pendingReports = await settings.takePendingActivationReports(projectId);
    // Carry creates the canonical registry summary, but a quiet project stays
    // lazy until it has pending work, a user opens it, or a relay sends a
    // report. This keeps N project tabs cheap in a long-running broker.
    const channel = pendingReports.length > 0 ? await ensureChannel(projectId) : null;
    const releases = [];
    // Re-submit only after the state-changing Carry decision is durable. Each
    // report retains its frozen three-key payload plus its trace id, and the
    // Studio coordinator is free to coalesce it into its bounded candidates.
    for (const pending of pendingReports) {
      releases.push(await submitReport(projectId, { ...pending, source: 'agent' }));
    }
    const result = activation(projectId);
    hub.broadcast('activation', result);
    hub.broadcast('settings', await getSettings());
    return {
      activation: result,
      project: registry.getProject(projectId),
      released: releases.filter(Boolean).length,
      ...(channel ? { project_id: channel.id } : {}),
    };
  }

  async function updateProjectSettings(projectId, patch) {
    await initializeIfNeeded();
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('Project settings need carry and capture_mode.');
    }
    const keys = Object.keys(patch);
    if (keys.some((key) => !['carry', 'capture_mode', 'auto_advance'].includes(key))) {
      throw new TypeError('Project settings contain unsupported fields.');
    }
    return activateProject(projectId, {
      carry: Object.hasOwn(patch, 'carry') ? patch.carry : activationFor(projectId)?.carry,
      capture_mode: Object.hasOwn(patch, 'capture_mode') ? patch.capture_mode : activationFor(projectId)?.capture_mode,
      lesson_locale: settings.snapshot().lesson_locale,
      ...(Object.hasOwn(patch, 'auto_advance') ? { auto_advance: patch.auto_advance } : {}),
    });
  }

  async function answer(projectId, value) {
    const channel = await ensureChannel(projectId);
    if (!channel) {
      const error = new Error('Unknown project.');
      error.statusCode = 404;
      throw error;
    }
    channel.studio?.noteInteraction?.();
    const result = await channel.answer(value);
    touch(channel.id, channel.state);
    return result;
  }

  async function nextLesson(projectId, options = {}) {
    const channel = await ensureChannel(projectId);
    if (!channel) {
      const error = new Error('Unknown project.');
      error.statusCode = 404;
      throw error;
    }
    if (!channel.studio) {
      return { advanced: false, state: 'studio-unavailable' };
    }
    if (learningIsPaused()) {
      return { advanced: false, state: 'learning-paused' };
    }
    // Auto-advance is a per-project learner preference, not a client-side
    // hint. A hand-crafted POST must not turn it on for someone who has not
    // explicitly opted in from the Studio settings.
    if (options?.auto === true && activationFor(channel.id)?.auto_advance !== true) {
      return { advanced: false, state: 'auto-advance-disabled' };
    }
    if (options?.auto === true && channel.studio.currentNow?.().kind !== 'real') {
      return { advanced: false, state: 'auto-advance-current-not-real' };
    }
    const buffered = channel.studio.readyCard?.();
    if (!buffered) {
      return channel.studio.next(options);
    }
    const decision = await channel.curriculumService.beforeDelivery(buffered, { solicited: true });
    if (!decision?.deliver) {
      // A different project/process can master the buffered concept after it
      // was generated. Do not leave a gold card lit forever: remove it through
      // Studio's ledgered clear path so the activity trail closes honestly.
      if (decision?.state === 'skipped') {
        await channel.studio.discardReady?.({ reason: 'mastered' });
        touch(channel.id, channel.state);
      }
      channelHub(channel.id, channel.state).broadcast('status', {
        state: decision?.state || 'waiting',
        message: decision?.message || 'Osmosis is waiting before the next lesson.',
        provider: channel.provider.name,
      });
      return { advanced: false, state: decision?.state || 'waiting' };
    }
    const result = await channel.studio.next(options);
    if (result.advanced) {
      await channel.curriculumService.markDelivered(buffered.concept_id);
      touch(channel.id, channel.state);
    }
    // Return the same canonical Studio shape that SSE and a reload use. The
    // browser can update immediately from this response, but a delayed or
    // duplicated event can never substitute a hidden card for Now.
    const studio = channel.studio.projection();
    return result.card
      ? { ...result, card: cardForClient(result.card), studio }
      : { ...result, studio };
  }

  async function reviewLessons(projectId) {
    const channel = await ensureChannel(projectId);
    if (!channel) {
      return null;
    }
    const review = snapshotFor(channel.state).cards.filter((card) => card?.state?.answered);
    return { cards: review, project_id: channel.id };
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
      uiLocale: settings.snapshot().ui_locale,
    });
  }

  async function projectSnapshot(projectId) {
    const channel = await ensureChannel(projectId);
    if (!channel) {
      return null;
    }
    const project = registry.getProject(channel.id);
    const snapshot = snapshotFor(channel.state);
    return {
      project,
      project_id: channel.id,
      ...snapshot,
      studio: channel.studio?.projection?.() || snapshot.studio,
    };
  }

  async function initialEvents() {
    await initializeIfNeeded();
    const current = await projectSnapshot(defaultProjectId);
    const legacy = current
      ? {
        cards: current.cards,
        strengths: current.strengths,
        studio: current.studio,
        tree: current.tree,
      }
      : {
        cards: [],
        strengths: profileStore.strengths,
        studio: {
          now: { kind: null, card_ref: null },
          current: null,
          current_warmup: null,
          next_ready: false,
          waiting: { reason: 'idle', source_provenance: null },
        },
        tree: { meta: {}, nodes: [] },
      };
    const projects = registry.listProjects();
    return [
      { type: 'snapshot', payload: legacy },
      {
        type: 'snapshot-v2',
        payload: {
          active_project_id: current ? defaultProjectId : null,
          activation: activation(defaultProjectId),
          activations: activations(),
          channel: current,
          channels: current ? { [defaultProjectId]: current } : {},
          default_project_id: defaultProjectId,
          projects,
          settings: settings.snapshot(),
          notices: startupNoticesSnapshot(),
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

  async function conversationTitles(ids) {
    await initializeIfNeeded();
    return {
      enabled: settings.snapshot().local_conversation_titles === true,
      titles: await conversationStore.titlesFor(ids, {
        enabled: settings.snapshot().local_conversation_titles === true,
      }),
    };
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
    // Ambient observation may inspect an arbitrary local session. Resolving
    // its identity is needed for isolation, but it must not itself make that
    // project appear in the user-facing activation inbox: only a runner/MCP
    // registration starts the first-activation flow.
    const identity = await resolveProjectIdentity(cwd);
    const preference = activationFor(identity.project_id);
    if (learningIsPaused()) {
      return { reason: 'learning-paused', registered: false, root: identity.root };
    }
    if (preference?.carry !== true) {
      return {
        reason: preference?.state === 'uncarried' ? 'project-not-carried' : 'activation-pending',
        registered: false,
        root: identity.root,
      };
    }
    if (!config.ambientEnabled) {
      return { reason: 'ambient-master-disabled', registered: false, root: identity.root };
    }
    if (preference.capture_mode !== CAPTURE_EXPERIMENTAL_AMBIENT) {
      return { reason: 'ambient-not-enabled-for-project', registered: false, root: identity.root };
    }
    const summary = registry.findByRoot(identity.root);
    return summary
      ? { project_id: summary.project_id, root: summary.root }
      : { reason: 'registration-pending', registered: false, root: identity.root };
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
      const hydrate = async () => {
        const refreshed = await loadProjectState(channel.config, profileStore.strengths);
        channel.state.cards = refreshed.cards;
        channel.state.tree = refreshed.tree;
        channel.state.studio = refreshed.studio;
        if (refreshed.studio_migrated) {
          await channel.persistence?.saveCards(channel.state.cards, channel.state.studio);
        }
        channel.curriculumService.restorePacing?.();
      };
      if (channel.studio?.reload) {
        await channel.studio.reload(hydrate, { resume: ownerStarted });
      } else {
        await hydrate();
      }
    }
    // Only an owner lifecycle may resume durable work. Server startup now
    // creates a fresh broker after the port bind, so this compatibility helper
    // intentionally refreshes state without waking a Studio on its own.
  }

  function health() {
    return {
      default_project_id: defaultProjectId,
      projects: registry.listProjects(),
    };
  }

  function close() {
    // Fence delayed Ambient/provider promises before asking any child service
    // to stop. A later owner is a fresh broker instance; this one can never
    // publish a warmup, flush an outbox, or resume a generator afterwards.
    ownerStarted = false;
    ownerEpoch += 1;
    closed = true;
    if (archiveSweepTimer) {
      clearIntervalFn(archiveSweepTimer);
      archiveSweepTimer = null;
    }
    scheduler.close();
    for (const summary of registry.listProjects()) {
      const channel = registry.getHydratedProject(summary.project_id);
      channel?.studio?.deactivate?.();
      channel?.close?.();
    }
  }

  async function whenIdle() {
    await scheduler.whenIdle();
    for (const summary of registry.listProjects()) {
      const channel = registry.getHydratedProject(summary.project_id);
      await channel?.reportPipeline?.whenIdle?.();
      await channel?.studio?.whenIdle?.();
    }
    await Promise.all([
      ledger.whenIdle?.(),
      profileStore.whenIdle?.(),
      registry.whenIdle?.(),
      settings.whenIdle?.(),
      conversationStore.whenIdle?.(),
    ]);
  }

  return {
    acceptLocalReport,
    acceptRelayReport,
    acceptWarmupCandidate,
    activateProject,
    activation,
    activations,
    activity,
    archiveInactiveProjects,
    answer,
    archiveProject,
    close,
    conversationTitles,
    ensureChannel,
    get defaultProjectId() {
      return defaultProjectId;
    },
    get profileStore() {
      return profileStore;
    },
    get settingsStore() {
      return settings;
    },
    getSettings,
    health,
    initialEvents,
    initialize,
    inlineCardHtml,
    listProjects,
    nextLesson,
    recentReports,
    recordUnregisteredActivity,
    register,
    registry,
    reloadHydrated,
    resolveAmbientProject,
    scheduler,
    startOwner,
    projectSnapshot,
    reviewLessons,
    unarchiveProject,
    updateProjectSettings,
    updateSettings,
    whenIdle,
  };
}

module.exports = {
  createBroker,
  createFairReportScheduler,
  projectConfig,
};
