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

  return {
    cwd,
    host: env.OSMOSIS_HOST || '127.0.0.1',
    // Port 0 asks the operating system to choose a free ephemeral port. It is
    // useful for isolated local test runs and leaves the default unchanged.
    port: portNumber(env.OSMOSIS_PORT, 4321),
    provider: env.OSMOSIS_PROVIDER || 'none',
    mode: env.OSMOSIS_MODE || 'live',
    stateDir: path.join(cwd, '.osmosis'),
    replayPath: path.join(cwd, '.osmosis', 'replay.json'),
    profileDir,
    profilePath: path.join(profileDir, 'profile.json'),
    publicDir: path.join(__dirname, '..', 'public'),
    templateDelayMs: positiveInteger(env.OSMOSIS_TEMPLATE_DELAY_MS, 900),
  };
}

module.exports = { getConfig };
