'use strict';

const { randomUUID } = require('node:crypto');

const { createRuntimeCard } = require('./card-factory');
const { unansweredCount } = require('./curriculum-service');
const { log } = require('./log');
const { isMastered } = require('./mastery');

function createReportPipeline({ cardService, config, curriculumService, hub, provider, replayService, state, ledger = null, studio = null }) {
  const reports = [];
  let generationQueue = Promise.resolve();
  let pendingGenerationCount = 0;
  let studioCoordinator = studio;
  const generationQueueCap = Math.max(1, Number.isInteger(config.generationQueueCap) ? config.generationQueueCap : config.unansweredCardCap || 5);

  function recentReports() {
    return reports.slice();
  }

  function appendLedger(event) {
    if (!ledger || typeof ledger.append !== 'function') {
      return;
    }
    try {
      const maybePromise = ledger.append(event);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        void maybePromise.catch((error) => log('could not append project activity', error && error.message ? error.message : error));
      }
    } catch (error) {
      log('could not append project activity', error && error.message ? error.message : error);
    }
  }

  function trace(report, event, state, extra = {}) {
    appendLedger({
      at: new Date().toISOString(),
      event,
      report_id: report.report_id,
      source: report.source === 'observed' ? 'observed' : 'agent',
      state,
      ...extra,
    });
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

  function enqueue(report) {
    // The Learning Studio owns its own durable two-candidate watermark and
    // one-hidden-Next buffer. Keep the older card-wall pipeline intact for
    // replay/record compatibility, but hand live Studio reports to that
    // coordinator before this legacy queue reserves five visible-card slots.
    if (studioCoordinator && typeof studioCoordinator.enqueueReport === 'function') {
      const storedReport = {
        ...report,
        report_id: typeof report?.report_id === 'string' && report.report_id ? report.report_id : randomUUID(),
        received_at: new Date().toISOString(),
      };
      reports.push(storedReport);
      if (reports.length > 100) reports.shift();
      return studioCoordinator.enqueueReport(storedReport);
    }
    const storedReport = {
      ...report,
      report_id: typeof report.report_id === 'string' && report.report_id ? report.report_id : randomUUID(),
      received_at: new Date().toISOString(),
    };
    trace(storedReport, 'accept', 'observed');
    // Bound both the work already running and the reports waiting behind it.
    // This is intentionally project-global: a burst from several observed
    // Codex sessions must not create an unbounded second queue behind the
    // five unanswered lessons on the wall.
    if (pendingGenerationCount >= availableGenerationSlots()) {
      queueFullStatus('Osmosis is already processing several lessons. It will wait for the next report.');
      trace(storedReport, 'refusal', 'waiting', { reason: 'generation-queue-full' });
      return { accepted: false, done: Promise.resolve({ state: 'waiting' }), report: storedReport };
    }

    if (curriculumService.isQueueFull?.()) {
      queueFullStatus('Five lessons are already waiting. Osmosis will hold the next report.');
      trace(storedReport, 'refusal', 'waiting', { reason: 'unanswered-card-cap' });
      return { accepted: false, done: Promise.resolve({ state: 'waiting' }), report: storedReport };
    }
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
    const task = generationQueue
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
    generationQueue = task.catch(() => {});
    return { accepted: true, done: task, report: storedReport };
  }

  function accept(report) {
    return enqueue(report).accepted;
  }

  async function createReportCard(report) {
    try {
      if (config.mode === 'replay') {
        const replayCard = replayService.consume(report);
        if (!replayCard) {
          trace(report, 'refusal', 'suppressed', { reason: 'replay-complete' });
          hub.broadcast('status', {
            state: 'replay-complete',
            message: 'Replay has no more recorded lessons.',
          });
          return { state: 'suppressed' };
        }
        const delivery = await cardService.deliver(replayCard);
        if (delivery.delivered) {
          trace(report, 'delivery', 'delivered', { card_id: replayCard.card_id });
        } else {
          trace(report, 'refusal', 'suppressed', { reason: delivery.state || 'replay-delivery-suppressed' });
        }
        hub.broadcast('status', { state: 'idle', message: 'Osmosis is ready for the next replay milestone.' });
        log('replay card delivered', replayCard.card_id);
        return { state: delivery.delivered ? 'delivered' : 'suppressed' };
      }

      const curriculum = await curriculumService.prepare(report);
      if (curriculum.skip) {
        trace(report, 'refusal', 'suppressed', { reason: curriculum.skip.state || 'curriculum-suppressed' });
        hub.broadcast('status', { ...curriculum.skip, provider: provider.name });
        return { state: 'suppressed' };
      }

      const providerCard = await provider.generateCard({
        concepts: curriculum.concepts || [],
        masteredConceptIds: curriculum.masteredConceptIds || [],
        report,
      });
      const generatedCard = curriculum.conceptIdMap?.has(providerCard.concept_id)
        ? { ...providerCard, concept_id: curriculum.conceptIdMap.get(providerCard.concept_id) }
        : providerCard;
      trace(report, 'provider-result', 'observed', { concept_id: generatedCard.concept_id });
      if (curriculum.usesProjectTree && !curriculum.conceptIds.has(generatedCard.concept_id)) {
        throw new Error(`Provider selected a concept outside the available tree leaves: ${generatedCard.concept_id}.`);
      }

      if (isMastered(state.strengths, generatedCard.concept_id)) {
        trace(report, 'refusal', 'suppressed', { reason: 'mastered', concept_id: generatedCard.concept_id });
        hub.broadcast('status', {
          state: 'skipped',
          message: `You have already mastered ${generatedCard.concept_name}.`,
          concept_id: generatedCard.concept_id,
          provider: provider.name,
        });
        log('mastered concept skipped', generatedCard.concept_id);
        return { state: 'suppressed' };
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
        trace(report, 'refusal', delivery.state === 'queue-full' ? 'waiting' : 'suppressed', {
          reason: delivery.state || 'delivery-suppressed',
          concept_id: card.concept_id,
        });
        hub.broadcast('status', {
          state: delivery.state,
          message: delivery.message,
          concept_id: card.concept_id,
          provider: provider.name,
        });
        return { state: delivery.state === 'queue-full' ? 'waiting' : 'suppressed' };
      }
      await replayService.record(report, card);
      trace(report, 'delivery', 'delivered', { card_id: card.card_id, concept_id: card.concept_id });
      hub.broadcast('status', { state: 'idle', message: 'Osmosis is ready for the next milestone.', provider: provider.name });
      log(`${provider.name} card generated from report`, card.card_id);
      return { state: 'delivered', card };
    } catch (error) {
      trace(report, 'failure', 'failed', { reason: 'generation-failed' });
      hub.broadcast('status', { state: 'failed', message: 'Osmosis could not make a lesson from that activity. It will wait for the next milestone.', provider: provider.name });
      log('could not create lesson card', error && error.stack ? error.stack : error);
      return { state: 'failed' };
    }
  }

  /**
   * Generate a runtime card without placing it on the old multi-card wall.
   * The Studio calls this from its fair, one-per-channel work slot and then
   * decides whether the result becomes the visible Now card or its hidden
   * Next buffer. Keeping provider/curriculum validation here prevents the
   * two surfaces from ever drifting in concept selection or provenance.
   */
  async function generateForStudio(report, { canCommit = () => true } = {}) {
    const writable = () => {
      try {
        return canCommit() !== false;
      } catch {
        return false;
      }
    };
    if (!writable()) {
      return { state: 'owner-inactive' };
    }
    try {
      if (config.mode === 'replay') {
        const replayCard = replayService.consume(report);
        if (!replayCard) {
          return {
            reason: 'replay-complete',
            state: 'suppressed',
            status: {
              state: 'replay-complete',
              message: 'Replay has no more recorded lessons.',
            },
          };
        }
        return { state: 'generated', card: replayCard };
      }

      const curriculum = await curriculumService.prepare(report);
      if (!writable()) {
        return { state: 'owner-inactive' };
      }
      if (curriculum.skip) {
        return {
          reason: curriculum.skip.state || 'curriculum-suppressed',
          state: 'suppressed',
          status: { ...curriculum.skip, provider: provider.name },
        };
      }

      const providerCard = await provider.generateCard({
        concepts: curriculum.concepts || [],
        masteredConceptIds: curriculum.masteredConceptIds || [],
        report,
      });
      if (!writable()) {
        return { state: 'owner-inactive' };
      }
      const generatedCard = curriculum.conceptIdMap?.has(providerCard.concept_id)
        ? { ...providerCard, concept_id: curriculum.conceptIdMap.get(providerCard.concept_id) }
        : providerCard;
      // Studio writes this trace only after the generated card has crossed
      // its durable current/ready watermark, so its activity drawer gets one
      // honest provider-result entry rather than a duplicate.
      if (curriculum.usesProjectTree && !curriculum.conceptIds.has(generatedCard.concept_id)) {
        throw new Error(`Provider selected a concept outside the available tree leaves: ${generatedCard.concept_id}.`);
      }

      if (isMastered(state.strengths, generatedCard.concept_id)) {
        return {
          concept_id: generatedCard.concept_id,
          reason: 'mastered',
          state: 'suppressed',
          status: {
            state: 'skipped',
            message: `You have already mastered ${generatedCard.concept_name}.`,
            concept_id: generatedCard.concept_id,
            provider: provider.name,
          },
        };
      }

      return { state: 'generated', card: createRuntimeCard(generatedCard, report) };
    } catch (error) {
      if (!writable()) {
        return { state: 'owner-inactive' };
      }
      log('could not create Studio lesson card', error && error.stack ? error.stack : error);
      return {
        reason: 'generation-failed',
        state: 'failed',
        status: {
          state: 'failed',
          message: 'Osmosis could not make a lesson from that activity. It will wait for the next milestone.',
          provider: provider.name,
        },
      };
    }
  }

  async function recordStudioDelivery(report, card) {
    await replayService.record(report, card);
    trace(report, 'delivery', 'delivered', { card_id: card.card_id, concept_id: card.concept_id });
    hub.broadcast('status', {
      state: 'idle',
      message: 'Osmosis is ready for the next milestone.',
      provider: provider.name,
    });
    log(`${provider.name} Studio card delivered`, card.card_id);
    return { state: 'delivered', card };
  }

  function recordStudioWaiting(report, reason, extra = {}) {
    trace(report, 'refusal', 'waiting', { reason, ...extra });
  }

  return {
    accept,
    enqueue,
    generateForStudio,
    recentReports,
    recordStudioDelivery,
    recordStudioWaiting,
    setStudio(value) {
      studioCoordinator = value || null;
    },
    // Test and shutdown helpers can wait for the bounded serial queue without
    // reaching into its implementation. Normal callers remain fire-and-forget.
    whenIdle: () => generationQueue,
  };
}

module.exports = { createReportPipeline };
