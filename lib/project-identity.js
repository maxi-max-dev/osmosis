'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Resolve the physical location of a project path. Keeping this separate from
 * resolveRoot makes it safe for the registration boundary to canonicalize a
 * path once, before it becomes broker state.
 */
async function canonicalizePath(cwd) {
  return fs.realpath(cwd);
}

async function findGitRoot(canonicalCwd) {
  let candidate = canonicalCwd;
  while (true) {
    // A worktree may use a .git *file*, while a normal repository uses a
    // directory. lstat deliberately accepts either form.
    if (await pathExists(path.join(candidate, '.git'))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

function safeProjectName(root) {
  const raw = path.basename(root) || 'project';
  const safe = raw
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return safe || 'project';
}

function projectIdForRoot(root) {
  const name = safeProjectName(root);
  const digest = createHash('sha1').update(root).digest('hex').slice(0, 10);
  return `${name}-${digest}`;
}

/**
 * Pick the stable identity for a project channel.
 *
 * A launch inside a repository normally belongs to its nearest git root. An
 * existing state directory in a subdirectory is intentionally stronger than
 * that default: earlier Osmosis installs stored state there and must continue
 * to open the same wall after the broker upgrade.
 */
async function resolveProjectIdentity(cwd) {
  const canonicalCwd = await canonicalizePath(cwd);
  const gitRoot = await findGitRoot(canonicalCwd);
  const hasLegacyState =
    gitRoot &&
    canonicalCwd !== gitRoot &&
    (await pathExists(path.join(canonicalCwd, '.osmosis')));
  const root = hasLegacyState ? canonicalCwd : gitRoot || canonicalCwd;

  return {
    project_id: projectIdForRoot(root),
    root,
    name: path.basename(root) || safeProjectName(root),
    canonical_cwd: canonicalCwd,
    git_root: gitRoot,
    legacy_state_root: Boolean(hasLegacyState),
  };
}

async function resolveRoot(cwd) {
  return (await resolveProjectIdentity(cwd)).root;
}

module.exports = {
  canonicalizePath,
  findGitRoot,
  pathExists,
  projectIdForRoot,
  resolveProjectIdentity,
  resolveRoot,
  safeProjectName,
};
