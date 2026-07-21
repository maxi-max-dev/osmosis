'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function fencePathFor(stateDir) {
  if (typeof stateDir !== 'string' || !stateDir) {
    throw new TypeError('Project write fence needs a project state directory.');
  }
  return path.join(stateDir, '.owner-epoch.json');
}

async function writeAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

async function readFence(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * A broker publishes this small, project-local marker before it hydrates a
 * channel. It is intentionally separate from cards.json: a new HTTP owner
 * can fence a paused former owner before its first project-state write.
 *
 * Publishing is last-writer-wins because only the process that already owns
 * the local HTTP port is allowed to create a broker in production. Every
 * state commit re-reads this marker after taking the cards lock, so a former
 * owner that wakes after a takeover cannot use a still-matching cards
 * revision to overwrite the new owner.
 */
function createProjectWriteFence({ stateDir, ownerEpoch, canWrite = () => true } = {}) {
  if (typeof ownerEpoch !== 'string' || !ownerEpoch) {
    throw new TypeError('Project write fence needs an owner epoch.');
  }
  if (typeof canWrite !== 'function') {
    throw new TypeError('Project write fence needs a write-authority function.');
  }
  const filePath = fencePathFor(stateDir);
  let published = false;

  function hasAuthority() {
    try {
      return canWrite() === true;
    } catch {
      return false;
    }
  }

  async function claim() {
    if (!hasAuthority()) return false;
    await writeAtomically(filePath, {
      format: 'osmosis-project-owner-v1',
      owner_epoch: ownerEpoch,
      published_at: new Date().toISOString(),
    });
    published = true;
    return owns();
  }

  async function owns() {
    if (!published || !hasAuthority()) return false;
    const current = await readFence(filePath);
    return current?.format === 'osmosis-project-owner-v1'
      && current.owner_epoch === ownerEpoch;
  }

  return {
    claim,
    fencePath: () => filePath,
    owns,
  };
}

module.exports = {
  createProjectWriteFence,
  fencePathFor,
};
