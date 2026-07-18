'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getConfig } = require('../lib/config');

test('OSMOSIS_PROFILE_DIR overrides the user-level mastery location', () => {
  const profileDir = path.join('/tmp', 'osmosis-isolated-profile');
  const config = getConfig({
    cwd: path.join('/tmp', 'osmosis-project'),
    env: { OSMOSIS_PROFILE_DIR: profileDir },
  });

  assert.equal(config.profileDir, profileDir);
  assert.equal(config.profilePath, path.join(profileDir, 'profile.json'));
});

test('profile storage defaults to ~/.osmosis when no override is supplied', () => {
  const config = getConfig({ cwd: path.join('/tmp', 'osmosis-project'), env: {} });
  const expectedProfileDir = path.join(os.homedir(), '.osmosis');

  assert.equal(config.profileDir, expectedProfileDir);
  assert.equal(config.profilePath, path.join(expectedProfileDir, 'profile.json'));
});

test('Ambient Watch is enabled only for an available sessions directory and honours its kill switch', async (t) => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-sessions-'));
  t.after(() => fs.rm(sessionsDir, { recursive: true, force: true }));

  const enabled = getConfig({
    cwd: path.join('/tmp', 'osmosis-project'),
    env: {
      OSMOSIS_SESSIONS_DIR: sessionsDir,
      OSMOSIS_AMBIENT_EMIT_INTERVAL_MS: '12345',
    },
  });
  assert.equal(enabled.sessionsDir, sessionsDir);
  assert.equal(enabled.ambientEnabled, true);
  assert.equal(enabled.ambientEmitIntervalMs, 12345);

  const disabled = getConfig({
    cwd: path.join('/tmp', 'osmosis-project'),
    env: { OSMOSIS_SESSIONS_DIR: sessionsDir, OSMOSIS_AMBIENT: '0' },
  });
  assert.equal(disabled.ambientEnabled, false);

  const missing = getConfig({
    cwd: path.join('/tmp', 'osmosis-project'),
    env: { OSMOSIS_SESSIONS_DIR: path.join(sessionsDir, 'not-here') },
  });
  assert.equal(missing.ambientEnabled, false);
  assert.equal(missing.ambientEmitIntervalMs, 45_000);
});
