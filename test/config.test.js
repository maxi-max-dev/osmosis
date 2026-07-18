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

test('Ambient Watch is an explicit opt-in even before its sessions directory exists', async (t) => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-sessions-'));
  t.after(() => fs.rm(sessionsDir, { recursive: true, force: true }));

  const absent = getConfig({
    cwd: path.join('/tmp', 'osmosis-project'),
    env: {
      OSMOSIS_SESSIONS_DIR: sessionsDir,
      OSMOSIS_AMBIENT_EMIT_INTERVAL_MS: '12345',
    },
  });
  assert.equal(absent.sessionsDir, sessionsDir);
  assert.equal(absent.ambientEnabled, false);
  assert.equal(absent.ambientEmitIntervalMs, 12345);

  const enabled = getConfig({
    cwd: path.join('/tmp', 'osmosis-project'),
    env: { OSMOSIS_SESSIONS_DIR: sessionsDir, OSMOSIS_AMBIENT: '1' },
  });
  assert.equal(enabled.ambientEnabled, true);

  for (const value of ['0', 'true', 'yes', '2']) {
    const disabled = getConfig({
      cwd: path.join('/tmp', 'osmosis-project'),
      env: { OSMOSIS_SESSIONS_DIR: sessionsDir, OSMOSIS_AMBIENT: value },
    });
    assert.equal(disabled.ambientEnabled, false);
  }

  const missing = getConfig({
    cwd: path.join('/tmp', 'osmosis-project'),
    env: { OSMOSIS_SESSIONS_DIR: path.join(sessionsDir, 'not-here'), OSMOSIS_AMBIENT: '1' },
  });
  assert.equal(missing.ambientEnabled, true);
  assert.equal(missing.ambientEmitIntervalMs, 45_000);
});

test('Ambient Watch derives its default session directory from CODEX_HOME', async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-codex-home-'));
  const sessionsDir = path.join(codexHome, 'sessions');
  await fs.mkdir(sessionsDir);
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));

  const configured = getConfig({
    cwd: path.join('/tmp', 'osmosis-project'),
    env: { CODEX_HOME: codexHome, OSMOSIS_AMBIENT: '1', OSMOSIS_PORT_RETRY_MS: '15001' },
  });
  assert.equal(configured.sessionsDir, sessionsDir);
  assert.equal(configured.ambientEnabled, true);
  assert.equal(configured.portRetryMs, 15001);

  const fallback = getConfig({ cwd: path.join('/tmp', 'osmosis-project'), env: {} });
  assert.equal(fallback.sessionsDir, path.join(os.homedir(), '.codex', 'sessions'));
  assert.equal(fallback.portRetryMs, 15_000);
});
