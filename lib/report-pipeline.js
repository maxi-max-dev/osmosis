'use strict';

const { createRuntimeCard } = require('./card-factory');
const { log } = require('./log');
const { isMastered } = require('./mastery');

function createReportPipeline({ cardService, config, curriculumService, hub, provider, replayService, state }) {
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
      message: provider.isSlow ? 'Generating (this provider is slower).' : 'Osmosis is preparing a lesson.',
      provider: provider.name,
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

      const curriculum = await curriculumService.prepare(report);
      if (curriculum.skip) {
        hub.broadcast('status', { ...curriculum.skip, provider: provider.name });
        return;
      }

      const generatedCard = await provider.generateCard({
        concepts: curriculum.concepts || [],
        masteredConceptIds: curriculum.masteredConceptIds || [],
        report,
      });
      if (curriculum.enabled && !curriculum.conceptIds.has(generatedCard.concept_id)) {
        throw new Error(`Provider selected a concept outside the available tree leaves: ${generatedCard.concept_id}.`);
      }

      if (isMastered(state.strengths, generatedCard.concept_id)) {
        hub.broadcast('status', {
          state: 'skipped',
          message: `You have already mastered ${generatedCard.concept_name}.`,
          concept_id: generatedCard.concept_id,
          provider: provider.name,
        });
        log('mastered concept skipped', generatedCard.concept_id);
        return;
      }

      const card = createRuntimeCard(generatedCard, report);
      const delivery = await curriculumService.beforeDelivery(card);
      if (!delivery.deliver) {
        hub.broadcast('status', {
          state: delivery.state,
          message: delivery.message,
          concept_id: card.concept_id,
          provider: provider.name,
        });
        return;
      }
      await cardService.deliver(card);
      await curriculumService.markDelivered(card.concept_id);
      await replayService.record(report, card);
      hub.broadcast('status', { state: 'idle', message: 'Osmosis is ready for the next milestone.', provider: provider.name });
      log(`${provider.name} card generated from report`, card.card_id);
    } catch (error) {
      hub.broadcast('status', { state: 'idle', message: 'Osmosis will wait for the next milestone.', provider: provider.name });
      log('could not create lesson card', error && error.stack ? error.stack : error);
    }
  }

  return { accept, recentReports };
}

module.exports = { createReportPipeline };
