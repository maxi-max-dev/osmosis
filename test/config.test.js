'use strict';

const assert = require('node:assert/strict');
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
