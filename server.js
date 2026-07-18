#!/usr/bin/env node
'use strict';

const http = require('node:http');

const { getConfig } = require('./lib/config');
const { createTemplateCard } = require('./lib/card-factory');
const { createCardService } = require('./lib/card-service');
const { createAnswerService } = require('./lib/answer-service');
const { createHttpHandler } = require('./lib/http');
const { log } = require('./lib/log');
const { createMcpServer } = require('./lib/mcp');
const { createProvider } = require('./lib/provider');
const { createReportPipeline } = require('./lib/report-pipeline');
const { createReplayService } = require('./lib/replay');
const { SseHub } = require('./lib/sse');
const { createPersistence, loadProjectState, snapshotFor } = require('./lib/state');

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
  const reportPipeline = createReportPipeline({ cardService, config, hub, provider, replayService, state });
  const answerService = createAnswerService({ state, hub, persistence, cardService });
  let reportDelivery = 'starting';
  const queuedStartupReports = [];

  function acceptMcpReport(report) {
    if (reportDelivery === 'starting') {
      queuedStartupReports.push(report);
      return;
    }

    if (reportDelivery === 'primary') {
      reportPipeline.accept(report);
      return;
    }

    void forwardReportToPrimary(config, report).catch((error) => {
      log('could not relay report to the HTTP-owning process', error && error.message ? error.message : error);
    });
  }

  const handler = createHttpHandler({
    config,
    hub,
    snapshot: () => snapshotFor(state),
    recentReports: reportPipeline.recentReports,
    acceptInternalReport: reportPipeline.accept,
    answerCard: answerService.answer,
  });
  const server = http.createServer((request, response) => {
    void handler(request, response);
  });
  const mcp = createMcpServer({ onReport: acceptMcpReport });
  mcp.start();

  const httpEnabled = await listen(server, config.port, config.host);
  reportDelivery = httpEnabled ? 'primary' : 'relay';
  if (httpEnabled) {
    log(`HTTP listening on http://${config.host}:${config.port}`, `cwd=${config.cwd}`);
  } else {
    log(`HTTP disabled because ${config.host}:${config.port} is already in use; continuing with MCP stdio only.`);
  }

  for (const report of queuedStartupReports) {
    acceptMcpReport(report);
  }

  const starterTimer = httpEnabled && config.mode === 'live'
    ? setTimeout(() => {
        void pushStarterCard();
      }, config.templateDelayMs)
    : null;
  starterTimer?.unref();

  async function pushStarterCard() {
    if (state.cards.some((card) => !card.state.answered)) {
      return;
    }

    const card = createTemplateCard();
    await cardService.deliver(card);
    log('template card generated', card.card_id);
  }

  function shutdown(signal) {
    if (starterTimer) {
      clearTimeout(starterTimer);
    }
    hub.close();
    if (httpEnabled) {
      server.close(() => process.exit(0));
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
