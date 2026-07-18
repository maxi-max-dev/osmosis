'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await ensureDirectory(directory);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function emptyTree() {
  return { meta: {}, nodes: [] };
}

async function loadProjectState(config, sharedStrengths = null) {
  await ensureDirectory(config.stateDir);
  const cardDocument = await readJson(path.join(config.stateDir, 'cards.json'), { cards: [] });
  const tree = await readJson(config.treePath, emptyTree());
  const strengths = sharedStrengths || await readJson(config.profilePath, {});

  return {
    cards: Array.isArray(cardDocument.cards) ? cardDocument.cards : [],
    tree: tree && Array.isArray(tree.nodes) ? tree : emptyTree(),
    strengths: strengths && typeof strengths === 'object' && !Array.isArray(strengths) ? strengths : {},
    project_id: config.projectId || config.project_id || null,
  };
}

async function saveCards(config, cards) {
  await writeJsonAtomic(path.join(config.stateDir, 'cards.json'), { cards });
}

async function saveProfile(config, strengths) {
  await writeJsonAtomic(config.profilePath, strengths);
}

async function saveReplay(config, replay) {
  await writeJsonAtomic(config.replayPath, replay);
}

async function saveTree(config, tree) {
  await writeJsonAtomic(config.treePath, tree);
}

function createPersistence(config, { profileStore = null } = {}) {
  let cardsWrite = Promise.resolve();
  let profileWrite = Promise.resolve();
  let replayWrite = Promise.resolve();
  let treeWrite = Promise.resolve();

  function enqueue(previous, work) {
    const next = previous.then(work);
    return {
      next,
      tail: next.catch(() => {}),
    };
  }

  return {
    saveCards(cards) {
      const queued = enqueue(cardsWrite, () => saveCards(config, cards));
      cardsWrite = queued.tail;
      return queued.next;
    },
    saveProfile(strengths) {
      const queued = enqueue(profileWrite, () =>
        profileStore && typeof profileStore.save === 'function'
          ? profileStore.save(strengths)
          : saveProfile(config, strengths),
      );
      profileWrite = queued.tail;
      return queued.next;
    },
    updateProfile(mutator) {
      if (profileStore && typeof profileStore.update === 'function') {
        return profileStore.update(mutator);
      }
      const queued = enqueue(profileWrite, async () => {
        const current = await readJson(config.profilePath, {});
        const result = await mutator(current);
        await saveProfile(config, current);
        return result;
      });
      profileWrite = queued.tail;
      return queued.next;
    },
    saveReplay(replay) {
      const queued = enqueue(replayWrite, () => saveReplay(config, replay));
      replayWrite = queued.tail;
      return queued.next;
    },
    saveTree(tree) {
      const queued = enqueue(treeWrite, () => saveTree(config, tree));
      treeWrite = queued.tail;
      return queued.next;
    },
  };
}

function snapshotFor(state) {
  return {
    cards: state.cards.map(cardForClient),
    tree: state.tree,
    strengths: state.strengths,
  };
}

function cardForClient(card) {
  const { correct_index, explanation, ...visibleCard } = card;

  if (card.state.answered) {
    return { ...visibleCard, explanation };
  }

  return visibleCard;
}

module.exports = {
  loadProjectState,
  saveCards,
  saveProfile,
  saveReplay,
  saveTree,
  createPersistence,
  snapshotFor,
  cardForClient,
  writeJsonAtomic,
};
