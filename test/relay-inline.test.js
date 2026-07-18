'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRelayInlineCardResolver } = require('../lib/relay-inline');

test('a relay proxies its registered project inline card and silently falls back to local state', async () => {
  const localCalls = [];
  const broker = {
    defaultProjectId: 'default-0123456789',
    async inlineCardHtml(projectId) {
      localCalls.push(projectId);
      return `<main>local ${projectId}</main>`;
    },
  };
  const proxyCalls = [];
  const proxy = createRelayInlineCardResolver({
    broker,
    fetchImpl: async (url) => {
      proxyCalls.push(url);
      return { ok: true, text: async () => '<main>broker card</main>' };
    },
    getBaseUrl: () => 'http://127.0.0.1:4321',
    getDelivery: () => 'relay',
    getRelayIdentity: () => ({ project_id: 'ferry-viewer-0123456789' }),
  });
  assert.equal(await proxy(), '<main>broker card</main>');
  assert.deepEqual(localCalls, []);
  assert.deepEqual(proxyCalls, ['http://127.0.0.1:4321/inline-card?project=ferry-viewer-0123456789']);

  const fallback = createRelayInlineCardResolver({
    broker,
    fetchImpl: async () => {
      throw new Error('owner restarting');
    },
    getBaseUrl: () => 'http://127.0.0.1:4321',
    getDelivery: () => 'relay',
    getRelayIdentity: () => ({ project_id: 'ferry-viewer-0123456789' }),
  });
  assert.equal(await fallback(), '<main>local ferry-viewer-0123456789</main>');
  assert.deepEqual(localCalls, ['ferry-viewer-0123456789']);
});
