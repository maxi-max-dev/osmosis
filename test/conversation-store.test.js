'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createConversationStore } = require('../lib/conversation-store');
const { createRuntimeCard } = require('../lib/card-factory');
const { createBroker } = require('../lib/broker');
const { CAPTURE_AGENT_REPORTS_ONLY } = require('../lib/settings-store');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-conversation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('local conversation titles use a truncated opaque HMAC id and expire without entering cards', async (t) => {
  const directory = await temporaryDirectory(t);
  let now = Date.parse('2026-07-20T00:00:00.000Z');
  const store = createConversationStore({ profileDir: directory, now: () => now });
  const rawSession = 'session-id-that-must-never-leave-private-storage';
  const rawTitle = '<script>alert(1)</script> a deliberately long local conversation title';
  const id = await store.observe({ enabled: true, sessionId: rawSession, title: rawTitle });
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.notEqual(id, rawSession);
  const titles = await store.titlesFor([id], { enabled: true });
  assert.equal(titles[id], rawTitle.slice(0, 30));
  assert.ok(titles[id].length <= 30);
  const documentText = await fs.readFile(store.filePath, 'utf8');
  assert.doesNotMatch(documentText, new RegExp(rawSession));
  assert.match(documentText, /<script>/, 'raw title stays in the separate local title table only');
  const stat = await fs.stat(store.filePath);
  assert.equal(stat.mode & 0o777, 0o600);

  const card = createRuntimeCard({
    concept_id: 'scoped:fetch', concept_name: 'fetch', lesson: 'Lesson', question: 'Question?',
    options: ['A', 'B', 'C'], correct_index: 0, explanation: 'Why.',
  }, { task: 'Milestone', what_i_did: 'Worked.', stack_hints: ['fetch'], conversation_id: id });
  assert.equal(card.source.conversation_id, id);
  assert.doesNotMatch(JSON.stringify(card), new RegExp(rawSession));
  assert.doesNotMatch(JSON.stringify(card), /<script>/);

  now += 8 * 24 * 60 * 60 * 1_000;
  assert.deepEqual(await store.titlesFor([id], { enabled: true }), {});
});

test('turning local conversation titles off clears the private table immediately', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = createConversationStore({ profileDir: directory });
  const id = await store.observe({ enabled: true, sessionId: 'session-1', title: 'A local title' });
  assert.deepEqual(await store.titlesFor([id], { enabled: true }), { [id]: 'A local title' });
  await store.clear();
  assert.deepEqual(await store.titlesFor([id], { enabled: true }), {});
  const persisted = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  assert.deepEqual(persisted.titles, {});
});

test('the broker converts ambient context to an opaque card id and never writes a title to ledger, replay, MCP, or inline HTML', async (t) => {
  const root = await temporaryDirectory(t);
  const profileDir = path.join(root, 'profile');
  const config = {
    ambientEnabled: false, cardPacingMs: 1, cwd: root, globalReportQueueCap: 5,
    host: '127.0.0.1', mode: 'live', port: 4321, profileDir,
    profilePath: path.join(profileDir, 'profile.json'), provider: 'none',
    replayPath: path.join(root, '.osmosis', 'replay.json'), settingsPath: path.join(profileDir, 'settings.json'),
    stateDir: path.join(root, '.osmosis'), templateDelayMs: 60_000,
    treePath: path.join(root, '.osmosis', 'tree.json'), unansweredCardCap: 5,
  };
  const broker = createBroker({ config, hub: { broadcast() {} } });
  t.after(() => broker.close());
  await broker.initialize();
  await broker.startOwner();
  const projectId = broker.defaultProjectId;
  await broker.activateProject(projectId, { carry: true, capture_mode: CAPTURE_AGENT_REPORTS_ONLY, lesson_locale: 'en' });
  await broker.updateSettings({ local_conversation_titles: true });
  const rawSession = 'private-session-id-987';
  const rawTitle = '<b>Max private task</b> and details';
  await broker.acceptLocalReport({
    task: 'Observed local activity', what_i_did: 'Observed a safe local action.', stack_hints: ['rg'],
    source: 'observed', observed_kind: 'change',
    __osmosis_local_conversation: { session_id: rawSession, title: rawTitle },
  });
  await broker.whenIdle();
  const channel = await broker.ensureChannel(projectId);
  const card = channel.state.cards.find((item) => item?.source?.conversation_id);
  assert.ok(card, 'the observed report creates a card with its opaque conversation id');
  assert.match(card.source.conversation_id, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(card), /private-session-id|Max private task|<b>/);
  const titleResponse = await broker.conversationTitles([card.source.conversation_id]);
  assert.equal(titleResponse.titles[card.source.conversation_id], rawTitle.slice(0, 30));
  const ledger = await fs.readFile(path.join(profileDir, 'ledger', `${projectId}.jsonl`), 'utf8');
  assert.doesNotMatch(ledger, /private-session-id|Max private task|<b>/);
  const inline = await broker.inlineCardHtml(projectId);
  assert.doesNotMatch(inline, /private-session-id|Max private task|<b>/);
  await broker.updateSettings({ local_conversation_titles: false });
  assert.deepEqual((await broker.conversationTitles([card.source.conversation_id])).titles, {});
});
