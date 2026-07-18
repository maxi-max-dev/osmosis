'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAmbientWatcher, dateDirectories, signalsFromEvent } = require('../lib/ambient');

function execEvent(cmd, workdir = '/tmp/sydney-harbour') {
  return {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      input: JSON.stringify({ cmd, workdir }),
    },
  };
}

function patchEvent(changes, success = true) {
  return {
    type: 'event_msg',
    payload: { type: 'patch_apply_end', changes, success },
  };
}

function mcpEvent(server, tool) {
  return {
    type: 'event_msg',
    payload: { type: 'mcp_tool_call_end', invocation: { server, tool } },
  };
}

async function createRollout(sessionsDir, timestamp, initialEvents = []) {
  const directory = dateDirectories(sessionsDir, timestamp)[0];
  const filePath = path.join(directory, 'rollout-ambient-test.jsonl');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(filePath, initialEvents.map((event) => JSON.stringify(event)).join('\n') + (initialEvents.length ? '\n' : ''));
  await fs.utimes(filePath, new Date(timestamp), new Date(timestamp));
  return filePath;
}

async function appendEvents(filePath, timestamp, events) {
  await fs.appendFile(filePath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  await fs.utimes(filePath, new Date(timestamp), new Date(timestamp));
}

test('Ambient Watch extracts only qualifying metadata signals and ignores quiet or self-referential events', () => {
  const exec = signalsFromEvent(execEvent('npx vite --host local-secret.example'))[0];
  assert.equal(exec.label, 'ran npm and vite');
  assert.deepEqual(exec.hints, ['npm', 'vite']);
  assert.equal(exec.workdir, '/tmp/sydney-harbour');

  const patch = signalsFromEvent(
    patchEvent({
      '/private/project/src/scene.ts': 'this must never be read',
      '/private/project/public/map.css': 'nor this',
    }),
  )[0];
  assert.equal(patch.label, 'changed scene.ts, map.css');
  assert.deepEqual(patch.hints, ['.ts', '.css']);

  assert.deepEqual(signalsFromEvent(execEvent('pwd')), []);
  assert.deepEqual(signalsFromEvent(mcpEvent('osmosis', 'osmosis_report')), []);
  assert.equal(signalsFromEvent(mcpEvent('github', 'search_code'))[0].label, 'used github.search_code');
});

test('Ambient Watch attaches at EOF, emits a fast metadata-only card, then paces aggregated signals per session', async (t) => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-ambient-'));
  t.after(() => fs.rm(sessionsDir, { recursive: true, force: true }));
  let clock = Date.now();
  const reports = [];
  const rollout = await createRollout(sessionsDir, clock, [execEvent('node old-history.js')]);
  const watcher = createAmbientWatcher({
    config: {
      ambientEnabled: true,
      ambientEmitIntervalMs: 45_000,
      cwd: '/tmp/fallback-project',
      sessionsDir,
    },
    now: () => clock,
    onReport: (report) => reports.push(report),
  });

  // The event already in a fresh log is history, not a new lesson.
  await watcher.poll();
  assert.deepEqual(reports, []);

  await appendEvents(rollout, clock, [
    execEvent('npx vite --host local-secret.example', '/private/sydney-map'),
    patchEvent({ '/private/sydney-map/src/scene.ts': 'private source contents' }),
    mcpEvent('browser', 'open_page'),
    mcpEvent('osmosis', 'osmosis_report'),
    execEvent('ls'),
  ]);
  await watcher.poll();
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].source, 'observed');
  assert.equal(reports[0].task, 'Observed work in sydney-map');
  assert.match(reports[0].what_i_did, /ran npm and vite/);
  assert.match(reports[0].what_i_did, /changed scene.ts/);
  assert.match(reports[0].what_i_did, /used browser.open_page/);
  assert.match(reports[0].what_i_did, /sydney-map/);
  assert.doesNotMatch(JSON.stringify(reports[0]), /local-secret|private source contents|\/private\/sydney-map/);
  assert.deepEqual(reports[0].stack_hints, ['npm', 'vite', '.ts', 'browser.open_page']);

  // Several later signals are held together until the configured session
  // interval expires, then become one second observed report.
  clock += 1_000;
  await appendEvents(rollout, clock, [
    execEvent('node build.js', '/private/sydney-map'),
    patchEvent({ '/private/sydney-map/src/route.css': 'private source contents' }),
    mcpEvent('github', 'search_issues'),
  ]);
  await watcher.poll();
  assert.equal(reports.length, 1);

  clock += 45_000;
  await fs.utimes(rollout, new Date(clock), new Date(clock));
  await watcher.poll();
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[1].stack_hints, ['node', '.css', 'github.search_issues']);
  watcher.stop();
});

test('Ambient Watch contains parse, delivery, and timer failures without retaining a polling timer after stop', async (t) => {
  const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-ambient-'));
  t.after(() => fs.rm(sessionsDir, { recursive: true, force: true }));
  const logs = [];
  let clock = Date.now();
  const rollout = await createRollout(sessionsDir, clock);
  const interval = { unref() {} };
  let scheduled = 0;
  let cleared = 0;
  const watcher = createAmbientWatcher({
    config: { ambientEnabled: true, ambientEmitIntervalMs: 1, cwd: '/tmp/project', sessionsDir },
    now: () => clock,
    onReport() {
      throw new Error('delivery failure');
    },
    log: (...args) => logs.push(args.join(' ')),
    timers: {
      setInterval() {
        scheduled += 1;
        return interval;
      },
      clearInterval(value) {
        assert.equal(value, interval);
        cleared += 1;
      },
    },
  });

  await watcher.poll();
  await fs.appendFile(rollout, '{not valid json}\n' + JSON.stringify(execEvent('node build.js')) + '\n');
  await fs.utimes(rollout, new Date(clock), new Date(clock));
  await watcher.poll();
  assert.equal(logs.some((entry) => entry.includes('ambient watcher could not deliver a report')), true);

  watcher.start();
  watcher.stop();
  assert.equal(scheduled, 1);
  assert.equal(cleared, 1);
  clock += 1_000;
  await appendEvents(rollout, clock, [execEvent('node after-stop.js')]);
  await watcher.poll();
  assert.equal(cleared, 1);
});
