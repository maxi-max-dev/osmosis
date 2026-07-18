'use strict';

const { createTemplateCard } = require('./card-factory');
const { log } = require('./log');

function createReportPipeline({ hub, cardService }) {
  const reports = [];
  let generationQueue = Promise.resolve();

  function recentReports() {
    return reports.slice();
  }

  function accept(report) {
    const storedReport = {
      ...report,
      received_at: new Date().toISOString(),
    };
    reports.push(storedReport);
    if (reports.length > 100) {
      reports.shift();
    }

    hub.broadcast('status', { state: 'generating', message: 'Osmosis is preparing a lesson.' });
    generationQueue = generationQueue.then(() => createReportCard(storedReport));
  }

  async function createReportCard(report) {
    try {
      const card = createTemplateCard(report);
      await cardService.deliver(card);
      hub.broadcast('status', { state: 'idle', message: 'Osmosis is ready for the next milestone.' });
      log('template card generated from report', card.card_id);
    } catch (error) {
      hub.broadcast('status', { state: 'idle', message: 'Osmosis will wait for the next milestone.' });
      log('could not create template card', error && error.stack ? error.stack : error);
    }
  }

  return { accept, recentReports };
}

module.exports = { createReportPipeline };
