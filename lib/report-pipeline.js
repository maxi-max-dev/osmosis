'use strict';

const { createRuntimeCard } = require('./card-factory');
const { log } = require('./log');

function createReportPipeline({ cardService, config, hub, provider, replayService, state }) {
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

    hub.broadcast('status', {
      state: 'generating',
      message: 'Osmosis is preparing a lesson.',
      report: storedReport,
    });
    generationQueue = generationQueue.then(() => createReportCard(storedReport));
  }

  async function createReportCard(report) {
    try {
      if (config.mode === 'replay') {
        const replayCard = replayService.consume(report);
        if (!replayCard) {
          hub.broadcast('status', {
            state: 'replay-complete',
            message: 'Replay has no more recorded lessons.',
          });
          return;
        }
        await cardService.deliver(replayCard);
        hub.broadcast('status', { state: 'idle', message: 'Osmosis is ready for the next replay milestone.' });
        log('replay card delivered', replayCard.card_id);
        return;
      }

      const generatedCard = await provider.generateCard(report);
      if (config.mode === 'live' && provider.name === 'none' && state.strengths[generatedCard.concept_id]?.strength >= 2) {
        hub.broadcast('status', {
          state: 'skipped',
          message: `You have already mastered ${generatedCard.concept_name}.`,
          concept_id: generatedCard.concept_id,
        });
        log('mastered template concept skipped', generatedCard.concept_id);
        return;
      }

      const card = createRuntimeCard(generatedCard, report);
      await cardService.deliver(card);
      await replayService.record(report, card);
      hub.broadcast('status', { state: 'idle', message: 'Osmosis is ready for the next milestone.' });
      log(`${provider.name} card generated from report`, card.card_id);
    } catch (error) {
      hub.broadcast('status', { state: 'idle', message: 'Osmosis will wait for the next milestone.' });
      log('could not create template card', error && error.stack ? error.stack : error);
    }
  }

  return { accept, recentReports };
}

module.exports = { createReportPipeline };
