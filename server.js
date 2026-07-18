#!/usr/bin/env node
'use strict';

const http = require('node:http');

const { getConfig } = require('./lib/config');
const { createTemplateCard } = require('./lib/card-factory');
const { createCardService } = require('./lib/card-service');
const { createCurriculumService } = require('./lib/curriculum-service');
const { createAnswerService } = require('./lib/answer-service');
const { createAmbientWatcher } = require('./lib/ambient');
const { createHttpHandler } = require('./lib/http');
const { renderInlineCard } = require('./lib/inline-card');
const { log } = require('./lib/log');
const { createMcpServer } = require('./lib/mcp');
const { createProvider } = require('./lib/provider');
const { createReportPipeline } = require('./lib/report-pipeline');
const { createReplayService } = require('./lib/replay');
const { SseHub } = require('./lib/sse');
const { createPersistence, loadProjectState, snapshotFor } = require('./lib/state');
const { createTreeService } = require('./lib/tree-service');

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

async function forwardReportToPrimary(config, report) {
  const response = await fetch(`http://${config.host}:${config.port}/internal/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(4_000),
  });

  if (!response.ok) {
    throw new Error(`primary report relay returned ${response.status}`);
  }
}

async function main() {
  const config = getConfig();
  const state = await loadProjectState(config);
  const hub = new SseHub();
  const persistence = createPersistence(config);
  const cardService = createCardService({ state, hub, persistence });
  const provider = createProvider(config);
  const replayService = await createReplayService({ config, persistence, state });
  const treeService = createTreeService({ hub, persistence, provider, state });
  const curriculumService = createCurriculumService({ config, hub, provider, state, treeService });
  cardService.setRequeueDeliveryGate({
    beforeDelivery: curriculumService.beforeDelivery,
    afterDelivered: (card) => curriculumService.markDelivered(card.concept_id),
  });
  const reportPipeline = createReportPipeline({
    cardService,
    config,
    curriculumService,
    hub,
    provider,
    replayService,
    state,
  });
  const answerService = createAnswerService({ state, hub, persistence, cardService });
  let reportDelivery = 'starting';
  let pipelineReady = false;
  const queuedStartupReports = [];
  const queuedRelayReports = [];
  const queuedLocalReports = [];
  let ambientWatcher = null;
  let binding = false;
  let httpEnabled = false;
  let portRetryTimer = null;
  let shuttingDown = false;
  let starterTimer = null;

  // MCP payloads remain the frozen three-key schema until they have passed
  // validation and reached the HTTP-owning pipeline. This matters for a port
  // loser: it must relay the raw validated payload to /internal/reports.
  function acceptAgentReport(report) {
    reportPipeline.accept({ ...report, source: 'agent' });
  }

  function queueLocalReport(report) {
    if (queuedLocalReports.length < 20) {
      queuedLocalReports.push(report);
      return;
    }
    log('dropped a report while the new HTTP owner was reconciling local state');
  }

  function acceptLocalAgentReport(report) {
    if (!pipelineReady) {
      queueLocalReport(report);
      return;
    }
    acceptAgentReport(report);
  }

  function acceptMcpReport(report) {
    if (reportDelivery === 'starting') {
      queuedStartupReports.push(report);
      return;
    }

    if (reportDelivery === 'primary') {
      acceptLocalAgentReport(report);
      return;
    }

    void forwardReportToPrimary(config, report).catch((error) => {
      // The old owner can die between this loser starting its relay request
      // and the request failing. If this process acquired the port in that
      // gap, keep the report in its own local pipeline rather than stranding
      // it in a relay queue that has already been flushed.
      if (reportDelivery === 'primary') {
        acceptLocalAgentReport(report);
        return;
      }
      if (queuedRelayReports.length < 20) {
        queuedRelayReports.push(report);
      }
      log('could not relay report to the HTTP-owning process', error && error.message ? error.message : error);
    });
  }

  function inlineAnswerOrigin() {
    return `http://127.0.0.1:${config.port}`;
  }

  function inlineCardHtml() {
    return renderInlineCard({
      state,
      answerUrl: `${inlineAnswerOrigin()}/answer`,
      refreshUrl: `${inlineAnswerOrigin()}/inline-card`,
    });
  }

  const handler = createHttpHandler({
    config,
    hub,
    snapshot: () => snapshotFor(state),
    recentReports: reportPipeline.recentReports,
    acceptInternalReport: acceptLocalAgentReport,
    answerCard: answerService.answer,
    inlineCardHtml,
  });
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  const mcp = createMcpServer({
    onReport: acceptMcpReport,
    getInlineCardHtml: inlineCardHtml,
    getInlineAnswerOrigin: inlineAnswerOrigin,
  });
  mcp.start();

  function canRunAmbientWatch() {
    // Record and replay remain deterministic fixtures. Ambient Watch is an
    // explicitly opt-in live-only observer.
    return config.ambientEnabled && config.mode === 'live';
  }

  function startAmbientWatch() {
    if (!canRunAmbientWatch() || ambientWatcher) {
      return;
    }
    try {
      ambientWatcher = createAmbientWatcher({
        config,
        onReport: reportPipeline.accept,
        log,
      });
      ambientWatcher.start();
    } catch (error) {
      log('could not start Ambient Watch', error && error.message ? error.message : error);
      ambientWatcher = null;
    }
  }

  function startStarterTimer() {
    if (!httpEnabled || starterTimer || config.mode !== 'live' || provider.name !== 'none') {
      return;
    }
    starterTimer = setTimeout(() => {
      void pushStarterCard();
    }, config.templateDelayMs);
    starterTimer.unref();
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
    // This must happen before the watcher begins: any agent report arriving
    // after the port is acquired belongs in this process's local pipeline.
    const takingOverFromRelay = reportDelivery === 'relay';
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
        // A port loser loaded state before the former owner made its latest
        // writes. Refresh the mutable state object before any local report,
        // answer, watcher, tree, or profile write can run in this process.
        const refreshed = await loadProjectState(config);
        state.cards = refreshed.cards;
        state.tree = refreshed.tree;
        state.strengths = refreshed.strengths;
      } catch (error) {
        // We still keep MCP available if a transient disk read fails, but make
        // the failure visible on stderr instead of silently replacing state.
        log('could not reconcile project state after HTTP takeover', error && error.message ? error.message : error);
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

  for (const report of queuedStartupReports) {
    acceptMcpReport(report);
  }

  async function pushStarterCard() {
    if (state.cards.some((card) => !card.state.answered)) {
      return;
    }

    const card = createTemplateCard();
    const delivery = await cardService.deliver(card, {
      beforePersist: () => curriculumService.beforeDelivery(card),
      // The starter shares the same project-wide pacing clock as every later
      // report, including Ambient Watch on the template provider.
      afterPersisted: () => curriculumService.markDelivered(card.concept_id),
    });
    if (!delivery.delivered) {
      return;
    }
    log('template card generated', card.card_id);
  }

  function shutdown(signal) {
    shuttingDown = true;
    stopPortRetry();
    if (starterTimer) {
      clearTimeout(starterTimer);
      starterTimer = null;
    }
    ambientWatcher?.stop();
    provider.close?.();
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
