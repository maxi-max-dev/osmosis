'use strict';

const { createHmac, randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TITLE_LENGTH = 30;

function boundedTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
}

function emptyDocument() {
  return {
    version: 1,
    // This secret is installation-local. It turns an otherwise identifying
    // rollout session id into an opaque, stable browser lookup key.
    secret: randomBytes(32).toString('base64url'),
    titles: {},
  };
}

function normalizeDocument(value) {
  const fallback = emptyDocument();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const secret = typeof value.secret === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(value.secret)
    ? value.secret
    : fallback.secret;
  const titles = {};
  if (value.titles && typeof value.titles === 'object' && !Array.isArray(value.titles)) {
    for (const [conversationId, record] of Object.entries(value.titles)) {
      if (!/^[a-f0-9]{24,64}$/i.test(conversationId) || !record || typeof record !== 'object') continue;
      const title = boundedTitle(record.title);
      const expiresAt = Number(record.expires_at);
      if (!title || !Number.isFinite(expiresAt)) continue;
      titles[conversationId] = {
        title,
        expires_at: expiresAt,
        updated_at: typeof record.updated_at === 'string' ? record.updated_at.slice(0, 64) : null,
      };
    }
  }
  return { version: 1, secret, titles };
}

async function writeAtomic(filePath, value, fsApi = fs) {
  const directory = path.dirname(filePath);
  await fsApi.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fsApi.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsApi.rename(temporary, filePath);
    // Small in-memory fs doubles used by callers need only the read/write
    // surface. Real local files are tightened to 0600 after publication.
    if (typeof fsApi.chmod === 'function') {
      await fsApi.chmod(filePath, 0o600).catch(() => {});
    }
  } catch (error) {
    await fsApi.unlink(temporary).catch(() => {});
    throw error;
  }
}

function opaqueConversationId(secret, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
  return createHmac('sha256', secret).update(sessionId.trim()).digest('hex').slice(0, 32);
}

/**
 * Private local title storage.  The only value that ever leaves this module
 * is an opaque HMAC id or a sanitized, explicitly enabled title.  Neither a
 * raw Codex session id nor the title belongs in a card, ledger, replay file,
 * MCP payload, or inline card.
 */
function createConversationStore({ profileDir, filePath, fsApi = fs, now = () => Date.now() } = {}) {
  if (typeof filePath !== 'string' && typeof profileDir !== 'string') {
    throw new TypeError('createConversationStore needs profileDir or filePath.');
  }
  const storagePath = filePath || path.join(profileDir, 'conversation-titles.json');
  let document = null;
  let writeTail = Promise.resolve();

  async function load() {
    if (document) return document;
    try {
      document = normalizeDocument(JSON.parse(await fsApi.readFile(storagePath, 'utf8')));
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        if (!(error instanceof SyntaxError)) throw error;
      }
      document = emptyDocument();
    }
    return document;
  }

  function enqueue(work) {
    const next = writeTail.then(work);
    writeTail = next.catch(() => {});
    return next;
  }

  async function persist() {
    await writeAtomic(storagePath, document, fsApi);
  }

  async function observe({ sessionId, title, enabled = false } = {}) {
    await load();
    const conversationId = opaqueConversationId(document.secret, sessionId);
    if (!conversationId) return null;
    if (enabled !== true) return conversationId;
    const safeTitle = boundedTitle(title);
    if (!safeTitle) return conversationId;
    await enqueue(async () => {
      const current = now();
      document.titles[conversationId] = {
        title: safeTitle,
        expires_at: current + CONVERSATION_TTL_MS,
        updated_at: new Date(current).toISOString(),
      };
      await persist();
    });
    return conversationId;
  }

  async function titlesFor(ids, { enabled = false } = {}) {
    await load();
    if (enabled !== true) return {};
    const current = now();
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => /^[a-f0-9]{24,64}$/i.test(id)))].slice(0, 40);
    const result = {};
    let expired = false;
    for (const id of wanted) {
      const record = document.titles[id];
      if (!record) continue;
      if (record.expires_at <= current) {
        delete document.titles[id];
        expired = true;
        continue;
      }
      result[id] = record.title;
    }
    if (expired) {
      await enqueue(persist);
    }
    return result;
  }

  async function clear() {
    await load();
    await enqueue(async () => {
      document.titles = {};
      await persist();
    });
  }

  return {
    clear,
    get filePath() { return storagePath; },
    observe,
    titlesFor,
    whenIdle: () => writeTail,
  };
}

module.exports = {
  CONVERSATION_TTL_MS,
  MAX_TITLE_LENGTH,
  boundedTitle,
  createConversationStore,
  opaqueConversationId,
};
