'use strict';

const fs = require('node:fs/promises');

const { createRuntimeCard } = require('./card-factory');

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadReplayDocument(replayPath) {
  try {
    const document = JSON.parse(await fs.readFile(replayPath, 'utf8'));
    if (!document || !Array.isArray(document.entries)) {
      throw new Error('Replay data must contain an entries array.');
    }
    return document;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        format: 'osmosis-replay',
        version: 1,
        recorded_at: null,
        provider: 'none',
        tree: { meta: {}, nodes: [] },
        entries: [],
      };
    }
    throw error;
  }
}

function generatedCardFromRuntime(card) {
  return {
    concept_id: card.concept_id,
    concept_name: card.concept_name,
    lesson: card.lesson,
    question: card.question,
    options: [...card.options],
    correct_index: card.correct_index,
    explanation: card.explanation,
  };
}

function newRecording(config, tree) {
  return {
    format: 'osmosis-replay',
    version: 1,
    recorded_at: new Date().toISOString(),
    provider: config.provider,
    tree: cloneJson(tree),
    entries: [],
  };
}

async function createReplayService({ config, persistence, state }) {
  const replayDocument = config.mode === 'replay' ? await loadReplayDocument(config.replayPath) : null;
  let recording = null;
  let replayIndex = 0;

  async function record(report, card) {
    if (config.mode !== 'record') {
      return;
    }

    if (!recording) {
      recording = newRecording(config, state.tree);
    }
    recording.entries.push({
      sequence: recording.entries.length + 1,
      recorded_at: new Date().toISOString(),
      trigger: {
        task: report.task,
        what_i_did: report.what_i_did,
        stack_hints: [...report.stack_hints],
      },
      card: generatedCardFromRuntime(card),
    });
    await persistence.saveReplay(recording);
  }

  function consume(report) {
    if (config.mode !== 'replay') {
      return null;
    }

    const entry = replayDocument.entries[replayIndex];
    if (!entry) {
      return null;
    }
    replayIndex += 1;
    return createRuntimeCard(entry.card, report);
  }

  return { consume, record };
}

module.exports = {
  createReplayService,
  generatedCardFromRuntime,
  loadReplayDocument,
};
