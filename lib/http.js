'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { log } = require('./log');
const { validateReport } = require('./mcp');

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/project-labels.js', { file: 'project-labels.js', type: 'text/javascript; charset=utf-8' }],
  ['/project-state.js', { file: 'project-state.js', type: 'text/javascript; charset=utf-8' }],
  ['/studio-state.js', { file: 'studio-state.js', type: 'text/javascript; charset=utf-8' }],
  ['/mascot.js', { file: 'mascot.js', type: 'text/javascript; charset=utf-8' }],
  ['/vendor/three.module.min.js', { file: 'vendor/three.module.min.js', type: 'text/javascript; charset=utf-8' }],
  ['/vendor/THREE-LICENSE', { file: 'vendor/THREE-LICENSE', type: 'text/plain; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

const ANSWER_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};

const INLINE_CARD_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Private-Network': 'true',
};

function setAnswerCors(response) {
  for (const [header, value] of Object.entries(ANSWER_CORS_HEADERS)) {
    response.setHeader(header, value);
  }
}

function setInlineCardCors(response) {
  for (const [header, value] of Object.entries(INLINE_CARD_CORS_HEADERS)) {
    response.setHeader(header, value);
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;

    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > 64_000) {
        const error = new Error('Request body is too large.');
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('Request body must be valid JSON.');
        error.statusCode = 400;
        reject(error);
      }
    });
  });
}

function readOptionalJsonBody(request) {
  const length = Number.parseInt(request.headers['content-length'], 10);
  if (Number.isInteger(length) && length === 0) {
    return Promise.resolve({});
  }
  if (!request.headers['content-length'] && !request.headers['transfer-encoding']) {
    return Promise.resolve({});
  }
  return readJsonBody(request);
}

function createHttpHandler({
  config,
  hub,
  snapshot,
  initialEvents = null,
  recentReports = () => [],
  acceptInternalReport = () => {},
  answerCard = null,
  inlineCardHtml = null,
  onActivated = null,
  broker = null,
}) {
  return async function handleHttp(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

      if (url.pathname === '/answer') {
        setAnswerCors(response);
        if (request.method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          return;
        }
      }

      if (url.pathname === '/inline-card') {
        setInlineCardCors(response);
        if (request.method === 'OPTIONS') {
          response.writeHead(204);
          response.end();
          return;
        }
        if (request.method === 'GET') {
          if (!inlineCardHtml) {
            sendText(response, 404, 'Not found');
            return;
          }
          const projectId = url.searchParams.get('project') || undefined;
          const html = await inlineCardHtml(projectId);
          if (typeof html !== 'string') {
            sendText(response, 503, 'Inline lesson unavailable');
            return;
          }
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end(html);
          return;
        }
      }

      if (request.method === 'GET' && url.pathname === '/events') {
        const events = initialEvents ? await initialEvents() : [{ type: 'snapshot', payload: snapshot() }];
        hub.connect(request, response, events);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/settings' && broker?.getSettings) {
        sendJson(response, 200, await broker.getSettings());
        return;
      }

      if (request.method === 'GET' && url.pathname === '/conversation-titles' && broker?.conversationTitles) {
        const ids = url.searchParams.getAll('id').slice(0, 40);
        sendJson(response, 200, await broker.conversationTitles(ids));
        return;
      }

      if (['POST', 'PATCH'].includes(request.method) && url.pathname === '/settings' && broker?.updateSettings) {
        try {
          const settings = await broker.updateSettings(await readJsonBody(request));
          sendJson(response, 200, settings);
        } catch (error) {
          if (!error.statusCode && error instanceof TypeError) {
            error.statusCode = 400;
          }
          throw error;
        }
        return;
      }

      if (url.pathname === '/activation' && broker?.activation && broker?.activateProject) {
        const projectId = url.searchParams.get('project') || undefined;
        if (request.method === 'GET') {
          const activation = broker.activation(projectId);
          if (!activation) {
            sendJson(response, 404, { error: 'Unknown activation project.' });
            return;
          }
          sendJson(response, 200, activation);
          return;
        }
        if (['POST', 'PATCH'].includes(request.method)) {
          try {
            const result = await broker.activateProject(projectId || broker.defaultProjectId, await readJsonBody(request));
            await onActivated?.(result);
            sendJson(response, 200, result);
          } catch (error) {
            if (!error.statusCode && error instanceof TypeError) {
              error.statusCode = 400;
            }
            throw error;
          }
          return;
        }
      }

      if (request.method === 'GET' && url.pathname === '/activations' && broker?.activations) {
        sendJson(response, 200, { activations: broker.activations() });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/projects' && broker?.listProjects) {
        sendJson(response, 200, { projects: await broker.listProjects() });
        return;
      }

      const snapshotMatch = url.pathname.match(/^\/projects\/([^/]+)\/snapshot$/);
      if (request.method === 'GET' && snapshotMatch && broker?.projectSnapshot) {
        const project = await broker.projectSnapshot(decodeURIComponent(snapshotMatch[1]));
        if (!project) {
          sendJson(response, 404, { error: 'Unknown project.' });
          return;
        }
        sendJson(response, 200, project);
        return;
      }

      const nextMatch = url.pathname.match(/^\/projects\/([^/]+)\/next$/);
      if (request.method === 'POST' && nextMatch && broker?.nextLesson) {
        const projectId = decodeURIComponent(nextMatch[1]);
        const options = await readOptionalJsonBody(request);
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
          const error = new Error('Next options must be an object.');
          error.statusCode = 400;
          throw error;
        }
        const result = await broker.nextLesson(projectId, options);
        sendJson(response, 200, result);
        return;
      }

      const reviewMatch = url.pathname.match(/^\/projects\/([^/]+)\/review$/);
      if (request.method === 'GET' && reviewMatch && broker?.reviewLessons) {
        const review = await broker.reviewLessons(decodeURIComponent(reviewMatch[1]));
        if (!review) {
          sendJson(response, 404, { error: 'Unknown project.' });
          return;
        }
        sendJson(response, 200, review);
        return;
      }

      const archiveMatch = url.pathname.match(/^\/projects\/([^/]+)\/archive$/);
      if (request.method === 'POST' && archiveMatch && broker?.archiveProject) {
        const project = await broker.archiveProject(decodeURIComponent(archiveMatch[1]));
        if (!project) {
          sendJson(response, 404, { error: 'Unknown project.' });
          return;
        }
        sendJson(response, 200, { project });
        return;
      }

      const unarchiveMatch = url.pathname.match(/^\/projects\/([^/]+)\/unarchive$/);
      if (request.method === 'POST' && unarchiveMatch && broker?.unarchiveProject) {
        const project = await broker.unarchiveProject(decodeURIComponent(unarchiveMatch[1]));
        if (!project) {
          sendJson(response, 404, { error: 'Unknown project.' });
          return;
        }
        sendJson(response, 200, { project });
        return;
      }

      const projectSettingsMatch = url.pathname.match(/^\/projects\/([^/]+)\/settings$/);
      if (projectSettingsMatch && broker?.activation && broker?.updateProjectSettings) {
        const projectId = decodeURIComponent(projectSettingsMatch[1]);
        if (request.method === 'GET') {
          const activation = broker.activation(projectId);
          if (!activation) {
            sendJson(response, 404, { error: 'Unknown project.' });
            return;
          }
          sendJson(response, 200, activation);
          return;
        }
        if (['POST', 'PATCH'].includes(request.method)) {
          try {
            const result = await broker.updateProjectSettings(projectId, await readJsonBody(request));
            await onActivated?.(result);
            sendJson(response, 200, result);
          } catch (error) {
            if (!error.statusCode && error instanceof TypeError) {
              error.statusCode = 400;
            }
            throw error;
          }
          return;
        }
      }

      if (request.method === 'GET' && url.pathname === '/ledger' && broker?.activity) {
        const projectId = url.searchParams.get('project') || undefined;
        const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit'), 10) || 100));
        const activity = await broker.activity(projectId, limit);
        if (!activity) {
          sendJson(response, 404, { error: 'Unknown project.' });
          return;
        }
        sendJson(response, 200, activity);
        return;
      }

      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        const asset = STATIC_FILES.get(url.pathname);
        const filePath = path.join(config.publicDir, asset.file);
        const file = await fs.readFile(filePath);
        response.writeHead(200, {
          'Content-Type': asset.type,
          'Cache-Control': 'no-store',
        });
        response.end(file);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        const brokerHealth = broker?.health ? await broker.health() : {};
        sendJson(response, 200, {
          pid: process.pid,
          processCwd: config.cwd,
          stateDir: config.stateDir,
          mode: config.mode,
          provider: config.provider,
          ...brokerHealth,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/debug/reports') {
        const projectId = url.searchParams.get('project') || undefined;
        const reports = broker?.recentReports ? await broker.recentReports(projectId) : recentReports();
        sendJson(response, 200, { reports: reports || [] });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/internal/register') {
        if (!broker?.register) {
          sendText(response, 404, 'Not found');
          return;
        }
        const registration = await readJsonBody(request);
        if (
          !registration ||
          typeof registration !== 'object' ||
          Array.isArray(registration) ||
          Object.keys(registration).length !== 1 ||
          typeof registration.root !== 'string'
        ) {
          const error = new Error('Registration must include exactly one root string.');
          error.statusCode = 400;
          throw error;
        }
        const result = await broker.register(registration.root);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/internal/reports') {
        const report = await readJsonBody(request);
        const validation = validateReport(report);
        if (validation.error) {
          sendJson(response, 400, { error: validation.error });
          return;
        }
        const projectId = url.searchParams.get('project') || undefined;
        if (broker?.acceptRelayReport) {
          const token = request.headers['x-osmosis-token'];
          const accepted = await broker.acceptRelayReport(projectId, typeof token === 'string' ? token : '', validation.value);
          if (!accepted) {
            sendJson(response, 403, { error: 'The project relay is not registered.' });
            return;
          }
        } else {
          acceptInternalReport(validation.value);
        }
        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/answer') {
        if (!answerCard) {
          sendText(response, 404, 'Not found');
          return;
        }
        const answer = await readJsonBody(request);
        const result = await (broker ? answerCard(url.searchParams.get('project') || undefined, answer) : answerCard(answer));
        sendJson(response, 200, result);
        return;
      }

      sendText(response, 404, 'Not found');
    } catch (error) {
      log('HTTP handler error', error && error.stack ? error.stack : error);
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 500, {
          error: error.statusCode ? error.message : 'The local server could not complete that request.',
        });
      } else {
        response.end();
      }
    }
  };
}

module.exports = { createHttpHandler };
