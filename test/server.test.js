'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { resolveProjectIdentity } = require('../lib/project-identity');

const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createTestCleanup(testContext) {
  const cleanups = [];

  testContext.after(async () => {
    const failures = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length) {
      throw new AggregateError(failures, 'Test cleanup failed.');
    }
  });

  return {
    add(cleanup) {
      cleanups.push(cleanup);
    },
  };
}

async function temporaryProject(cleanup) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-test-'));
  cleanup.add(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function startServer({ cwd, port, extraEnv = {} }) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd,
    env: {
      ...process.env,
      OSMOSIS_PORT: String(port),
      // Keep real local Codex sessions out of unrelated HTTP/MCP tests. Tests
      // that exercise Ambient Watch opt in with an isolated sessions directory.
      OSMOSIS_AMBIENT: '0',
      // Production keeps the 12s global learning pace. Server integration
      // tests override it to 1ms unless a test explicitly exercises pacing.
      OSMOSIS_CARD_PACING_MS: '1',
      OSMOSIS_TEMPLATE_DELAY_MS: '10000',
      OSMOSIS_PROFILE_DIR: path.join(cwd, '.test-profile'),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let exitDetails = null;
  let closeDetails = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitDetails = { code, signal };
      resolve(exitDetails);
    });
    child.once('error', (error) => {
      exitDetails = { error };
      resolve(exitDetails);
    });
  });
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      closeDetails = { code, signal };
      resolve(closeDetails);
    });
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    stderr: () => stderr,
    stdout: () => stdout,
    stdoutLines: () => stdout.trim().split('\n').filter(Boolean),
    exited,
    exitDetails: () => exitDetails,
    closed,
    closeDetails: () => closeDetails,
    stopPromise: null,
  };
}

async function waitForClose(runner, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      runner.closed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopServer(runner) {
  if (runner.stopPromise) {
    return runner.stopPromise;
  }

  runner.stopPromise = (async () => {
    if (runner.child.exitCode !== null || runner.child.signalCode !== null) {
      if (await waitForClose(runner, 1_000)) {
        return;
      }
      throw new Error(`Timed out closing server process ${runner.child.pid}.`);
    }

    runner.child.stdin.end();
    runner.child.kill('SIGTERM');
    if (await waitForClose(runner, 1_000)) {
      return;
    }

    runner.child.kill('SIGKILL');
    if (await waitForClose(runner, 1_000)) {
      return;
    }

    throw new Error(`Timed out stopping server process ${runner.child.pid}.`);
  })();

  return runner.stopPromise;
}

function listeningPort(runner) {
  const match = runner.stderr().match(/HTTP listening on http:\/\/127\.0\.0\.1:(\d+)/);
  return match ? Number(match[1]) : null;
}

function startTrackedServer(cleanup, options) {
  const runner = startServer(options);
  cleanup.add(() => stopServer(runner));
  return runner;
}

async function activateStudioProject(port, { carry = true, captureMode = 'agent-reports-only', locale = 'en' } = {}) {
  const settingsResponse = await fetch(`http://127.0.0.1:${port}/settings`, { cache: 'no-store' });
  assert.equal(settingsResponse.status, 200);
  const settings = await settingsResponse.json();
  const activation = settings.activation;
  // A test may need to turn the already carried default project from the
  // conservative reports-only setting into Ambient Watch. Treat activation
  // as an editable Studio preference, not a one-shot fixture step.
  if (activation?.carry === carry
    && activation?.capture_mode === captureMode
    && activation?.lesson_locale === locale) {
    return activation;
  }
  const response = await fetch(`http://127.0.0.1:${port}/activation?project=${encodeURIComponent(activation.project_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ carry, capture_mode: captureMode, lesson_locale: locale, auto_advance: false }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).activation;
}

async function activateStudioProjectAtRoot(port, root, options = {}) {
  const identity = await resolveProjectIdentity(root);
  const response = await fetch(`http://127.0.0.1:${port}/activation?project=${encodeURIComponent(identity.project_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      auto_advance: false,
      capture_mode: options.captureMode || 'agent-reports-only',
      carry: options.carry !== false,
      lesson_locale: options.locale || 'en',
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function startHttpServer(cleanup, {
  cwd,
  extraEnv = {},
  activate = true,
  captureMode = 'agent-reports-only',
}) {
  const runner = startTrackedServer(cleanup, { cwd, port: 0, extraEnv });
  const port = await waitFor(() => listeningPort(runner), 'an assigned HTTP port');
  await waitFor(() => health(port), 'the HTTP server');
  if (activate) await activateStudioProject(port, { captureMode });
  return { runner, port };
}

async function openTrackedEvents(cleanup, port) {
  const stream = await openEvents(port);
  cleanup.add(() => stream.close());
  return stream;
}

async function waitFor(check, description) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  if (!response.ok) {
    throw new Error(`health returned ${response.status}`);
  }
  return response.json();
}

async function openEvents(port) {
  const response = await fetch(`http://127.0.0.1:${port}/events`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  let buffer = '';

  async function nextEvent() {
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventLine = block.split('\n').find((line) => line.startsWith('event: '));
        if (!eventLine) {
          continue;
        }
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        return {
          type: eventLine.slice('event: '.length),
          data: dataLine ? JSON.parse(dataLine.slice('data: '.length)) : undefined,
        };
      }

      const { done, value } = await reader.read();
      if (done) {
        throw new Error('SSE stream ended before the expected event.');
      }
      buffer += new TextDecoder().decode(value);
    }
  }

  return {
    async close() {
      await reader.cancel().catch(() => {});
    },
    nextEvent,
  };
}

async function nextEventOfType(stream, expectedType) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const event = await stream.nextEvent();
    if (event.type === expectedType) {
      return event;
    }
  }
  throw new Error(`Did not receive SSE event ${expectedType}.`);
}

async function nextEventMatching(stream, predicate, description) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const event = await stream.nextEvent();
    if (predicate(event)) {
      return event;
    }
  }
  throw new Error(`Did not receive ${description}.`);
}

function rawMcpMessages() {
  return [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'osmosis_report',
        arguments: {
          task: 'Step 1 Skeleton',
          what_i_did: 'Built and verified the HTTP and SSE skeleton with a template lesson.',
          stack_hints: ['Node.js', 'HTTP', 'SSE'],
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'osmosis_report',
        arguments: {
          task: 'Step 2 MCP',
          what_i_did: 'Added the MCP reporting tool and verified a second sequential report.',
          stack_hints: ['JSON-RPC', 'stdio', 'MCP'],
        },
      },
    },
  ];
}

function reportMessage(id, task, whatIDid, stackHints = ['Node.js', 'MCP']) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'osmosis_report',
      arguments: {
        task,
        what_i_did: whatIDid,
        stack_hints: stackHints,
      },
    },
  };
}

function codexTreeNodes() {
  return [
    { concept_id: 'project', concept_name: 'Your project', parent_id: null },
    { concept_id: 'interface', concept_name: 'The interface', parent_id: 'project' },
    { concept_id: 'data', concept_name: 'Data flow', parent_id: 'project' },
    { concept_id: 'automation', concept_name: 'Automation', parent_id: 'project' },
    { concept_id: 'html', concept_name: 'HTML structure', parent_id: 'interface' },
    { concept_id: 'css', concept_name: 'CSS styling', parent_id: 'interface' },
    { concept_id: 'dom', concept_name: 'The document tree', parent_id: 'interface' },
    { concept_id: 'http', concept_name: 'HTTP', parent_id: 'data' },
    { concept_id: 'json', concept_name: 'JSON data', parent_id: 'data' },
    { concept_id: 'state', concept_name: 'App state', parent_id: 'data' },
    { concept_id: 'mcp', concept_name: 'MCP reporting', parent_id: 'automation' },
    { concept_id: 'tests', concept_name: 'Automated tests', parent_id: 'automation' },
    { concept_id: 'deploy', concept_name: 'Deployment', parent_id: 'automation' },
  ];
}

async function writeCodexShim(directory) {
  const shimPath = path.join(directory, 'fake-codex.js');
  const tree = JSON.stringify({ nodes: codexTreeNodes() });
  const card = JSON.stringify({
    concept_id: 'http',
    concept_name: 'HTTP',
    lesson: 'HTTP carries a request from your app to a server and brings a response back, like a labeled envelope travelling between two places.',
    question: 'What does HTTP help your app do?',
    options: ['Send a request and receive a response.', 'Draw every screen pixel.', 'Store passwords in a browser tab.'],
    correct_index: 0,
    explanation: 'HTTP carries a request to a server and brings a response back.',
  });
  await fs.writeFile(
    shimPath,
    `#!/usr/bin/env node\n'use strict';\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst outputPath = args[args.indexOf('--output-last-message') + 1];\nconst schemaPath = args[args.indexOf('--output-schema') + 1];\nconst result = schemaPath.endsWith('tree-output.schema.json') ? ${JSON.stringify(tree)} : ${JSON.stringify(card)};\nfs.writeFileSync(outputPath, result);\nprocess.stdout.write(result);\n`,
    { mode: 0o755 },
  );
  return shimPath;
}

async function writeSequencedCodexShim(directory) {
  const shimPath = path.join(directory, 'sequenced-fake-codex.js');
  const counterPath = path.join(directory, 'sequenced-fake-codex-count.txt');
  const tree = JSON.stringify({ nodes: codexTreeNodes() });
  const cards = [
    {
      concept_id: 'http',
      concept_name: 'HTTP',
      lesson: 'HTTP carries a request to a server and brings a response back, like a labeled envelope travelling between two places.',
      question: 'What does HTTP help your app do?',
      options: ['Send a request and receive a response.', 'Draw every screen pixel.', 'Store passwords in a browser tab.'],
      correct_index: 0,
      explanation: 'HTTP carries a request to a server and brings a response back.',
    },
    {
      concept_id: 'json',
      concept_name: 'JSON data',
      lesson: 'JSON gives a program a shared label system for small pieces of information, like a packing list that both sender and receiver can read.',
      question: 'Why is JSON useful between parts of an app?',
      options: ['It gives both sides a predictable way to label information.', 'It turns every page into a 3D scene.', 'It prevents every network request.'],
      correct_index: 0,
      explanation: 'JSON is a shared, predictable structure for exchanging information.',
    },
  ].map(JSON.stringify);
  await fs.writeFile(
    shimPath,
    `#!/usr/bin/env node\n'use strict';\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst outputPath = args[args.indexOf('--output-last-message') + 1];\nconst schemaPath = args[args.indexOf('--output-schema') + 1];\nconst tree = ${JSON.stringify(tree)};\nconst cards = ${JSON.stringify(cards)};\nconst counterPath = ${JSON.stringify(counterPath)};\nlet result = tree;\nif (!schemaPath.endsWith('tree-output.schema.json')) {\n  let count = 0;\n  try { count = Number.parseInt(fs.readFileSync(counterPath, 'utf8'), 10) || 0; } catch {}\n  fs.writeFileSync(counterPath, String(count + 1));\n  result = cards[Math.min(count, cards.length - 1)];\n}\nfs.writeFileSync(outputPath, result);\nprocess.stdout.write(result);\n`,
    { mode: 0o755 },
  );
  return shimPath;
}

async function writeBlockedCountingCodexShim(directory) {
  const shimPath = path.join(directory, 'blocked-counting-fake-codex.js');
  const invocationLogPath = path.join(directory, 'blocked-counting-fake-codex-invocations.jsonl');
  const releasePath = path.join(directory, 'blocked-counting-fake-codex-release');
  const tree = JSON.stringify({ nodes: codexTreeNodes() });
  const card = JSON.stringify({
    concept_id: 'http',
    concept_name: 'HTTP',
    lesson: 'HTTP carries a request from your app to a server and brings a response back, like a labeled envelope travelling between two places.',
    question: 'What does HTTP help your app do?',
    options: ['Send a request and receive a response.', 'Draw every screen pixel.', 'Store passwords in a browser tab.'],
    correct_index: 0,
    explanation: 'HTTP carries a request to a server and brings a response back.',
  });
  await fs.writeFile(
    shimPath,
    `#!/usr/bin/env node\n'use strict';\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nconst outputPath = args[args.indexOf('--output-last-message') + 1];\nconst schemaPath = args[args.indexOf('--output-schema') + 1];\nconst tree = ${JSON.stringify(tree)};\nconst card = ${JSON.stringify(card)};\nconst invocationLogPath = ${JSON.stringify(invocationLogPath)};\nconst releasePath = ${JSON.stringify(releasePath)};\nif (schemaPath.endsWith('tree-output.schema.json')) {\n  fs.writeFileSync(outputPath, tree);\n  process.stdout.write(tree);\n} else {\n  fs.appendFileSync(invocationLogPath, JSON.stringify({ pid: process.pid, at: Date.now() }) + '\\n');\n  const finish = () => {\n    if (!fs.existsSync(releasePath)) {\n      setTimeout(finish, 10);\n      return;\n    }\n    fs.writeFileSync(outputPath, card);\n    process.stdout.write(card);\n  };\n  finish();\n}\n`,
    { mode: 0o755 },
  );
  return { invocationLogPath, releasePath, shimPath };
}

async function writeFailingCodexShim(directory) {
  const shimPath = path.join(directory, 'failing-codex.js');
  await fs.writeFile(
    shimPath,
    "#!/usr/bin/env node\n'use strict';\nprocess.stderr.write('intentional test failure');\nprocess.exit(1);\n",
    { mode: 0o755 },
  );
  return shimPath;
}

test('SSE sends an empty snapshot followed by a template card', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const { port } = await startHttpServer(cleanup, { cwd, activate: false, extraEnv: { OSMOSIS_TEMPLATE_DELAY_MS: '400' } });
  const projectStateScript = await fetch(`http://127.0.0.1:${port}/project-state.js`);
  assert.equal(projectStateScript.status, 200);
  assert.match(await projectStateScript.text(), /applyBackgroundActivity/);
  const stream = await openTrackedEvents(cleanup, port);

  const snapshot = await stream.nextEvent();
  assert.equal(snapshot.type, 'snapshot');
  assert.deepEqual(snapshot.data.cards, []);

  await activateStudioProject(port);

  const card = await nextEventOfType(stream, 'card');
  assert.equal(card.data.source.task, 'Step 1 Skeleton');
  assert.equal(card.data.state.answered, false);
  assert.equal('correct_index' in card.data, false);
  assert.equal('explanation' in card.data, false);
});

test('MCP stdio accepts two sequential reports without corrupting stdout', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const { runner, port } = await startHttpServer(cleanup, { cwd });
  const stream = await openTrackedEvents(cleanup, port);
  assert.equal((await stream.nextEvent()).type, 'snapshot');

  runner.child.stdin.write(`${rawMcpMessages().map(JSON.stringify).join('\n')}\n`);
  await waitFor(() => runner.stdoutLines().length === 4, 'four MCP responses');

  const responses = runner.stdoutLines().map((line) => JSON.parse(line));
  assert.deepEqual(
    responses.map((response) => response.id),
    [1, 2, 3, 4],
  );
  assert.equal(responses[0].result.serverInfo.name, 'osmosis');
  assert.equal(responses[1].result.tools[0].name, 'osmosis_report');
  assert.equal(
    responses[1].result.tools[0].description,
    'Call this immediately after completing each task or milestone, before starting the next. Write what_i_did in English.',
  );
  assert.equal(responses[2].result.content[0].text, 'Osmosis recorded this milestone.');
  assert.equal(responses[3].result.content[0].text, 'Osmosis recorded this milestone.');

  const status = await nextEventOfType(stream, 'status');
  assert.equal(status.data.report.what_i_did, 'Built and verified the HTTP and SSE skeleton with a template lesson.');
  assert.equal(status.data.report.source, 'agent');
  const firstCard = await nextEventOfType(stream, 'card');
  assert.equal(firstCard.data.source.what_i_did, 'Built and verified the HTTP and SSE skeleton with a template lesson.');
  assert.equal(firstCard.data.source.kind, 'agent');
  const ready = await nextEventMatching(
    stream,
    (event) => event.type === 'studio' && event.data.next_ready === true,
    'the hidden ready Studio lesson',
  );
  assert.equal(ready.data.current.source.what_i_did, 'Built and verified the HTTP and SSE skeleton with a template lesson.');

  runner.child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'ui://osmosis/card.html' } })}\n`,
  );
  await waitFor(() => runner.stdoutLines().length === 5, 'the inline MCP resource');
  const inlineResource = JSON.parse(runner.stdoutLines().at(-1));
  assert.equal(inlineResource.id, 5);
  assert.equal(inlineResource.result.contents[0].mimeType, 'text/html');
  assert.match(inlineResource.result.contents[0].text, /Built and verified the HTTP and SSE skeleton with a template lesson/);
  assert.equal(inlineResource.result.contents[0]._meta.ui.csp.connectDomains[0], `http://127.0.0.1:${port}`);

  const refreshedInlineCard = await fetch(`http://127.0.0.1:${port}/inline-card`);
  assert.equal(refreshedInlineCard.status, 200);
  assert.equal(refreshedInlineCard.headers.get('access-control-allow-origin'), '*');
  assert.match(await refreshedInlineCard.text(), /Built and verified the HTTP and SSE skeleton with a template lesson/);

  const reports = await (await fetch(`http://127.0.0.1:${port}/debug/reports`)).json();
  assert.deepEqual(
    reports.reports.map((report) => report.task),
    ['Step 1 Skeleton', 'Step 2 MCP'],
  );

  await delay(100);
  assert.equal(runner.stdoutLines().length, 5);
});

test('an empty inline MCP card refreshes to the delivered lesson without blocking the report', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const { runner, port } = await startHttpServer(cleanup, {
    cwd,
    extraEnv: { OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  const stream = await openTrackedEvents(cleanup, port);
  assert.equal((await stream.nextEvent()).type, 'snapshot');

  runner.child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://osmosis/card.html' } })}\n`,
  );
  await waitFor(() => runner.stdoutLines().length === 1, 'the empty inline resource');
  const emptyResource = JSON.parse(runner.stdoutLines()[0]);
  assert.match(emptyResource.result.contents[0].text, /data-osmosis-inline-card="pending"/);
  assert.match(emptyResource.result.contents[0].text, new RegExp(`http://127\\.0\\.0\\.1:${port}/inline-card`));

  runner.child.stdin.write(
    `${JSON.stringify(reportMessage(2, 'Inline refresh', 'Generated a lesson after the inline resource was already open.'))}\n`,
  );
  await waitFor(() => runner.stdoutLines().length === 2, 'the non-blocking report acknowledgement');
  const card = (await nextEventOfType(stream, 'card')).data;
  assert.equal(card.source.task, 'Inline refresh');

  const refreshed = await fetch(`http://127.0.0.1:${port}/inline-card`);
  assert.equal(refreshed.status, 200);
  const html = await refreshed.text();
  assert.match(html, /data-osmosis-inline-card="ready"/);
  assert.match(html, /Generated a lesson after the inline resource was already open/);
});

test('an HTTP port loser continues serving MCP and relays its report to the primary', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const { runner: primary, port } = await startHttpServer(cleanup, { cwd });
  const secondary = startTrackedServer(cleanup, { cwd, port });
  await waitFor(() => secondary.stderr().includes('HTTP disabled'), 'the port guard');

  secondary.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'guard', version: '1.0.0' } },
    })}\n${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'osmosis_report',
        arguments: {
          task: 'Port guard',
          what_i_did: 'Verified the second server instance remains available over stdio.',
          stack_hints: ['Node.js', 'MCP'],
        },
      },
    })}\n`,
  );

  await waitFor(() => secondary.stdoutLines().length === 2, 'MCP responses from the secondary');
  assert.doesNotThrow(() => secondary.stdoutLines().map((line) => JSON.parse(line)));

  const reports = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/debug/reports`);
    const body = await response.json();
    return body.reports.some((report) => report.task === 'Port guard') ? body : null;
  }, 'the relayed report on the primary');
  assert.equal(reports.reports.at(-1).what_i_did, 'Verified the second server instance remains available over stdio.');
  assert.equal(reports.reports.at(-1).source, 'agent');
});

test('a port loser registers its relay project before its first MCP report', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const primaryCwd = await temporaryProject(cleanup);
  const relayCwd = await temporaryProject(cleanup);
  const sharedProfile = await temporaryProject(cleanup);
  const { port } = await startHttpServer(cleanup, {
    cwd: primaryCwd,
    extraEnv: { OSMOSIS_PROFILE_DIR: sharedProfile, OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  const relay = startTrackedServer(cleanup, {
    cwd: relayCwd,
    port,
    extraEnv: { OSMOSIS_PROFILE_DIR: sharedProfile, OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  await waitFor(() => relay.stderr().includes('HTTP disabled'), 'the relay port guard');

  // Registration is part of entering relay mode, but Carry is the explicit
  // user decision that creates a project channel. Before that decision, the
  // relay has identity without a tab or project state.
  const canonicalRelayCwd = await fs.realpath(relayCwd);
  const relayIdentity = await resolveProjectIdentity(relayCwd);
  const pending = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/settings`);
    const body = await response.json();
    return body.activations?.find((activation) => activation.project_id === relayIdentity.project_id) || null;
  }, 'the report-free relay activation identity');
  assert.equal(pending.state, 'activation-pending');
  const beforeCarry = await fetch(`http://127.0.0.1:${port}/projects`);
  assert.equal((await beforeCarry.json()).projects.some((candidate) => candidate.root === canonicalRelayCwd), false);

  await activateStudioProjectAtRoot(port, relayCwd);
  const project = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/projects`);
    const body = await response.json();
    return body.projects.find((candidate) => candidate.root === canonicalRelayCwd) || null;
  }, 'the report-free relay registration');
  assert.ok(project.project_id);

  const reports = await fetch(`http://127.0.0.1:${port}/debug/reports?project=${encodeURIComponent(project.project_id)}`);
  assert.deepEqual((await reports.json()).reports, []);

  relay.child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'ui://osmosis/card.html' } })}\n`,
  );
  await waitFor(() => relay.stdoutLines().length === 1, 'the pre-report relay inline resource');
  const resource = JSON.parse(relay.stdoutLines()[0]);
  assert.match(resource.result.contents[0].text, /data-osmosis-inline-card="pending"/);
  assert.match(
    resource.result.contents[0].text,
    new RegExp(`/inline-card\\?project=${encodeURIComponent(project.project_id)}`),
  );
});

test('the port owner brokers registered project channels with a token, lazy snapshot, and scoped answers', { timeout: 15_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const primaryCwd = await temporaryProject(cleanup);
  const secondaryCwd = await temporaryProject(cleanup);
  const sharedProfile = await temporaryProject(cleanup);
  const { runner: primary, port } = await startHttpServer(cleanup, {
    cwd: primaryCwd,
    extraEnv: { OSMOSIS_PROFILE_DIR: sharedProfile, OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  const stream = await openTrackedEvents(cleanup, port);
  assert.equal((await stream.nextEvent()).type, 'snapshot');
  const v2 = await stream.nextEvent();
  assert.equal(v2.type, 'snapshot-v2');
  assert.equal(v2.data.v, 2);
  assert.equal(typeof v2.data.default_project_id, 'string');

  const secondary = startTrackedServer(cleanup, {
    cwd: secondaryCwd,
    port,
    extraEnv: { OSMOSIS_PROFILE_DIR: sharedProfile, OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  await waitFor(() => secondary.stderr().includes('HTTP disabled'), 'the registered project relay');
  const secondaryIdentity = await resolveProjectIdentity(secondaryCwd);
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/settings`);
    const body = await response.json();
    return body.activations?.some((activation) => activation.project_id === secondaryIdentity.project_id);
  }, 'the relay activation identity');
  await activateStudioProjectAtRoot(port, secondaryCwd);
  secondary.child.stdin.write(
    `${JSON.stringify(reportMessage(1, 'Project B channel', 'Delivered a lesson into the ferry viewer project.'))}\n`,
  );
  await waitFor(() => secondary.stdoutLines().length === 1, 'the project B MCP acknowledgement');

  const projects = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/projects`);
    const body = await response.json();
    return body.projects.length >= 2 ? body.projects : null;
  }, 'registered project summaries');
  const canonicalSecondaryCwd = await fs.realpath(secondaryCwd);
  const projectB = projects.find((project) => project.root === canonicalSecondaryCwd);
  assert.ok(projectB, JSON.stringify({ projects, canonicalSecondaryCwd }));

  const rejected = await fetch(`http://127.0.0.1:${port}/internal/reports?project=${encodeURIComponent(projectB.project_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-osmosis-token': 'wrong-token' },
    body: JSON.stringify({ task: 'Bad token', what_i_did: 'Must not be accepted.', stack_hints: [] }),
  });
  assert.equal(rejected.status, 403);

  const reports = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/debug/reports?project=${encodeURIComponent(projectB.project_id)}`);
    const body = await response.json();
    return body.reports.some((report) => report.task === 'Project B channel') ? body.reports : null;
  }, 'the broker-routed B report');
  assert.equal(reports.at(-1).source, 'agent');

  const bSnapshot = await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(projectB.project_id)}/snapshot`);
  assert.equal(bSnapshot.status, 200);
  const bProject = await bSnapshot.json();
  assert.equal(bProject.cards.length, 1);
  const activity = await fetch(`http://127.0.0.1:${port}/ledger?project=${encodeURIComponent(projectB.project_id)}&limit=2`);
  assert.equal(activity.status, 200);
  const activityBody = await activity.json();
  assert.ok(activityBody.entries.length <= 2, 'ledger pagination stays bounded');
  assert.equal(activityBody.entries.at(-1).state, 'delivered');
  secondary.child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'ui://osmosis/card.html' } })}\n`,
  );
  await waitFor(() => secondary.stdoutLines().length === 2, 'the relay inline-card proxy response');
  const relayedInline = JSON.parse(secondary.stdoutLines().at(-1));
  assert.match(relayedInline.result.contents[0].text, /Delivered a lesson into the ferry viewer project/);
  assert.match(relayedInline.result.contents[0].text, new RegExp(`/answer\\?project=${encodeURIComponent(projectB.project_id)}`));
  const answer = await fetch(`http://127.0.0.1:${port}/answer?project=${encodeURIComponent(projectB.project_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_id: bProject.cards[0].card_id, chosen_index: 0 }),
  });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).strength, 2);

  const archived = await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(projectB.project_id)}/archive`, { method: 'POST' });
  assert.equal(archived.status, 200);
  assert.equal((await archived.json()).project.archived, true);
  const restored = await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(projectB.project_id)}/unarchive`, { method: 'POST' });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).project.archived, false);

  const defaultSnapshot = await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(v2.data.default_project_id)}/snapshot`);
  assert.equal((await defaultSnapshot.json()).cards.length, 0, 'background project cards never enter the default channel');
  assert.equal(primary.stdout().includes('Project B channel'), false, 'MCP protocol stays local to each process');
});

test('a port loser takes over the local pipeline and watcher after the owner exits', { timeout: 15_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const primaryCwd = await temporaryProject(cleanup);
  const secondaryCwd = await temporaryProject(cleanup);
  const sessionsDir = await temporaryProject(cleanup);
  const now = new Date();
  const rolloutDirectory = path.join(
    sessionsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  const rolloutPath = path.join(rolloutDirectory, 'rollout-takeover.jsonl');
  await fs.mkdir(rolloutDirectory, { recursive: true });
  await fs.writeFile(rolloutPath, '');
  const { runner: primary, port } = await startHttpServer(cleanup, {
    cwd: primaryCwd,
    extraEnv: {
      OSMOSIS_AMBIENT: '1',
      OSMOSIS_PORT_RETRY_MS: '50',
      OSMOSIS_SESSIONS_DIR: sessionsDir,
      OSMOSIS_TEMPLATE_DELAY_MS: '60000',
    },
    captureMode: 'experimental-ambient',
  });
  const secondary = startTrackedServer(cleanup, {
    cwd: secondaryCwd,
    port,
    extraEnv: {
      OSMOSIS_AMBIENT: '1',
      OSMOSIS_PORT_RETRY_MS: '50',
      OSMOSIS_SESSIONS_DIR: sessionsDir,
      OSMOSIS_TEMPLATE_DELAY_MS: '60000',
    },
  });
  await waitFor(() => secondary.stderr().includes('HTTP disabled'), 'the retrying port loser');

  await stopServer(primary);
  await waitFor(() => listeningPort(secondary) === port, 'the retry-path HTTP takeover');
  await waitFor(() => health(port), 'the takeover HTTP server');
  await activateStudioProject(port, { captureMode: 'experimental-ambient' });

  secondary.child.stdin.write(
    `${JSON.stringify(reportMessage(1, 'Takeover report', 'Accepted a report through the newly owned local pipeline.'))}\n`,
  );
  await waitFor(() => secondary.stdoutLines().length === 1, 'the takeover MCP acknowledgement');
  const reports = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/debug/reports`);
    const body = await response.json();
    return body.reports.some((report) => report.task === 'Takeover report') ? body : null;
  }, 'the locally delivered takeover report');
  assert.equal(reports.reports.at(-1).source, 'agent');

  // The observer starts only after the delivery mode changes to local. Give
  // its EOF baseline a moment, then append a new event for the new owner.
  await delay(150);
  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: JSON.stringify({ cmd: 'node takeover.js', workdir: secondaryCwd }),
      },
    })}\n`,
  );
  const observedReports = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/debug/reports`);
    const body = await response.json();
    return body.reports.some((report) => report.source === 'observed') ? body : null;
  }, 'the takeover Ambient Watch report');
  assert.equal(observedReports.reports.at(-1).source, 'observed');
});

test('a same-project port takeover reloads cards and mastery before writing again', { timeout: 12_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const { runner: primary, port } = await startHttpServer(cleanup, {
    cwd,
    extraEnv: { OSMOSIS_PORT_RETRY_MS: '50', OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  const primaryStream = await openTrackedEvents(cleanup, port);
  await primaryStream.nextEvent();
  primary.child.stdin.write(
    `${JSON.stringify(reportMessage(1, 'Before takeover', 'Delivered a lesson before the port owner exited.'))}\n`,
  );
  await waitFor(() => primary.stdoutLines().length === 1, 'the pre-takeover acknowledgement');
  const firstCard = (await nextEventOfType(primaryStream, 'card')).data;
  const firstAnswer = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_id: firstCard.card_id, chosen_index: 1 }),
  });
  assert.equal((await firstAnswer.json()).strength, 1);

  const secondary = startTrackedServer(cleanup, {
    cwd,
    port,
    extraEnv: { OSMOSIS_PORT_RETRY_MS: '50', OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  await waitFor(() => secondary.stderr().includes('HTTP disabled'), 'the same-project port guard');
  await stopServer(primary);
  await waitFor(() => listeningPort(secondary) === port, 'the same-project retry takeover');
  await waitFor(() => health(port), 'the same-project takeover HTTP server');

  const takeoverStream = await openTrackedEvents(cleanup, port);
  const snapshot = await takeoverStream.nextEvent();
  assert.equal(snapshot.data.cards.length, 1);
  assert.equal(snapshot.data.cards[0].state.answered, true);
  assert.equal(snapshot.data.strengths['feedback-loop'].strength, 1);

  secondary.child.stdin.write(
    `${JSON.stringify(reportMessage(1, 'After takeover', 'Delivered another lesson from the new local owner.'))}\n`,
  );
  await waitFor(() => secondary.stdoutLines().length === 1, 'the post-takeover acknowledgement');
  // Studio keeps the newly prepared lesson hidden as Next until the learner
  // explicitly advances. That ready card deliberately is not a second
  // unsolicited feed item.
  await nextEventOfType(takeoverStream, 'studio');
  const takeoverHealth = await health(port);
  const nextResponse = await fetch(
    `http://127.0.0.1:${port}/projects/${encodeURIComponent(takeoverHealth.default_project_id)}/next`,
    { method: 'POST' },
  );
  assert.equal(nextResponse.status, 200);
  const secondCard = (await nextResponse.json()).card;
  assert.ok(secondCard);
  const secondAnswer = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_id: secondCard.card_id, chosen_index: 0 }),
  });
  assert.equal((await secondAnswer.json()).strength, 2);

  const cards = JSON.parse(await fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'));
  const profile = JSON.parse(await fs.readFile(path.join(cwd, '.test-profile', 'profile.json'), 'utf8'));
  assert.equal(cards.cards.length, 2);
  assert.equal(profile['feedback-loop'].strength, 2);
  assert.equal(profile['feedback-loop'].seen, 2);
});

test('one HTTP owner exclusively resumes a persisted Studio generation while two same-project relays stay thin across takeover', { timeout: 20_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const identity = await resolveProjectIdentity(cwd);
  const codexShim = await writeBlockedCountingCodexShim(cwd);
  const profileDir = path.join(cwd, '.test-profile');
  const reportId = 'realtime-persisted-inflight-report';
  const now = '2026-07-19T00:00:00.000Z';
  const persistedCandidate = {
    candidate_id: 'realtime-persisted-inflight-candidate',
    created_at: now,
    updated_at: now,
    report: {
      report_id: reportId,
      source: 'agent',
      stack_hints: ['HTTP', 'Node.js'],
      task: 'Persisted provider work',
      what_i_did: 'A previous owner was interrupted while preparing the next HTTP lesson.',
    },
    report_ids: [reportId],
  };
  const answeredNow = {
    card_id: 'realtime-answered-now',
    created_at: now,
    concept_id: `${identity.project_id}:json`,
    concept_name: 'JSON data',
    lesson: 'An earlier lesson remains visible until the learner chooses Next.',
    question: 'Which lesson is still on screen?',
    options: ['The earlier lesson.', 'A hidden future lesson.', 'No lesson at all.'],
    correct_index: 0,
    explanation: 'The learner keeps the answered current lesson until choosing Next.',
    source: {
      kind: 'agent',
      report_id: 'realtime-prior-report',
      task: 'Earlier lesson',
      what_i_did: 'Delivered an earlier Studio question.',
    },
    state: { answered: true, chosen_index: 1, correct: false },
  };

  // This simulates a process crash after the Studio durably recorded the
  // source signal but before the provider request had settled. Hydration must
  // move it back into a candidate only in the port-owning process.
  await fs.mkdir(path.join(cwd, '.osmosis'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, '.osmosis', 'cards.json'),
    `${JSON.stringify({
      cards: [answeredNow],
      studio: {
        version: 2,
        current_card_id: answeredNow.card_id,
        ready_card: null,
        candidates: [],
        generation: {
          candidate: persistedCandidate,
          in_flight: true,
          started_at: now,
        },
        last_unsolicited_delivery_at: null,
      },
    }, null, 2)}\n`,
  );
  // Supplying a legacy tree avoids a tree-provider invocation; the blocked
  // shim below therefore measures exactly the one resumed card request.
  await fs.writeFile(
    path.join(cwd, '.osmosis', 'tree.json'),
    `${JSON.stringify({ meta: {}, nodes: codexTreeNodes() }, null, 2)}\n`,
  );
  await fs.mkdir(path.join(profileDir, 'ledger'), { recursive: true });
  await fs.writeFile(
    path.join(profileDir, 'ledger', `${identity.project_id}.jsonl`),
    `${JSON.stringify({
      ts: now,
      project_id: identity.project_id,
      event: 'accept',
      report_id: reportId,
      source: 'agent',
      state: 'waiting',
    })}\n`,
  );

  const ownerOptions = {
    cwd,
    extraEnv: {
      OSMOSIS_CODEX_COMMAND: codexShim.shimPath,
      OSMOSIS_PORT_RETRY_MS: '50',
      OSMOSIS_PROVIDER: 'codex',
      OSMOSIS_TEMPLATE_DELAY_MS: '60000',
    },
  };
  const { runner: owner, port } = await startHttpServer(cleanup, ownerOptions);
  const invocationCount = async () => {
    try {
      return (await fs.readFile(codexShim.invocationLogPath, 'utf8')).split('\n').filter(Boolean).length;
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
  };
  await waitFor(() => invocationCount().then((count) => count === 1), 'the owner to begin its resumed provider request');

  // Keep the owner request paused while both port losers are already alive.
  // If either loser hydrates/pumps local Studio state, it will invoke this
  // shim too, making the regression fail before we release any result.
  const relayA = startTrackedServer(cleanup, { ...ownerOptions, port });
  const relayB = startTrackedServer(cleanup, { ...ownerOptions, port });
  await Promise.all([
    waitFor(() => relayA.stderr().includes('HTTP disabled'), 'the first thin same-project relay'),
    waitFor(() => relayB.stderr().includes('HTTP disabled'), 'the second thin same-project relay'),
  ]);
  await delay(250);
  assert.equal(await invocationCount(), 1, 'only the port owner starts the persisted provider chain while both relays are live');
  await fs.writeFile(codexShim.releasePath, 'release\n');

  const bufferedState = await waitFor(async () => {
    const document = JSON.parse(await fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'));
    return document.studio?.ready_card?.source?.report_id === reportId ? document : null;
  }, 'the single resumed hidden Next buffer');
  const bufferedCard = bufferedState.studio.ready_card;
  assert.equal(bufferedState.cards.some((card) => card.card_id === bufferedCard.card_id), false, 'the hidden card has one durable owner record');
  assert.equal(bufferedState.studio.current_card_id, answeredNow.card_id, 'the persisted answered Now card was not replaced by a relay');

  const initialActivity = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/ledger?project=${encodeURIComponent(identity.project_id)}&limit=100`);
    const body = await response.json();
    return body.entries.some((entry) => entry.card_id === bufferedCard.card_id && entry.event === 'buffered') ? body.entries : null;
  }, 'the hidden buffer ledger trace');
  const bufferedEntries = initialActivity.filter((entry) => entry.card_id === bufferedCard.card_id);
  assert.equal(
    bufferedEntries.filter((entry) => entry.event === 'buffered' && entry.state === 'waiting').length,
    1,
    'exactly one owner writes the hidden-buffer transition',
  );
  assert.equal(bufferedEntries.some((entry) => entry.event === 'delivery' && entry.state === 'delivered'), false);
  assert.equal(
    initialActivity.some((entry) => entry.report_id === reportId && entry.event === 'reconcile' && entry.message === 'lost at restart'),
    false,
    'exclusive reconciliation retains the durable in-flight candidate',
  );

  await stopServer(owner);
  const takeover = await waitFor(() => {
    const contenders = [relayA, relayB].filter((runner) => listeningPort(runner) === port);
    return contenders.length === 1 ? contenders[0] : null;
  }, 'exactly one relay to acquire the released HTTP port');
  await waitFor(() => health(port), 'the takeover owner health endpoint');
  await delay(150);

  assert.equal(await invocationCount(), 1, 'a takeover does not restart a completed provider chain behind its ready buffer');
  const afterTakeover = JSON.parse(await fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'));
  assert.equal(afterTakeover.studio?.ready_card?.card_id, bufferedCard.card_id, 'the winner retained the one hidden card');
  assert.equal(afterTakeover.studio?.current_card_id, answeredNow.card_id);
  const takeoverActivityResponse = await fetch(`http://127.0.0.1:${port}/ledger?project=${encodeURIComponent(identity.project_id)}&limit=100`);
  const takeoverActivity = (await takeoverActivityResponse.json()).entries;
  assert.equal(
    takeoverActivity.some((entry) => entry.report_id === reportId && entry.event === 'reconcile' && entry.message === 'lost at restart'),
    false,
    'the new exclusive owner does not falsely reconcile its ready buffer as lost',
  );
  assert.ok(takeover.stderr().includes(`HTTP listening on http://127.0.0.1:${port}`));
});

test('Ambient Watch runs only in the HTTP-owning server instance', { timeout: 12_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const primaryCwd = await temporaryProject(cleanup);
  const secondaryCwd = await temporaryProject(cleanup);
  const sessionsDir = await temporaryProject(cleanup);
  const now = new Date();
  const rolloutDirectory = path.join(
    sessionsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  const rolloutPath = path.join(rolloutDirectory, 'rollout-owner-test.jsonl');
  await fs.mkdir(rolloutDirectory, { recursive: true });
  await fs.writeFile(rolloutPath, '');

  const { port } = await startHttpServer(cleanup, {
    cwd: primaryCwd,
    extraEnv: {
      OSMOSIS_AMBIENT: '1',
      OSMOSIS_SESSIONS_DIR: sessionsDir,
      OSMOSIS_TEMPLATE_DELAY_MS: '60000',
    },
    captureMode: 'experimental-ambient',
  });
  // The owner attaches at EOF before we append a new session event.
  await delay(120);
  const secondary = startTrackedServer(cleanup, {
    cwd: secondaryCwd,
    port,
    extraEnv: {
      OSMOSIS_AMBIENT: '1',
      OSMOSIS_SESSIONS_DIR: sessionsDir,
      OSMOSIS_TEMPLATE_DELAY_MS: '60000',
    },
  });
  await waitFor(() => secondary.stderr().includes('HTTP disabled'), 'the ambient port guard');

  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: JSON.stringify({ cmd: 'node build.js', workdir: primaryCwd }),
      },
    })}\n`,
  );

  const reports = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/debug/reports`);
    const body = await response.json();
    return body.reports.some((report) => report.source === 'observed') ? body : null;
  }, 'the owner Ambient Watch report');
  assert.equal(reports.reports.at(-1).source, 'observed');

  // Give a wrongly-started loser enough time to complete its own 2s poll. It
  // must leave its project state untouched because it never owns the wall.
  await delay(2_200);
  const loserCards = await fs.readFile(path.join(secondaryCwd, '.osmosis', 'cards.json'), 'utf8').catch(() => null);
  assert.equal(loserCards, null);
});

test('record mode leaves Ambient Watch fully disabled even when explicitly opted in', { timeout: 8_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const sessionsDir = await temporaryProject(cleanup);
  const now = new Date();
  const rolloutDirectory = path.join(
    sessionsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  const rolloutPath = path.join(rolloutDirectory, 'rollout-record-mode.jsonl');
  await fs.mkdir(rolloutDirectory, { recursive: true });
  await fs.writeFile(rolloutPath, '');

  const { port } = await startHttpServer(cleanup, {
    cwd,
    extraEnv: {
      OSMOSIS_AMBIENT: '1',
      OSMOSIS_MODE: 'record',
      OSMOSIS_SESSIONS_DIR: sessionsDir,
      OSMOSIS_TEMPLATE_DELAY_MS: '60000',
    },
  });
  // If a watcher were accidentally started, let it attach at the empty EOF
  // before adding the qualifying event below.
  await delay(150);
  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: JSON.stringify({ cmd: 'node build.js', workdir: cwd }),
      },
    })}\n`,
  );

  // A live watcher polls every ~2 seconds. Waiting past that interval proves
  // record mode did not start one, rather than merely missing a short race.
  await delay(2_250);
  const reports = await (await fetch(`http://127.0.0.1:${port}/debug/reports`)).json();
  assert.deepEqual(reports.reports, []);
  const replay = await fs.readFile(path.join(cwd, '.osmosis', 'replay.json'), 'utf8').catch(() => null);
  assert.equal(replay, null);
});

test('a correct answer persists cards and user mastery, then survives an SSE reload snapshot', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const profileDir = path.join(cwd, 'profile');
  const { runner, port } = await startHttpServer(cleanup, { cwd, extraEnv: { OSMOSIS_PROFILE_DIR: profileDir } });
  const stream = await openTrackedEvents(cleanup, port);
  assert.equal((await stream.nextEvent()).type, 'snapshot');

  runner.child.stdin.write(`${JSON.stringify(reportMessage(1, 'Answer loop', 'Created a lesson that can be answered and saved.'))}\n`);
  await waitFor(() => runner.stdoutLines().length === 1, 'the report acknowledgement');
  const card = (await nextEventOfType(stream, 'card')).data;

  const preflight = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'null',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/i);
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

  const response = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_id: card.card_id, chosen_index: 0 }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const answer = await response.json();
  assert.deepEqual(Object.keys(answer).sort(), ['correct', 'explanation', 'strength']);
  assert.deepEqual(answer, {
    correct: true,
    explanation: 'Exactly. A milestone becomes a small, timely lesson so waiting for an agent can become learning time.',
    strength: 2,
  });

  const strengthEvent = await nextEventOfType(stream, 'strength');
  assert.deepEqual(strengthEvent.data, { concept_id: 'feedback-loop', strength: 2 });
  assert.equal((await nextEventOfType(stream, 'tree')).type, 'tree');

  const profile = JSON.parse(await fs.readFile(path.join(profileDir, 'profile.json'), 'utf8'));
  assert.equal(profile['feedback-loop'].strength, 2);
  assert.equal(profile['feedback-loop'].seen, 1);
  assert.equal(profile['feedback-loop'].correct, 1);

  const cardDocument = JSON.parse(await fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'));
  assert.equal(cardDocument.cards[0].state.answered, true);
  assert.equal(cardDocument.cards[0].state.correct, true);

  const reloadStream = await openTrackedEvents(cleanup, port);
  const reloadSnapshot = await reloadStream.nextEvent();
  const reloadedCard = reloadSnapshot.data.cards.find((item) => item.card_id === card.card_id);
  assert.equal(reloadedCard.state.answered, true);
  assert.equal(reloadedCard.state.correct, true);
  assert.equal(reloadedCard.explanation, answer.explanation);
  assert.equal('correct_index' in reloadedCard, false);
});

test('Studio keeps answered Now through live readiness and reload, then promotes Next without pacing', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const { runner, port } = await startHttpServer(cleanup, {
    cwd,
    extraEnv: { OSMOSIS_CARD_PACING_MS: '60000', OSMOSIS_TEMPLATE_DELAY_MS: '60' },
  });
  const stream = await openTrackedEvents(cleanup, port);
  assert.equal((await stream.nextEvent()).type, 'snapshot');

  runner.child.stdin.write(`${JSON.stringify(reportMessage(1, 'First report', 'Delivered the first report card.'))}\n`);
  await waitFor(() => runner.stdoutLines().length === 1, 'the first report acknowledgement');
  const firstCard = (await nextEventOfType(stream, 'card')).data;

  const wrongResponse = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_id: firstCard.card_id, chosen_index: 1 }),
  });
  assert.deepEqual(await wrongResponse.json(), {
    correct: false,
    explanation: 'Exactly. A milestone becomes a small, timely lesson so waiting for an agent can become learning time.',
    strength: 1,
  });

  runner.child.stdin.write(`${JSON.stringify(reportMessage(2, 'Second report', 'Delivered the ready Next lesson.'))}\n`);
  await waitFor(() => runner.stdoutLines().length === 2, 'the ready report acknowledgement');
  const liveReady = await nextEventMatching(
    stream,
    (event) => event.type === 'studio'
      && event.data.next_ready === true
      && event.data.current?.card_id === firstCard.card_id,
    'a live ready Next state without replacing Now',
  );
  assert.equal(liveReady.data.current.state.answered, true);
  assert.equal(liveReady.data.current.state.correct, false);
  assert.equal(liveReady.data.current.explanation, 'Exactly. A milestone becomes a small, timely lesson so waiting for an agent can become learning time.');
  assert.equal(liveReady.data.waiting, null);

  const projectId = (await health(port)).default_project_id;
  const reload = await (await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(projectId)}/snapshot`)).json();
  assert.equal(reload.studio.current.card_id, firstCard.card_id);
  assert.equal(reload.studio.current.state.answered, true);
  assert.equal(reload.studio.current.explanation, liveReady.data.current.explanation);
  assert.equal(reload.studio.next_ready, true);
  assert.equal(reload.studio.waiting, null);
  assert.equal(reload.cards.some((card) => card.source?.task === 'Second report'), false);

  // With Now and hidden Next full, the third report stays a bounded source
  // candidate instead of surfacing another lesson before the learner asks.
  runner.child.stdin.write(`${JSON.stringify(reportMessage(3, 'Third report', 'Stayed behind the Studio watermark.'))}\n`);
  await waitFor(() => runner.stdoutLines().length === 3, 'the suppressed third report acknowledgement');
  const watermark = JSON.parse(await fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'));
  assert.equal(watermark.cards.some((card) => card.source?.task === 'Third report'), false);
  assert.equal(watermark.studio.candidates.length, 1);

  const advanceStartedAt = Date.now();
  const advance = await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(projectId)}/next`, {
    method: 'POST',
  });
  assert.equal(advance.status, 200);
  const advanced = await advance.json();
  assert.ok(Date.now() - advanceStartedAt < 1_000, 'manual Next bypasses the 60 second unsolicited pace');
  const secondCard = advanced.card;
  assert.equal(secondCard.source.task, 'Second report');
  assert.equal(advanced.studio.current.card_id, secondCard.card_id);
  assert.equal(advanced.studio.next_ready, false);

  const promoted = await nextEventMatching(
    stream,
    (event) => event.type === 'studio' && event.data.current?.card_id === secondCard.card_id,
    'the promoted Next lesson',
  );
  assert.equal(promoted.data.next_ready, false);

  const promotedReload = await (await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(projectId)}/snapshot`)).json();
  assert.equal(promotedReload.studio.current.card_id, secondCard.card_id);
  assert.equal(promotedReload.cards.find((card) => card.card_id === firstCard.card_id).state.answered, true);
  assert.equal(promotedReload.cards.some((card) => card.card_id === secondCard.card_id), true);

  // The held third signal may now fill exactly one fresh Next buffer. It is
  // still never sent as a visible card before a subsequent explicit advance.
  await waitFor(async () => {
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(projectId)}/snapshot`)).json();
    return snapshot.studio.current?.card_id === secondCard.card_id && snapshot.studio.next_ready === true;
  }, 'the watermark refill after promotion');
});

test('Ambient Watch drives a registered project from an answered Now to a live ready Next over the real HTTP and SSE surface', { timeout: 12_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const primaryCwd = await temporaryProject(cleanup);
  const projectCwd = await temporaryProject(cleanup);
  const sessionsDir = await temporaryProject(cleanup);
  // The none provider intentionally uses one template concept. A sequenced
  // Codex shim makes this end-to-end contract prove the real case instead:
  // answer HTTP correctly, then let an observed event generate distinct JSON.
  const codexCommand = await writeSequencedCodexShim(primaryCwd);
  const now = new Date();
  const rolloutDirectory = path.join(
    sessionsDir,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  const rolloutPath = path.join(rolloutDirectory, 'rollout-studio-flow.jsonl');
  await fs.mkdir(rolloutDirectory, { recursive: true });
  // Existing files attach at EOF. Precreating this empty valid rollout file
  // makes the following append a real observer event rather than history.
  await fs.writeFile(rolloutPath, '');

  const { port } = await startHttpServer(cleanup, {
    activate: false,
    cwd: primaryCwd,
    extraEnv: {
      OSMOSIS_AMBIENT: '1',
      OSMOSIS_AMBIENT_EMIT_INTERVAL_MS: '1',
      OSMOSIS_CARD_PACING_MS: '60000',
      OSMOSIS_CODEX_COMMAND: codexCommand,
      OSMOSIS_PROVIDER: 'codex',
      OSMOSIS_SESSIONS_DIR: sessionsDir,
      OSMOSIS_TEMPLATE_DELAY_MS: '60000',
    },
  });

  const pendingRegistration = await fetch(`http://127.0.0.1:${port}/internal/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: projectCwd }),
  });
  assert.equal(pendingRegistration.status, 200);
  const pending = await pendingRegistration.json();
  assert.equal(typeof pending.project_id, 'string');

  const activation = await fetch(`http://127.0.0.1:${port}/activation?project=${encodeURIComponent(pending.project_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      auto_advance: false,
      capture_mode: 'experimental-ambient',
      carry: true,
      lesson_locale: 'en',
    }),
  });
  assert.equal(activation.status, 200);

  // Re-register after Carry so the frozen relay route receives a live
  // capability, then use HTTP to deliver the focused starter/Now card.
  const registrationResponse = await fetch(`http://127.0.0.1:${port}/internal/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: projectCwd }),
  });
  const registration = await registrationResponse.json();
  assert.equal(registrationResponse.status, 200);
  assert.equal(registration.project_id, pending.project_id);
  assert.equal(typeof registration.token, 'string');

  const stream = await openTrackedEvents(cleanup, port);
  assert.equal((await stream.nextEvent()).type, 'snapshot');
  assert.equal((await stream.nextEvent()).type, 'snapshot-v2');

  const starter = await fetch(`http://127.0.0.1:${port}/internal/reports?project=${encodeURIComponent(registration.project_id)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-osmosis-token': registration.token,
    },
    body: JSON.stringify({
      task: 'Starter lesson',
      what_i_did: 'Delivered the first focused Studio question through the registered project relay.',
      stack_hints: ['Node.js', 'HTTP'],
    }),
  });
  assert.equal(starter.status, 202);
  const firstCard = (await nextEventMatching(
    stream,
    (event) => event.type === 'project-card' && event.data.project_id === registration.project_id,
    'the registered project starter card',
  )).data;
  assert.equal(firstCard.source.kind, 'agent');
  assert.match(firstCard.concept_id, /:http$/);

  const answered = await fetch(`http://127.0.0.1:${port}/answer?project=${encodeURIComponent(registration.project_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_id: firstCard.card_id, chosen_index: 0 }),
  });
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).correct, true);

  // Let the watcher complete the empty-file EOF baseline, then append an
  // actual Codex exec rollout event. This exercises watcher -> broker ->
  // Studio generation rather than the agent-only relay path above.
  await delay(150);
  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: JSON.stringify({ cmd: 'node build.js', workdir: projectCwd }),
      },
    })}\n`,
  );

  const liveReady = await nextEventMatching(
    stream,
    (event) => event.type === 'project-studio'
      && event.data.project_id === registration.project_id
      && event.data.current?.card_id === firstCard.card_id
      && event.data.next_ready === true,
    'the observed ready-Next SSE flip',
  );
  assert.equal(liveReady.data.current.state.answered, true);
  assert.equal(liveReady.data.waiting, null);

  const snapshot = await (await fetch(
    `http://127.0.0.1:${port}/projects/${encodeURIComponent(registration.project_id)}/snapshot`,
  )).json();
  assert.equal(snapshot.studio.current.card_id, firstCard.card_id);
  assert.equal(snapshot.studio.current.state.answered, true);
  assert.equal(snapshot.studio.next_ready, true);
  assert.equal(snapshot.studio.waiting, null);
  assert.equal(snapshot.cards.some((card) => card.source?.kind === 'observed-activity'), false, 'the ready card is unavailable until Next');

  const next = await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(registration.project_id)}/next`, {
    method: 'POST',
  });
  assert.equal(next.status, 200);
  const advanced = await next.json();
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.card.source.kind, 'observed-activity');
  assert.match(advanced.card.concept_id, /:json$/);
  assert.notEqual(advanced.card.concept_id, firstCard.concept_id, 'the observed follow-up is a distinct unmastered concept');
  assert.equal(advanced.studio.current.card_id, advanced.card.card_id);
  assert.equal(advanced.studio.next_ready, false);

  const promoted = await nextEventMatching(
    stream,
    (event) => event.type === 'project-studio'
      && event.data.project_id === registration.project_id
      && event.data.current?.card_id === advanced.card.card_id,
    'the promoted observed Next lesson',
  );
  assert.equal(promoted.data.next_ready, false);
});

test('a mono-concept mastered ready card is honestly suppressed instead of leaving a misleading delivered trail', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const { runner, port } = await startHttpServer(cleanup, {
    cwd,
    extraEnv: { OSMOSIS_CARD_PACING_MS: '60000', OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  const stream = await openTrackedEvents(cleanup, port);
  assert.equal((await stream.nextEvent()).type, 'snapshot');

  runner.child.stdin.write(`${JSON.stringify(reportMessage(1, 'First mono report', 'Created the first template lesson.'))}\n`);
  await waitFor(() => runner.stdoutLines().length === 1, 'the first mono report acknowledgement');
  const firstCard = (await nextEventOfType(stream, 'card')).data;

  // Do this before answering the first card: the second template lesson is
  // legitimately buffered, then the correct answer makes the shared concept
  // gold and must close that buffer with an explicit ledger refusal.
  runner.child.stdin.write(`${JSON.stringify(reportMessage(2, 'Second mono report', 'Created the same template concept for the hidden buffer.'))}\n`);
  await waitFor(() => runner.stdoutLines().length === 2, 'the second mono report acknowledgement');
  await nextEventMatching(
    stream,
    (event) => event.type === 'studio' && event.data.next_ready === true,
    'the temporary same-concept ready buffer',
  );

  const projectId = (await health(port)).default_project_id;
  const buffered = await waitFor(async () => {
    const document = JSON.parse(await fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'));
    return document.studio?.ready_card || null;
  }, 'the durable same-concept ready card');
  assert.equal(buffered.concept_id, firstCard.concept_id);

  const answered = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_id: firstCard.card_id, chosen_index: 0 }),
  });
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).strength, 2);

  const idleSnapshot = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(projectId)}/snapshot`);
    const snapshot = await response.json();
    return snapshot.studio.next_ready === false && snapshot.studio.waiting?.reason === 'idle' ? snapshot : null;
  }, 'the honest idle Studio state after mastered cleanup');
  assert.equal(idleSnapshot.studio.current.card_id, firstCard.card_id);
  assert.equal(idleSnapshot.studio.current.state.answered, true);

  const activity = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/ledger?project=${encodeURIComponent(projectId)}&limit=100`);
    const body = await response.json();
    const records = body.entries.filter((entry) => entry.card_id === buffered.card_id);
    return records.some((entry) => entry.event === 'refusal' && entry.reason === 'mastered' && entry.state === 'suppressed')
      ? records
      : null;
  }, 'the terminal mastered ledger trace for the cleared buffer');
  assert.equal(
    activity.some((entry) => entry.event === 'delivery' && entry.state === 'delivered'),
    false,
    'a hidden ready card was buffered, never visibly delivered before mastery suppressed it',
  );
  assert.equal(
    activity.some((entry) => entry.event === 'buffered' && entry.state === 'waiting'),
    true,
    'the ledger distinguishes a hidden Next buffer from a visible lesson delivery',
  );
  const final = activity.at(-1);
  assert.deepEqual(
    { event: final.event, reason: final.reason, state: final.state },
    { event: 'refusal', reason: 'mastered', state: 'suppressed' },
  );
});

test('record mode creates a clean replay from reports but excludes starter cards and requeues', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const { runner, port } = await startHttpServer(cleanup, {
    cwd,
    extraEnv: { OSMOSIS_MODE: 'record', OSMOSIS_TEMPLATE_DELAY_MS: '250' },
  });
  const stream = await openTrackedEvents(cleanup, port);
  assert.deepEqual((await stream.nextEvent()).data.cards, []);
  await delay(350);
  await assert.rejects(fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'), { code: 'ENOENT' });

  runner.child.stdin.write(`${JSON.stringify(reportMessage(1, 'M1', 'Recorded the first real lesson.'))}\n`);
  await waitFor(() => runner.stdoutLines().length === 1, 'the first record acknowledgement');
  const firstCard = (await nextEventOfType(stream, 'card')).data;
  const wrongResponse = await fetch(`http://127.0.0.1:${port}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_id: firstCard.card_id, chosen_index: 1 }),
  });
  assert.equal((await wrongResponse.json()).correct, false);

  runner.child.stdin.write(
    `${JSON.stringify(reportMessage(2, 'M2', 'Recorded the first intervening lesson.'))}\n${JSON.stringify(reportMessage(3, 'M3', 'Recorded the second intervening lesson.'))}\n`,
  );
  await waitFor(() => runner.stdoutLines().length === 3, 'the later record acknowledgements');
  const secondCard = (await nextEventOfType(stream, 'card')).data;
  const thirdCard = (await nextEventOfType(stream, 'card')).data;
  const requeuedCard = (await nextEventOfType(stream, 'card')).data;
  assert.equal(secondCard.source.task, 'M2');
  assert.equal(thirdCard.source.task, 'M3');
  assert.equal(requeuedCard.source.task, 'M1');

  const replay = JSON.parse(await fs.readFile(path.join(cwd, '.osmosis', 'replay.json'), 'utf8'));
  assert.equal(replay.format, 'osmosis-replay');
  assert.equal(replay.provider, 'none');
  assert.deepEqual(replay.entries.map((entry) => entry.trigger.task), ['M1', 'M2', 'M3']);
  assert.equal(replay.entries.length, 3);
  assert.equal('card_id' in replay.entries[0].card, false);
  assert.equal('state' in replay.entries[0].card, false);
});

test('replay mode emits recorded concepts in order for real reports and stops cleanly at exhaustion', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  await fs.mkdir(path.join(cwd, '.osmosis'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, '.osmosis', 'replay.json'),
    JSON.stringify({
      format: 'osmosis-replay',
      version: 1,
      recorded_at: '2026-07-18T00:00:00.000Z',
      provider: 'none',
      tree: { meta: {}, nodes: [] },
      entries: [
        {
          sequence: 1,
          recorded_at: '2026-07-18T00:00:01.000Z',
          trigger: { task: 'Recorded M1', what_i_did: 'Recorded first lesson.', stack_hints: ['Node.js'] },
          card: {
            concept_id: 'event-loop',
            concept_name: 'The event loop',
            lesson: 'Your app takes one small job at a time so it can stay responsive.',
            question: 'What does the event loop help your app do?',
            options: ['Keep handling one small job at a time.', 'Store every image forever.', 'Remove all user clicks.'],
            correct_index: 0,
            explanation: 'It coordinates small jobs so the app can respond.',
          },
        },
        {
          sequence: 2,
          recorded_at: '2026-07-18T00:00:02.000Z',
          trigger: { task: 'Recorded M2', what_i_did: 'Recorded second lesson.', stack_hints: ['DOM'] },
          card: {
            concept_id: 'data-flow',
            concept_name: 'Data flow',
            lesson: 'Information moves from an action to a decision and then to the screen.',
            question: 'What does data flow describe?',
            options: ['How information moves through the app.', 'How to erase app state.', 'How to avoid every button.'],
            correct_index: 0,
            explanation: 'It is the route information follows through the app.',
          },
        },
      ],
    }),
  );
  const { runner, port } = await startHttpServer(cleanup, {
    cwd,
    extraEnv: { OSMOSIS_MODE: 'replay', OSMOSIS_TEMPLATE_DELAY_MS: '250' },
  });
  const stream = await openTrackedEvents(cleanup, port);
  assert.deepEqual((await stream.nextEvent()).data.cards, []);
  await delay(350);
  await assert.rejects(fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'), { code: 'ENOENT' });

  runner.child.stdin.write(
    `${JSON.stringify(reportMessage(1, 'Live M1', 'Triggered the first replay lesson.'))}\n${JSON.stringify(reportMessage(2, 'Live M2', 'Triggered the second replay lesson.'))}\n${JSON.stringify(reportMessage(3, 'Live M3', 'Tried to trigger beyond the replay.'))}\n`,
  );
  await waitFor(() => runner.stdoutLines().length === 3, 'the replay acknowledgements');
  const firstCard = (await nextEventOfType(stream, 'card')).data;
  const secondCard = (await nextEventOfType(stream, 'card')).data;
  assert.equal(firstCard.concept_id, 'event-loop');
  assert.equal(firstCard.source.what_i_did, 'Triggered the first replay lesson.');
  assert.equal(secondCard.concept_id, 'data-flow');
  assert.equal(secondCard.source.what_i_did, 'Triggered the second replay lesson.');

  const complete = await nextEventMatching(
    stream,
    (event) => event.type === 'status' && event.data.state === 'replay-complete',
    'a replay-complete status',
  );
  assert.equal(complete.data.message, 'Replay has no more recorded lessons.');
  const cards = JSON.parse(await fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'));
  assert.equal(cards.cards.length, 2);
});

test('the Codex provider builds a first tree and source-linked card without a template starter', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const codexCommand = await writeCodexShim(cwd);
  const { runner, port } = await startHttpServer(cleanup, {
    cwd,
    extraEnv: {
      OSMOSIS_CARD_PACING_MS: '0',
      OSMOSIS_CODEX_COMMAND: codexCommand,
      OSMOSIS_PROVIDER: 'codex',
      OSMOSIS_TEMPLATE_DELAY_MS: '150',
    },
  });
  const stream = await openTrackedEvents(cleanup, port);
  assert.deepEqual((await stream.nextEvent()).data.cards, []);
  await delay(250);
  await assert.rejects(fs.readFile(path.join(cwd, '.osmosis', 'cards.json'), 'utf8'), { code: 'ENOENT' });

  runner.child.stdin.write(`${JSON.stringify(reportMessage(1, 'HTTP route', 'Added an HTTP route for the app.', ['HTTP']))}\n`);
  await waitFor(() => runner.stdoutLines().length === 1, 'the Codex report acknowledgement');
  const generating = await nextEventOfType(stream, 'status');
  assert.equal(generating.data.message, 'Generating (this provider is slower).');
  assert.equal(generating.data.provider, 'codex');
  const tree = await nextEventOfType(stream, 'tree');
  assert.equal(tree.data.nodes.length, 13);
  const card = await nextEventOfType(stream, 'card');
  assert.match(card.data.concept_id, /:http$/);
  assert.equal(tree.data.nodes.every((node) => node.concept_id.includes(':')), true);
  assert.equal(card.data.source.what_i_did, 'Added an HTTP route for the app.');
  assert.equal(runner.stdoutLines().length, 1);
});

test('a failed Codex generation retries then records a failed state without crashing the MCP server', { timeout: 10_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const cwd = await temporaryProject(cleanup);
  const codexCommand = await writeFailingCodexShim(cwd);
  const { runner, port } = await startHttpServer(cleanup, {
    cwd,
    extraEnv: { OSMOSIS_CODEX_COMMAND: codexCommand, OSMOSIS_PROVIDER: 'codex' },
  });
  const stream = await openTrackedEvents(cleanup, port);
  await stream.nextEvent();

  runner.child.stdin.write(`${JSON.stringify(reportMessage(1, 'Failed generation', 'Tried a guarded Codex lesson generation.', ['Codex']))}\n`);
  await waitFor(() => runner.stdoutLines().length === 1, 'the failed-generation acknowledgement');
  assert.equal((await nextEventOfType(stream, 'status')).data.state, 'generating');
  const failed = await nextEventMatching(stream, (event) => event.type === 'status' && event.data.state === 'failed', 'an explicit failed status');
  assert.match(failed.data.message, /could not make a lesson/i);
  assert.equal((await health(port)).provider, 'codex');
  assert.equal(runner.stdoutLines().length, 1);
});

test('a mastered none-provider concept carries across projects without generating another card', { timeout: 15_000 }, async (t) => {
  const cleanup = createTestCleanup(t);
  const root = await temporaryProject(cleanup);
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const profileDir = path.join(root, 'shared-profile');
  await fs.mkdir(projectA, { recursive: true });
  await fs.mkdir(projectB, { recursive: true });

  const { runner: serverA, port: portA } = await startHttpServer(cleanup, {
    cwd: projectA,
    extraEnv: { OSMOSIS_PROFILE_DIR: profileDir, OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  const streamA = await openTrackedEvents(cleanup, portA);
  await streamA.nextEvent();

  serverA.child.stdin.write(`${JSON.stringify(reportMessage(1, 'Project A M1', 'Created the first project lesson.'))}\n`);
  await waitFor(() => serverA.stdoutLines().length === 1, 'project A acknowledgement');
  const cardA = (await nextEventOfType(streamA, 'card')).data;
  const answerA = await fetch(`http://127.0.0.1:${portA}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card_id: cardA.card_id, chosen_index: 0 }),
  });
  assert.equal((await answerA.json()).strength, 2);
  await stopServer(serverA);

  await fs.mkdir(path.join(projectB, '.osmosis'), { recursive: true });
  await fs.writeFile(
    path.join(projectB, '.osmosis', 'tree.json'),
    JSON.stringify({
      meta: { created_at: new Date(Date.now() + 1_000).toISOString() },
      nodes: [
        { concept_id: 'project-map', concept_name: 'Your project', parent_id: null },
        { concept_id: 'feedback-loop', concept_name: 'The feedback loop', parent_id: 'project-map' },
      ],
    }),
  );

  const { runner: serverB, port: portB } = await startHttpServer(cleanup, {
    cwd: projectB,
    extraEnv: { OSMOSIS_PROFILE_DIR: profileDir, OSMOSIS_TEMPLATE_DELAY_MS: '60000' },
  });
  const healthB = await health(portB);
  assert.equal(healthB.processCwd, await fs.realpath(projectB));
  const streamB = await openTrackedEvents(cleanup, portB);
  const snapshotB = await streamB.nextEvent();
  assert.equal(snapshotB.data.strengths['feedback-loop'].strength, 2);
  assert.equal(snapshotB.data.tree.nodes.length, 2);
  assert.deepEqual(snapshotB.data.cards, []);

  serverB.child.stdin.write(`${JSON.stringify(reportMessage(1, 'Project B M1', 'Started a second project with the same concept.'))}\n`);
  await waitFor(() => serverB.stdoutLines().length === 1, 'project B acknowledgement');
  const skipped = await nextEventMatching(
    streamB,
    (event) => event.type === 'status' && event.data.state === 'skipped',
    'a mastered-concept skip',
  );
  assert.equal(skipped.data.concept_id, 'feedback-loop');
  const reports = await (await fetch(`http://127.0.0.1:${portB}/debug/reports`)).json();
  assert.deepEqual(reports.reports.map((report) => report.task), ['Project B M1']);
  await delay(100);
  // Studio persists its tiny watermark even when the mastered concept is
  // skipped; it must not persist a duplicate lesson card.
  const studioDocument = JSON.parse(await fs.readFile(path.join(projectB, '.osmosis', 'cards.json'), 'utf8'));
  assert.deepEqual(studioDocument.cards, []);
});
