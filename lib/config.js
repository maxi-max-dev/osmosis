'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function portNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function getConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const profileDir = env.OSMOSIS_PROFILE_DIR || path.join(os.homedir(), '.osmosis');
  const sessionsDir = env.OSMOSIS_SESSIONS_DIR || path.join(os.homedir(), '.codex', 'sessions');

  return {
    cwd,
    host: env.OSMOSIS_HOST || '127.0.0.1',
    // Port 0 asks the operating system to choose a free ephemeral port. It is
    // useful for isolated local test runs and leaves the default unchanged.
    port: portNumber(env.OSMOSIS_PORT, 4321),
    provider: env.OSMOSIS_PROVIDER || 'none',
    mode: env.OSMOSIS_MODE || 'live',
    stateDir: path.join(cwd, '.osmosis'),
    treePath: path.join(cwd, '.osmosis', 'tree.json'),
    replayPath: path.join(cwd, '.osmosis', 'replay.json'),
    profileDir,
    profilePath: path.join(profileDir, 'profile.json'),
    publicDir: path.join(__dirname, '..', 'public'),
    templateDelayMs: positiveInteger(env.OSMOSIS_TEMPLATE_DELAY_MS, 900),
    cardPacingMs: portNumber(env.OSMOSIS_CARD_PACING_MS, 12_000),
    unansweredCardCap: positiveInteger(env.OSMOSIS_UNANSWERED_CARD_CAP, 5),
    codexCommand: env.OSMOSIS_CODEX_COMMAND || 'codex',
    codexTimeoutMs: positiveInteger(env.OSMOSIS_CODEX_TIMEOUT_MS, 60_000),
    sessionsDir,
    // The observer is intentionally absent when Codex session storage is not
    // present. That keeps a normal local server unchanged on machines that do
    // not use Codex, while OSMOSIS_AMBIENT=0 is an explicit privacy kill switch.
    ambientEnabled: env.OSMOSIS_AMBIENT !== '0' && isDirectory(sessionsDir),
    ambientEmitIntervalMs: positiveInteger(env.OSMOSIS_AMBIENT_EMIT_INTERVAL_MS, 45_000),
  };
}

module.exports = { getConfig, isDirectory };
