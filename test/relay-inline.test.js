'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRelayInlineCardResolver } = require('../lib/relay-inline');

test('a relay proxies its registered project inline card without hydrating local state', async () => {
  const localCalls = [];
  const proxyCalls = [];
  const proxy = createRelayInlineCardResolver({
    getBroker: () => ({
      defaultProjectId: 'default-0123456789',
      async inlineCardHtml(projectId) {
        localCalls.push(projectId);
        return `<main>local ${projectId}</main>`;
      },
    }),
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
});

test('an unregistered relay returns a static reconnecting card without a local or owner lookup', async () => {
  const localCalls = [];
  const proxyCalls = [];
  const resolver = createRelayInlineCardResolver({
    getBroker: () => ({
      defaultProjectId: 'default-0123456789',
      async inlineCardHtml(projectId) {
        localCalls.push(projectId);
        return `<main>local ${projectId}</main>`;
      },
    }),
    fetchImpl: async (url) => {
      proxyCalls.push(url);
      return { ok: true, text: async () => '<main>owner card</main>' };
    },
    getBaseUrl: () => 'http://127.0.0.1:4321',
    getDelivery: () => 'relay',
    getRelayIdentity: () => null,
  });

  const html = await resolver();
  assert.match(html, /data-osmosis-inline-card="pending"/);
  assert.match(html, /Osmosis 正在留意/);
  assert.match(html, /http:\/\/127\.0\.0\.1:4321\/inline-card/);
  assert.deepEqual(proxyCalls, []);
  assert.deepEqual(localCalls, []);
});

test('a relay returns the same static reconnecting card when its owner proxy fails', async () => {
  const localCalls = [];
  const resolver = createRelayInlineCardResolver({
    getBroker: () => ({
      async inlineCardHtml(projectId) {
        localCalls.push(projectId);
        return `<main>local ${projectId}</main>`;
      },
    }),
    fetchImpl: async () => {
      throw new Error('owner restarting');
    },
    getBaseUrl: () => 'http://127.0.0.1:4321',
    getDelivery: () => 'relay',
    getRelayIdentity: () => ({ project_id: 'ferry-viewer-0123456789' }),
  });

  const html = await resolver();
  assert.match(html, /data-osmosis-inline-card="pending"/);
  assert.match(html, /inline-card\?project=ferry-viewer-0123456789/);
  assert.deepEqual(localCalls, []);
});

test('a primary uses its live broker renderer', async () => {
  const calls = [];
  const broker = {
    defaultProjectId: 'default-0123456789',
    async inlineCardHtml(projectId) {
      calls.push(projectId);
      return `<main>primary ${projectId}</main>`;
    },
  };
  const resolver = createRelayInlineCardResolver({
    getBroker: () => broker,
    getBaseUrl: () => 'http://127.0.0.1:4321',
    getDelivery: () => 'primary',
  });

  assert.equal(await resolver(), '<main>primary default-0123456789</main>');
  assert.equal(await resolver('ferry-viewer-0123456789'), '<main>primary ferry-viewer-0123456789</main>');
  assert.deepEqual(calls, ['default-0123456789', 'ferry-viewer-0123456789']);
});
