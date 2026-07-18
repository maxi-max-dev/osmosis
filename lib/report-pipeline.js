'use strict';

const { createRuntimeCard } = require('./card-factory');
const { unansweredCount } = require('./curriculum-service');
const { log } = require('./log');
const { isMastered } = require('./mastery');

function createReportPipeline({ cardService, config, curriculumService, hub, provider, replayService, state }) {
  const reports = [];
  let generationQueue = Promise.resolve();
  let pendingGenerationCount = 0;
  const generationQueueCap = Math.max(1, Number.isInteger(config.generationQueueCap) ? config.generationQueueCap : config.unansweredCardCap || 5);

  function recentReports() {
    return reports.slice();
  }

  function queueFullStatus(message) {
    hub.broadcast('status', {
      state: 'queue-full',
      message,
      provider: provider.name,
    });
  }

  function availableGenerationSlots() {
    const unansweredCap = Math.max(1, Number.isInteger(config.unansweredCardCap) ? config.unansweredCardCap : 5);
    const cardSlots = Math.max(0, unansweredCap - unansweredCount(state.cards));
    return Math.min(generationQueueCap, cardSlots);
  }

  function accept(report) {
    // Bound both the work already running and the reports waiting behind it.
    // This is intentionally project-global: a burst from several observed
    // Codex sessions must not create an unbounded second queue behind the
    // five unanswered lessons on the wall.
    if (pendingGenerationCount >= availableGenerationSlots()) {
      queueFullStatus('Osmosis is already processing several lessons. It will wait for the next report.');
      return false;
    }

    if (curriculumService.isQueueFull?.()) {
      queueFullStatus('Five lessons are already waiting. Osmosis will hold the next report.');
      return false;
    }

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
    pendingGenerationCount += 1;
    generationQueue = generationQueue
      .then(() => createReportCard(storedReport))
      .catch((error) => {
        // createReportCard handles expected generation failures itself. Keep a
        // final guard so an unexpected dependency failure cannot poison the
        // shared queue and block every later session.
        log('could not advance lesson generation queue', error && error.stack ? error.stack : error);
      })
      .finally(() => {
        pendingGenerationCount -= 1;
      });
    return true;
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
      if (curriculum.usesProjectTree && !curriculum.conceptIds.has(generatedCard.concept_id)) {
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
      const delivery = await cardService.deliver(card, {
        // Run this inside CardService's serial delivery queue. A template
        // starter, a report from another session, and an eligible review then
        // all recheck the same wall-wide pacing/cap immediately before they
        // can persist a card.
        beforePersist: () => curriculumService.beforeDelivery(card),
        afterPersisted: () => curriculumService.markDelivered(card.concept_id),
      });
      if (!delivery.delivered) {
        hub.broadcast('status', {
          state: delivery.state,
          message: delivery.message,
          concept_id: card.concept_id,
          provider: provider.name,
        });
        return;
      }
      await replayService.record(report, card);
      hub.broadcast('status', { state: 'idle', message: 'Osmosis is ready for the next milestone.', provider: provider.name });
      log(`${provider.name} card generated from report`, card.card_id);
    } catch (error) {
      hub.broadcast('status', { state: 'idle', message: 'Osmosis will wait for the next milestone.', provider: provider.name });
      log('could not create lesson card', error && error.stack ? error.stack : error);
    }
  }

  return {
    accept,
    recentReports,
    // Test and shutdown helpers can wait for the bounded serial queue without
    // reaching into its implementation. Normal callers remain fire-and-forget.
    whenIdle: () => generationQueue,
  };
}

module.exports = { createReportPipeline };
