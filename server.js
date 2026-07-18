#!/usr/bin/env node
'use strict';

const http = require('node:http');
const path = require('node:path');

const { createTemplateCard } = require('./lib/card-factory');
const { createAmbientWatcher } = require('./lib/ambient');
const { createBroker } = require('./lib/broker');
const { getConfig } = require('./lib/config');
const { createHttpHandler } = require('./lib/http');
const { log } = require('./lib/log');
const { createMcpServer } = require('./lib/mcp');
const { resolveProjectIdentity } = require('./lib/project-identity');
const { createRelayInlineCardResolver } = require('./lib/relay-inline');
const { SseHub } = require('./lib/sse');

async function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      if (error && error.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(true);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function applyProjectIdentity(config, identity) {
  const stateDir = path.join(identity.root, '.osmosis');
  config.projectId = identity.project_id;
  config.projectRoot = identity.root;
  config.stateDir = stateDir;
  config.treePath = path.join(stateDir, 'tree.json');
  config.replayPath = path.join(stateDir, 'replay.json');
}

function primaryBaseUrl(config) {
  return `http://${config.host}:${config.port}`;
}

async function postRegistration(config) {
  const response = await fetch(`${primaryBaseUrl(config)}/internal/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: config.projectRoot }),
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) {
    throw new Error(`primary registration returned ${response.status}`);
  }
  const value = await response.json();
  if (!value || typeof value.project_id !== 'string' || typeof value.token !== 'string') {
    throw new Error('primary registration returned an invalid relay identity');
  }
  return value;
}

async function forwardReportToPrimary(config, relayIdentity, report) {
  const query = relayIdentity?.project_id ? `?project=${encodeURIComponent(relayIdentity.project_id)}` : '';
  const headers = { 'content-type': 'application/json' };
  if (relayIdentity?.token) {
    headers['x-osmosis-token'] = relayIdentity.token;
  }
  const response = await fetch(`${primaryBaseUrl(config)}/internal/reports${query}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(4_000),
  });

  if (!response.ok) {
    const error = new Error(`primary report relay returned ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
}

async function main() {
  const config = getConfig();
  applyProjectIdentity(config, await resolveProjectIdentity(config.cwd));
  const hub = new SseHub();
  const broker = createBroker({ config, hub, getBaseUrl: () => primaryBaseUrl(config) });
  await broker.initialize();

  let reportDelivery = 'starting';
  let pipelineReady = false;
  const queuedStartupReports = [];
  const queuedRelayReports = [];
  const queuedLocalReports = [];
  let relayIdentity = null;
  let registrationInFlight = null;
  let ambientWatcher = null;
  let binding = false;
  let httpEnabled = false;
  let portRetryTimer = null;
  let shuttingDown = false;
  let starterTimer = null;

  function queueReport(queue, report, message) {
    if (queue.length < 20) {
      queue.push(report);
      return;
    }
    log(message);
  }

  function acceptAgentReport(report) {
    void broker.acceptLocalReport(report).catch((error) =>
      log('could not accept an agent report in the local broker', error && error.message ? error.message : error),
    );
  }

  function acceptLocalAgentReport(report) {
    if (!pipelineReady) {
      queueReport(queuedLocalReports, report, 'dropped a report while the new HTTP owner was reconciling local state');
      return;
    }
    acceptAgentReport(report);
  }

  async function ensureRelayRegistration() {
    if (relayIdentity) {
      return relayIdentity;
    }
    if (!registrationInFlight) {
      registrationInFlight = postRegistration(config)
        .then((identity) => {
          relayIdentity = identity;
          return identity;
        })
        .finally(() => {
          registrationInFlight = null;
        });
    }
    return registrationInFlight;
  }

  async function flushRelayReports() {
    if (reportDelivery !== 'relay') {
      return;
    }
    let identity;
    try {
      identity = await ensureRelayRegistration();
    } catch (error) {
      log('could not register the MCP relay with the HTTP owner', error && error.message ? error.message : error);
      return;
    }
    while (reportDelivery === 'relay' && queuedRelayReports.length > 0) {
      const report = queuedRelayReports.shift();
      try {
        await forwardReportToPrimary(config, identity, report);
      } catch (error) {
        // The owner may have been replaced. Discard the ephemeral capability
        // and retry registration on the next flush, retaining report order.
        relayIdentity = null;
        queuedRelayReports.unshift(report);
        log('could not relay report to the HTTP-owning process', error && error.message ? error.message : error);
        return;
      }
    }
  }

  // MCP payloads remain the frozen three-key schema until they pass through
  // the primary. A loser never sends a cwd or any extra routing field.
  function acceptMcpReport(report) {
    if (reportDelivery === 'starting') {
      queueReport(queuedStartupReports, report, 'dropped a report before delivery mode was known');
      return;
    }
    if (reportDelivery === 'primary') {
      acceptLocalAgentReport(report);
      return;
    }
    queueReport(queuedRelayReports, report, 'dropped a report while the relay queue was full');
    void flushRelayReports();
  }

  const inlineCardHtml = createRelayInlineCardResolver({
    broker,
    getBaseUrl: () => primaryBaseUrl(config),
    getDelivery: () => reportDelivery,
    getRelayIdentity: () => relayIdentity,
  });

  function inlineAnswerOrigin() {
    return primaryBaseUrl(config);
  }

  const handler = createHttpHandler({
    answerCard: (projectId, answer) => broker.answer(projectId, answer),
    broker,
    config,
    hub,
    initialEvents: () => broker.initialEvents(),
    inlineCardHtml,
    recentReports: () => broker.recentReports(),
    snapshot: () => ({ cards: [], strengths: {}, tree: { meta: {}, nodes: [] } }),
  });
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  const mcp = createMcpServer({
    getInlineAnswerOrigin: inlineAnswerOrigin,
    getInlineCardHtml: inlineCardHtml,
    onReport: acceptMcpReport,
  });
  mcp.start();

  function canRunAmbientWatch() {
    return config.ambientEnabled && config.mode === 'live';
  }

  function startAmbientWatch() {
    if (!canRunAmbientWatch() || ambientWatcher) {
      return;
    }
    try {
      ambientWatcher = createAmbientWatcher({
        config,
        log,
        onReport: (report, project) => broker.acceptLocalReport(report, project?.project_id),
        onSuppressed: (entry) => broker.recordUnregisteredActivity(entry),
        resolveProject: (cwd) => broker.resolveAmbientProject(cwd),
      });
      ambientWatcher.start();
    } catch (error) {
      log('could not start Ambient Watch', error && error.message ? error.message : error);
      ambientWatcher = null;
    }
  }

  function startStarterTimer() {
    if (!httpEnabled || starterTimer || config.mode !== 'live' || config.provider !== 'none') {
      return;
    }
    starterTimer = setTimeout(() => {
      void pushStarterCard();
    }, config.templateDelayMs);
    starterTimer.unref();
  }

  async function pushStarterCard() {
    const channel = await broker.ensureChannel();
    if (!channel || channel.state.cards.some((card) => !card.state.answered)) {
      return;
    }
    const card = createTemplateCard();
    const delivery = await channel.cardService.deliver(card, {
      afterPersisted: () => channel.curriculumService.markDelivered(card.concept_id),
      beforePersist: () => channel.curriculumService.beforeDelivery(card),
    });
    if (delivery.delivered) {
      log('template card generated', card.card_id);
    }
  }

  function stopPortRetry() {
    if (portRetryTimer) {
      clearInterval(portRetryTimer);
      portRetryTimer = null;
    }
  }

  function startPortRetry() {
    if (portRetryTimer || shuttingDown || httpEnabled) {
      return;
    }
    const retryMs = Number.isInteger(config.portRetryMs) && config.portRetryMs > 0 ? config.portRetryMs : 15_000;
    portRetryTimer = setInterval(() => {
      void tryAcquireHttpPort();
    }, retryMs);
    portRetryTimer.unref?.();
  }

  async function becomePrimary() {
    if (httpEnabled || shuttingDown) {
      return;
    }
    const takingOverFromRelay = reportDelivery === 'relay';
    // Delivery changes first: reports arriving while disk state refreshes are
    // retained locally instead of relayed to an owner that no longer exists.
    reportDelivery = 'primary';
    httpEnabled = true;
    pipelineReady = false;
    stopPortRetry();
    const address = server.address();
    if (address && typeof address === 'object') {
      config.port = address.port;
    }
    log(`HTTP listening on http://${config.host}:${config.port}`, `cwd=${config.cwd}`);
    if (takingOverFromRelay) {
      try {
        await broker.reloadHydrated();
      } catch (error) {
        log('could not reconcile broker state after HTTP takeover', error && error.message ? error.message : error);
      }
    }
    if (shuttingDown) {
      return;
    }
    pipelineReady = true;
    for (const report of queuedRelayReports.splice(0)) {
      acceptLocalAgentReport(report);
    }
    for (const report of queuedLocalReports.splice(0)) {
      acceptLocalAgentReport(report);
    }
    startAmbientWatch();
    startStarterTimer();
  }

  async function tryAcquireHttpPort() {
    if (binding || shuttingDown || httpEnabled) {
      return;
    }
    binding = true;
    try {
      const acquired = await listen(server, config.port, config.host);
      if (acquired) {
        await becomePrimary();
        return;
      }
      reportDelivery = 'relay';
      startPortRetry();
      void flushRelayReports();
    } catch (error) {
      reportDelivery = 'relay';
      log('could not retry the HTTP port', error && error.message ? error.message : error);
      startPortRetry();
    } finally {
      binding = false;
    }
  }

  await tryAcquireHttpPort();
  if (!httpEnabled) {
    log(`HTTP disabled because ${config.host}:${config.port} is already in use; continuing with MCP stdio only.`);
  }

  for (const report of queuedStartupReports.splice(0)) {
    acceptMcpReport(report);
  }

  function shutdown(signal) {
    shuttingDown = true;
    stopPortRetry();
    if (starterTimer) {
      clearTimeout(starterTimer);
      starterTimer = null;
    }
    ambientWatcher?.stop();
    broker.close();
    hub.close();
    if (httpEnabled) {
      server.close(() => process.exit(0));
      server.closeAllConnections?.();
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1_000).unref();
    log(`received ${signal}; shutting down`);
  }

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  log('fatal startup error', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
