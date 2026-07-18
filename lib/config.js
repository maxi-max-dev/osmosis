'use strict';

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

function getConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const profileDir = env.OSMOSIS_PROFILE_DIR || path.join(os.homedir(), '.osmosis');
  // Codex stores rollout files below its configured home. Keeping this
  // derivation here also means an isolated CODEX_HOME used by a subprocess is
  // naturally isolated from the user's normal session history.
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessionsDir = env.OSMOSIS_SESSIONS_DIR || path.join(codexHome, 'sessions');

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
    portRetryMs: positiveInteger(env.OSMOSIS_PORT_RETRY_MS, 15_000),
    // Keep the resolved home available to the Codex generator as well as the
    // Ambient Watch session-directory derivation. The generator seeds only
    // the credentials/config it needs into its own isolated child home.
    codexHome,
    sessionsDir,
    // Ambient Watch is deliberately an explicit opt-in. The watcher safely
    // treats a not-yet-created sessions directory as empty, so a Codex
    // session that starts later can still be observed without a restart.
    ambientEnabled: env.OSMOSIS_AMBIENT === '1',
    ambientEmitIntervalMs: positiveInteger(env.OSMOSIS_AMBIENT_EMIT_INTERVAL_MS, 45_000),
  };
}

module.exports = { getConfig };
