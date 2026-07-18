'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { log } = require('./log');
const { validateReport } = require('./mcp');

const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
]);

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

function createHttpHandler({
  config,
  hub,
  snapshot,
  recentReports = () => [],
  acceptInternalReport = () => {},
  answerCard = null,
}) {
  return async function handleHttp(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/events') {
        hub.connect(request, response, snapshot());
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
        sendJson(response, 200, {
          pid: process.pid,
          processCwd: config.cwd,
          stateDir: config.stateDir,
          mode: config.mode,
          provider: config.provider,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/debug/reports') {
        sendJson(response, 200, { reports: recentReports() });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/internal/reports') {
        const report = await readJsonBody(request);
        const validation = validateReport(report);
        if (validation.error) {
          sendJson(response, 400, { error: validation.error });
          return;
        }
        acceptInternalReport(validation.value);
        sendJson(response, 202, { accepted: true });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/answer') {
        if (!answerCard) {
          sendText(response, 404, 'Not found');
          return;
        }
        const answer = await readJsonBody(request);
        const result = await answerCard(answer);
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
