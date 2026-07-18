'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAmbientWatcher, dateDirectories } = require('../lib/ambient');
const { AMBIENT_IGNORE_ENV, createProvider } = require('../lib/provider');

function cardJson() {
  return {
    concept_id: 'http',
    concept_name: 'HTTP',
    lesson: 'HTTP carries a request to a server and brings a response back, like a labeled envelope between two places.',
    question: 'What does HTTP carry?',
    options: ['A request and response.', 'Only page colors.', 'A computer fan.'],
    correct_index: 0,
    explanation: 'HTTP is the request-and-response path.',
  };
}

function fakeCodexScript() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const outputPath = args[args.indexOf('--output-last-message') + 1];

function inspect(filename) {
  const filePath = path.join(process.env.CODEX_HOME, filename);
  const exists = fs.existsSync(filePath);
  return {
    exists,
    content: exists ? fs.readFileSync(filePath, 'utf8') : null,
    isSymbolicLink: exists ? fs.lstatSync(filePath).isSymbolicLink() : false,
  };
}

let finished = false;
function finish(stdinState) {
  if (finished) return;
  finished = true;
  clearTimeout(stdinTimer);
  const files = {
    auth: inspect('auth.json'),
    config: inspect('config.toml'),
  };
  for (const filename of ['auth.json', 'config.toml']) {
    const filePath = path.join(process.env.CODEX_HOME, filename);
    if (fs.existsSync(filePath)) fs.appendFileSync(filePath, '\\nchild-write');
  }
  fs.writeFileSync(process.env.OSMOSIS_PROVIDER_CAPTURE_PATH, JSON.stringify({
    codexHome: process.env.CODEX_HOME,
    codexHomeExists: fs.existsSync(process.env.CODEX_HOME),
    files,
    marker: process.env.${AMBIENT_IGNORE_ENV},
    stdinState,
  }));
  fs.writeFileSync(outputPath, ${JSON.stringify(JSON.stringify(cardJson()))});
}

const stdinTimer = setTimeout(() => finish('timed-out'), 250);
stdinTimer.unref();
process.stdin.once('error', () => finish('error'));
process.stdin.once('end', () => finish('ended'));
process.stdin.resume();
`;
}

test('the Codex generator receives a fresh isolated CODEX_HOME and ambient-ignore marker', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-provider-isolation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const commandPath = path.join(directory, 'fake-codex.js');
  const capturePath = path.join(directory, 'child-environment.json');
  const realCodexHome = path.join(directory, 'real-codex-home');
  const authContents = '{"token":"test-only"}\n';
  const configContents = 'model = "test-model"\n';
  await fs.mkdir(realCodexHome);
  await Promise.all([
    fs.writeFile(path.join(realCodexHome, 'auth.json'), authContents),
    fs.writeFile(path.join(realCodexHome, 'config.toml'), configContents),
    fs.writeFile(commandPath, fakeCodexScript(), { mode: 0o755 }),
  ]);

  const previousCapturePath = process.env.OSMOSIS_PROVIDER_CAPTURE_PATH;
  process.env.OSMOSIS_PROVIDER_CAPTURE_PATH = capturePath;
  t.after(() => {
    if (previousCapturePath === undefined) {
      delete process.env.OSMOSIS_PROVIDER_CAPTURE_PATH;
    } else {
      process.env.OSMOSIS_PROVIDER_CAPTURE_PATH = previousCapturePath;
    }
  });

  const provider = createProvider({
    codexHome: realCodexHome,
    codexCommand: commandPath,
    codexTimeoutMs: 5_000,
    cwd: directory,
    provider: 'codex',
  });
  const card = await provider.generateCard({
    concepts: [{ concept_id: 'http', concept_name: 'HTTP', parent_id: 'data' }],
    masteredConceptIds: [],
    report: { task: 'Observed work', what_i_did: 'Observed HTTP.', stack_hints: ['HTTP'], source: 'observed' },
  });
  provider.close();

  const captured = JSON.parse(await fs.readFile(capturePath, 'utf8'));
  assert.equal(card.concept_id, 'http');
  assert.equal(captured.codexHomeExists, true);
  assert.equal(captured.marker, '1');
  assert.equal(captured.stdinState, 'ended');
  assert.deepEqual(captured.files.auth, { exists: true, content: authContents, isSymbolicLink: false });
  assert.deepEqual(captured.files.config, { exists: true, content: configContents, isSymbolicLink: false });
  assert.notEqual(captured.codexHome, process.env.CODEX_HOME);
  assert.notEqual(captured.codexHome, realCodexHome);
  assert.match(captured.codexHome, /osmosis-codex-.+codex-home$/);
  assert.equal(await fs.readFile(path.join(realCodexHome, 'auth.json'), 'utf8'), authContents);
  assert.equal(await fs.readFile(path.join(realCodexHome, 'config.toml'), 'utf8'), configContents);
  await assert.rejects(fs.access(captured.codexHome), { code: 'ENOENT' });
});

test('the isolated Codex home leaves absent auth and config files absent', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-provider-empty-home-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const commandPath = path.join(directory, 'fake-codex.js');
  const capturePath = path.join(directory, 'child-environment.json');
  const emptyRealCodexHome = path.join(directory, 'empty-real-codex-home');
  await fs.mkdir(emptyRealCodexHome);
  await fs.writeFile(commandPath, fakeCodexScript(), { mode: 0o755 });

  const previousCapturePath = process.env.OSMOSIS_PROVIDER_CAPTURE_PATH;
  process.env.OSMOSIS_PROVIDER_CAPTURE_PATH = capturePath;
  t.after(() => {
    if (previousCapturePath === undefined) {
      delete process.env.OSMOSIS_PROVIDER_CAPTURE_PATH;
    } else {
      process.env.OSMOSIS_PROVIDER_CAPTURE_PATH = previousCapturePath;
    }
  });

  const provider = createProvider({
    codexHome: emptyRealCodexHome,
    codexCommand: commandPath,
    codexTimeoutMs: 5_000,
    cwd: directory,
    provider: 'codex',
  });
  const card = await provider.generateCard({
    concepts: [{ concept_id: 'http', concept_name: 'HTTP', parent_id: 'data' }],
    masteredConceptIds: [],
    report: { task: 'Observed work', what_i_did: 'Observed HTTP.', stack_hints: ['HTTP'], source: 'observed' },
  });
  provider.close();

  const captured = JSON.parse(await fs.readFile(capturePath, 'utf8'));
  assert.equal(card.concept_id, 'http');
  assert.equal(captured.codexHomeExists, true);
  assert.equal(captured.stdinState, 'ended');
  assert.deepEqual(captured.files.auth, { exists: false, content: null, isSymbolicLink: false });
  assert.deepEqual(captured.files.config, { exists: false, content: null, isSymbolicLink: false });
  await assert.rejects(fs.access(captured.codexHome), { code: 'ENOENT' });
});

test('generator rollout activity stays outside the real Ambient Watch session store', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-provider-watcher-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const watchedCodexHome = path.join(directory, 'watched-codex-home');
  const watchedSessionsDir = path.join(watchedCodexHome, 'sessions');
  const projectDir = path.join(directory, 'project');
  const commandPath = path.join(directory, 'fake-codex-rollout.js');
  const capturePath = path.join(directory, 'child-rollout.json');
  const now = Date.now();
  const watchedDirectory = dateDirectories(watchedSessionsDir, now)[0];
  const watchedRollout = path.join(watchedDirectory, 'rollout-generator.jsonl');
  await fs.mkdir(projectDir, { recursive: true });
  // Attach the watcher to this empty file before generation. Without child
  // CODEX_HOME isolation, the fake command below appends to this exact file.
  await fs.mkdir(watchedDirectory, { recursive: true });
  await fs.writeFile(watchedRollout, '');
  await fs.utimes(watchedRollout, new Date(now), new Date(now));
  await fs.writeFile(
    commandPath,
    `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const outputPath = args[args.indexOf('--output-last-message') + 1];
const date = new Date();
const rolloutDirectory = path.join(
  process.env.CODEX_HOME,
  'sessions',
  String(date.getFullYear()),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
);
const rolloutPath = path.join(rolloutDirectory, 'rollout-generator.jsonl');
fs.mkdirSync(rolloutDirectory, { recursive: true });
fs.appendFileSync(rolloutPath, JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'custom_tool_call',
    name: 'exec',
    input: JSON.stringify({ cmd: 'node generated-lesson.js', workdir: process.env.OSMOSIS_PROVIDER_PROJECT_DIR }),
  },
}) + '\\n');
fs.writeFileSync(process.env.OSMOSIS_PROVIDER_CAPTURE_PATH, JSON.stringify({
  codexHome: process.env.CODEX_HOME,
  rolloutPath,
}));
fs.writeFileSync(outputPath, ${JSON.stringify(JSON.stringify(cardJson()))});
`,
    { mode: 0o755 },
  );

  const reports = [];
  const watcher = createAmbientWatcher({
    config: {
      ambientEnabled: true,
      ambientEmitIntervalMs: 1,
      cwd: projectDir,
      sessionsDir: watchedSessionsDir,
    },
    onReport: (report) => reports.push(report),
  });
  t.after(() => watcher.stop());
  await watcher.poll();

  const previousCodexHome = process.env.CODEX_HOME;
  const previousCapturePath = process.env.OSMOSIS_PROVIDER_CAPTURE_PATH;
  const previousProjectDir = process.env.OSMOSIS_PROVIDER_PROJECT_DIR;
  process.env.CODEX_HOME = watchedCodexHome;
  process.env.OSMOSIS_PROVIDER_CAPTURE_PATH = capturePath;
  process.env.OSMOSIS_PROVIDER_PROJECT_DIR = projectDir;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousCapturePath === undefined) delete process.env.OSMOSIS_PROVIDER_CAPTURE_PATH;
    else process.env.OSMOSIS_PROVIDER_CAPTURE_PATH = previousCapturePath;
    if (previousProjectDir === undefined) delete process.env.OSMOSIS_PROVIDER_PROJECT_DIR;
    else process.env.OSMOSIS_PROVIDER_PROJECT_DIR = previousProjectDir;
  });

  const provider = createProvider({
    codexHome: watchedCodexHome,
    codexCommand: commandPath,
    codexTimeoutMs: 5_000,
    cwd: projectDir,
    provider: 'codex',
  });
  await provider.generateCard({
    concepts: [{ concept_id: 'http', concept_name: 'HTTP', parent_id: 'data' }],
    masteredConceptIds: [],
    report: { task: 'Observed work', what_i_did: 'Observed HTTP.', stack_hints: ['HTTP'], source: 'observed' },
  });
  provider.close();

  const captured = JSON.parse(await fs.readFile(capturePath, 'utf8'));
  assert.notEqual(captured.codexHome, watchedCodexHome);
  assert.notEqual(captured.rolloutPath, watchedRollout);
  await watcher.poll();
  assert.deepEqual(reports, []);
});
