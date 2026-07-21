'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAnswerService } = require('../lib/answer-service');
const { createAnswerReceiptStore } = require('../lib/answer-receipt-store');
const { createProfileStore } = require('../lib/profile-store');
const { createProjectWriteFence } = require('../lib/project-write-fence');
const { createPersistence, loadProjectState } = require('../lib/state');

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-mastery-race-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function projectConfig(root, profileDir, projectId) {
  const stateDir = path.join(root, '.osmosis');
  return {
    profilePath: path.join(profileDir, 'profile.json'),
    projectId,
    replayPath: path.join(stateDir, 'replay.json'),
    stateDir,
    treePath: path.join(stateDir, 'tree.json'),
  };
}

test('a paused outgoing writer cannot clobber a takeover answer, profile, or receipt', async (t) => {
  const root = await temporaryDirectory(t);
  const profileDir = path.join(root, 'profile');
  const projectId = 'project-0123456789';
  const conceptId = `${projectId}:running`;
  const config = projectConfig(root, profileDir, projectId);
  const initialCard = {
    card_id: 'namespaced-running-card',
    concept_id: conceptId,
    concept_name: 'Running',
    correct_index: 0,
    explanation: 'A namespaced tree-leaf answer is durable.',
    options: ['Correct', 'Wrong', 'Wrong'],
    question: 'Which answer is correct?',
    state: { answered: false, chosen_index: null, correct: null },
  };
  await fs.mkdir(config.stateDir, { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(config.stateDir, 'cards.json'), `${JSON.stringify({ cards: [initialCard] }, null, 2)}\n`);
  await fs.writeFile(config.treePath, `${JSON.stringify({
    meta: {},
    nodes: [{ children: [], concept_id: conceptId, name: 'Running' }],
  }, null, 2)}\n`);

  const outgoingLoaded = await loadProjectState(config);
  const takeoverLoaded = await loadProjectState(config);
  assert.match(outgoingLoaded.cards[0].concept_id, /^project-0123456789:/);

  const oldCardsPaused = deferred();
  const oldCardsStarted = deferred();
  const oldProfilePaused = deferred();
  const oldProfileStarted = deferred();
  const outgoingProfile = createProfileStore({
    beforeWrite: async ({ kind }) => {
      if (kind === 'save') {
        oldProfileStarted.resolve();
        await oldProfilePaused.promise;
      }
    },
    profilePath: config.profilePath,
  });
  await outgoingProfile.load();
  outgoingProfile.strengths[conceptId] = {
    correct: 0,
    name: 'Running',
    seen: 1,
    strength: 1,
    updated_at: '2026-07-19T00:00:00.000Z',
  };
  const outgoingPersistence = createPersistence(config, {
    beforeCardsWrite: async () => {
      oldCardsStarted.resolve();
      await oldCardsPaused.promise;
    },
    // This intentionally models an already-running stale task that reaches
    // persistence after ownership has moved. The revision fence must still
    // reject it even if that task failed to observe the owner transition.
    canCommit: () => true,
    initialCardsRevision: outgoingLoaded.cards_revision,
    writeEpoch: 'outgoing-owner',
  });
  const staleProfileWrite = outgoingProfile.save();
  const staleCardsWrite = outgoingPersistence.saveCards(outgoingLoaded.cards);
  await Promise.all([oldProfileStarted.promise, oldCardsStarted.promise]);

  const takeoverProfile = createProfileStore({ profilePath: config.profilePath });
  await takeoverProfile.load();
  const takeoverState = await loadProjectState(config, takeoverProfile.strengths);
  const takeoverPersistence = createPersistence(config, {
    initialCardsRevision: takeoverState.cards_revision,
    profileStore: takeoverProfile,
    writeEpoch: 'takeover-owner',
  });
  const receiptStore = createAnswerReceiptStore({ profileDir });
  const answerService = createAnswerService({
    answerReceiptStore: receiptStore,
    cardService: {
      clearPendingByConcept: () => 0,
      persistCards: () => takeoverPersistence.saveCards(takeoverState.cards),
      queueRequeue: () => {},
    },
    hub: { broadcast: () => {} },
    persistence: takeoverPersistence,
    profileStore: takeoverProfile,
    projectId,
    state: takeoverState,
  });
  const answer = await answerService.answer({ card_id: initialCard.card_id, chosen_index: 0 });
  assert.equal(answer.strength, 2);

  oldProfilePaused.resolve();
  oldCardsPaused.resolve();
  await staleProfileWrite;
  await assert.rejects(staleCardsWrite, (error) => error?.code === 'ESTALEWRITE');

  const persistedProfile = JSON.parse(await fs.readFile(config.profilePath, 'utf8'));
  const persistedCards = JSON.parse(await fs.readFile(path.join(config.stateDir, 'cards.json'), 'utf8'));
  const persistedCard = persistedCards.cards.find((card) => card.card_id === initialCard.card_id);
  const receipt = await receiptStore.find(persistedCard.answer_receipt.receipt_id);
  assert.equal(persistedProfile[conceptId].strength, 2);
  assert.equal(persistedCard.state.answered, true);
  assert.equal(persistedCard.state.correct, true);
  assert.equal(receipt.card_id, initialCard.card_id);
  assert.equal(receipt.concept_id, conceptId);
  assert.equal(receipt.resulting_strength, 2);
});

test('a new owner fences a paused predecessor before its first cards commit', async (t) => {
  const root = await temporaryDirectory(t);
  const profileDir = path.join(root, 'profile');
  const projectId = 'project-0123456789';
  const conceptId = `${projectId}:running`;
  const config = projectConfig(root, profileDir, projectId);
  const initialCard = {
    card_id: 'first-write-window-card',
    concept_id: conceptId,
    concept_name: 'Running',
    correct_index: 1,
    explanation: 'The new owner finishes the durable answer.',
    options: ['Wrong', 'Correct', 'Wrong'],
    question: 'Which answer is correct?',
    state: { answered: false, chosen_index: null, correct: null },
  };
  await fs.mkdir(config.stateDir, { recursive: true });
  await fs.mkdir(profileDir, { recursive: true });
  await fs.writeFile(path.join(config.stateDir, 'cards.json'), `${JSON.stringify({ cards: [initialCard] }, null, 2)}\n`);
  await fs.writeFile(config.treePath, `${JSON.stringify({
    meta: {},
    nodes: [{ children: [], concept_id: conceptId, name: 'Running' }],
  }, null, 2)}\n`);

  const outgoingFence = createProjectWriteFence({
    ownerEpoch: 'outgoing-owner',
    stateDir: config.stateDir,
  });
  assert.equal(await outgoingFence.claim(), true);
  const outgoingState = await loadProjectState(config);
  const staleCardsPaused = deferred();
  const staleCardsStarted = deferred();
  outgoingState.cards[0].obsolete_writer_marker = true;
  const outgoingPersistence = createPersistence(config, {
    beforeCardsWrite: async () => {
      staleCardsStarted.resolve();
      await staleCardsPaused.promise;
    },
    canCommit: () => outgoingFence.owns(),
    initialCardsRevision: outgoingState.cards_revision,
    writeEpoch: 'outgoing-owner',
  });
  const staleCardsWrite = outgoingPersistence.saveCards(outgoingState.cards);
  await staleCardsStarted.promise;

  // B claims before hydration, but has not written cards.json. This is the
  // exact first-write window that a revision-only guard could not close.
  const takeoverFence = createProjectWriteFence({
    ownerEpoch: 'takeover-owner',
    stateDir: config.stateDir,
  });
  assert.equal(await takeoverFence.claim(), true);
  const takeoverProfile = createProfileStore({ profilePath: config.profilePath });
  await takeoverProfile.load();
  const takeoverState = await loadProjectState(config, takeoverProfile.strengths);
  assert.equal(takeoverState.cards_revision, outgoingState.cards_revision, 'B only hydrated; it has not committed cards yet');
  assert.equal(takeoverState.cards[0].obsolete_writer_marker, undefined);

  // A resumes after B hydrated and before B makes its first cards commit.
  // The durable owner fence, checked under the cards lock, refuses A.
  staleCardsPaused.resolve();
  await assert.rejects(staleCardsWrite, (error) => error?.code === 'EOWNERLEASE');

  const takeoverPersistence = createPersistence(config, {
    canCommit: () => takeoverFence.owns(),
    initialCardsRevision: takeoverState.cards_revision,
    profileStore: takeoverProfile,
    writeEpoch: 'takeover-owner',
  });
  const receiptStore = createAnswerReceiptStore({ profileDir });
  const answerService = createAnswerService({
    answerReceiptStore: receiptStore,
    cardService: {
      clearPendingByConcept: () => 0,
      persistCards: () => takeoverPersistence.saveCards(takeoverState.cards),
      queueRequeue: () => {},
    },
    hub: { broadcast: () => {} },
    persistence: takeoverPersistence,
    profileStore: takeoverProfile,
    projectId,
    state: takeoverState,
  });
  const answer = await answerService.answer({ card_id: initialCard.card_id, chosen_index: 1 });
  assert.equal(answer.strength, 2);

  const persistedProfile = JSON.parse(await fs.readFile(config.profilePath, 'utf8'));
  const persistedCards = JSON.parse(await fs.readFile(path.join(config.stateDir, 'cards.json'), 'utf8'));
  const persistedCard = persistedCards.cards.find((card) => card.card_id === initialCard.card_id);
  const receipt = await receiptStore.find(persistedCard.answer_receipt.receipt_id);
  assert.equal(persistedProfile[conceptId].strength, 2);
  assert.equal(persistedCard.state.answered, true);
  assert.equal(persistedCard.state.correct, true);
  assert.equal(persistedCard.obsolete_writer_marker, undefined);
  assert.equal(receipt.receipt_id, persistedCard.answer_receipt.receipt_id);
  assert.equal(receipt.resulting_strength, 2);
});

test('a current owner rebases a same-epoch interleaved cards write without masking another owner', async (t) => {
  const root = await temporaryDirectory(t);
  const profileDir = path.join(root, 'profile');
  const projectId = 'project-0123456789';
  const config = projectConfig(root, profileDir, projectId);
  const cards = [{
    card_id: 'same-owner-card',
    concept_id: `${projectId}:http`,
    marks: [],
    state: { answered: false, chosen_index: null, correct: null },
  }];
  await fs.mkdir(config.stateDir, { recursive: true });
  await fs.writeFile(path.join(config.stateDir, 'cards.json'), `${JSON.stringify({ cards }, null, 2)}\n`);
  const loaded = await loadProjectState(config);
  const firstPaused = deferred();
  const firstStarted = deferred();
  const first = createPersistence(config, {
    beforeCardsWrite: async () => {
      firstStarted.resolve();
      await firstPaused.promise;
    },
    initialCardsRevision: loaded.cards_revision,
    writeEpoch: 'current-owner',
  });
  const sibling = createPersistence(config, {
    initialCardsRevision: loaded.cards_revision,
    writeEpoch: 'current-owner',
  });

  const firstWrite = first.saveCards(loaded.cards);
  await firstStarted.promise;
  loaded.cards[0].marks.push('sibling');
  await sibling.saveCards(loaded.cards);
  loaded.cards[0].marks.push('rebased');
  firstPaused.resolve();
  await firstWrite;

  const persisted = JSON.parse(await fs.readFile(path.join(config.stateDir, 'cards.json'), 'utf8'));
  assert.equal(persisted.write_epoch, 'current-owner');
  assert.deepEqual(persisted.cards[0].marks, ['sibling', 'rebased']);
});
