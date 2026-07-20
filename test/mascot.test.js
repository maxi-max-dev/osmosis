'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { CELEBRATE_MS, baseState, canLoadThree, mount, stateForPresentation, stop } = require('../public/mascot');
const { createHttpHandler } = require('../lib/http');

function fakeContainer() {
  return {
    innerHTML: '',
    isConnected: false,
    replaceChildren(...children) { this.children = children; },
  };
}

test('mascot never asks WebGL to run when hidden or reduced-motion, and keeps a CSS fallback', () => {
  const hiddenDocument = { hidden: true, createElement() { throw new Error('must not create WebGL'); } };
  assert.equal(canLoadThree({ documentRef: hiddenDocument, windowRef: {} }), false);
  const reducedWindow = { matchMedia: () => ({ matches: true }) };
  const visibleDocument = { hidden: false, createElement() { throw new Error('must not create WebGL'); } };
  assert.equal(canLoadThree({ documentRef: visibleDocument, windowRef: reducedWindow }), false);

  const container = fakeContainer();
  mount(container, { enabled: true, state: 'preparing', documentRef: hiddenDocument, windowRef: reducedWindow });
  assert.match(container.innerHTML, /mascot-fallback/);
  assert.match(container.innerHTML, /preparing/);
  stop();
});

test('mascot celebration is a bounded rendering window and resumes the true state', () => {
  const now = Date.now();
  assert.equal(baseState({ requestedState: 'celebrate', celebrateUntil: now + CELEBRATE_MS }, now), 'celebrate');
  assert.equal(baseState({ requestedState: 'celebrate', celebrateUntil: now - 1 }, now), 'idle');
  assert.equal(baseState({ requestedState: 'observing', celebrateUntil: 0 }, now), 'observing');
});

test('mascot celebrates only a deduped correct-answer episode, never a ready card', () => {
  stop();
  assert.equal(stateForPresentation('card-ready'), 'idle');
  const container = fakeContainer();
  const windowRef = { clearTimeout() {}, matchMedia: () => ({ matches: true }), setTimeout: () => 1 };
  const documentRef = { hidden: true, createElement() { throw new Error('no WebGL in this test'); } };
  const idle = mount(container, { documentRef, enabled: true, state: stateForPresentation('card-ready'), windowRef });
  assert.equal(baseState(idle, Date.now()), 'idle');

  const celebrated = mount(container, {
    celebrationEpisode: 'answer:project-a:card-a', documentRef, enabled: true, state: 'idle', windowRef,
  });
  const deadline = celebrated.celebrateUntil;
  assert.equal(baseState(celebrated, Date.now()), 'celebrate');
  const duplicate = mount(container, {
    celebrationEpisode: 'answer:project-a:card-a', documentRef, enabled: true, state: 'idle', windowRef,
  });
  assert.equal(duplicate.celebrateUntil, deadline, 'the same answer never restarts the one-shot celebration');
  stop();
});

test('self-hosted three stays below the 200 KiB gzip budget and carries its license', () => {
  const vendor = path.join(__dirname, '..', 'public', 'vendor', 'three.module.min.js');
  const license = path.join(__dirname, '..', 'public', 'vendor', 'THREE-LICENSE');
  const compressed = zlib.gzipSync(fs.readFileSync(vendor));
  assert.ok(compressed.length <= 200 * 1024, `three gzip was ${compressed.length} bytes`);
  assert.match(fs.readFileSync(license, 'utf8'), /MIT License/i);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'mascot.js'), 'utf8'), /import\('\/vendor\/three\.module\.min\.js'\)/);
});

test('the wall serves the mascot, self-hosted three, and its license from STATIC_FILES', async (t) => {
  const handler = createHttpHandler({
    config: { publicDir: path.join(__dirname, '..', 'public') },
    hub: { connect() {} },
    snapshot: () => ({ cards: [], strengths: {}, tree: { meta: {}, nodes: [] } }),
  });
  const server = http.createServer((request, response) => void handler(request, response));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const [mascot, three, license] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/mascot.js`),
    fetch(`http://127.0.0.1:${port}/vendor/three.module.min.js`),
    fetch(`http://127.0.0.1:${port}/vendor/THREE-LICENSE`),
  ]);
  assert.equal(mascot.status, 200);
  assert.match(mascot.headers.get('content-type'), /javascript/);
  assert.equal(three.status, 200);
  assert.match(three.headers.get('content-type'), /javascript/);
  assert.equal(license.status, 200);
  assert.match(await license.text(), /MIT License/i);
});
