'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAmbientWatcher, dateDirectories } = require('../lib/ambient');
const { AMBIENT_IGNORE_ENV, GENERATOR_CHILD_ENV, createProvider } = require('../lib/provider');

const SERVER_PATH = path.resolve(__dirname, '..', 'server.js');

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
    generatorChild: process.env.${GENERATOR_CHILD_ENV},
    cwd: process.cwd(),
    args,
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

function sentinelAwareCodexScript() {
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const outputPath = args[args.indexOf('--output-last-message') + 1];
const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
// This is a deliberately tiny Codex-style config probe. A leaked MCP server
// stanza would make the probe record that its sentinel could have launched.
if (config.includes('[mcp_servers.sentinel]')) {
  fs.writeFileSync(process.env.OSMOSIS_PROVIDER_SENTINEL_PATH, 'sentinel would have started');
}
fs.writeFileSync(process.env.OSMOSIS_PROVIDER_CAPTURE_PATH, JSON.stringify({
  config,
  cwd: process.cwd(),
  args,
  generatorChild: process.env.${GENERATOR_CHILD_ENV},
}));
fs.writeFileSync(outputPath, ${JSON.stringify(JSON.stringify(cardJson()))});
`;
}

function runNodeProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('the Codex generator receives a fresh isolated CODEX_HOME and ambient-ignore marker', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-provider-isolation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const commandPath = path.join(directory, 'fake-codex.js');
  const capturePath = path.join(directory, 'child-environment.json');
  const realCodexHome = path.join(directory, 'real-codex-home');
  const authContents = '{"token":"test-only"}\n';
  const configContents = [
    '# child should retain only these root model settings',
    'model = "test-model"',
    'model_reasoning_effort = "high"',
    'service_tier = "priority"',
    'unrelated_root_setting = "must-not-copy"',
    '',
    '[mcp_servers.osmosis]',
    'command = "node"',
    'args = ["server.js"]',
    '',
    '[plugins]',
    'enabled = true',
    '',
    '[hooks]',
    'notify = "must-not-copy"',
    '',
    '[notifications]',
    'enabled = true',
    '',
    '[projects."/private/project"]',
    'trust_level = "trusted"',
    '',
  ].join('\n');
  const expectedChildConfig = [
    'model = "test-model"',
    'model_reasoning_effort = "high"',
    'service_tier = "priority"',
    '',
  ].join('\n');
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
  assert.equal(captured.generatorChild, '1');
  assert.equal(captured.stdinState, 'ended');
  assert.equal(captured.cwd.includes('generator-workdir'), true);
  assert.equal(captured.args.includes('--cd'), true);
  assert.equal(captured.args.includes('--ignore-rules'), true);
  assert.deepEqual(captured.files.auth, { exists: true, content: authContents, isSymbolicLink: false });
  assert.deepEqual(captured.files.config, { exists: true, content: expectedChildConfig, isSymbolicLink: false });
  assert.equal(captured.files.config.content.includes('mcp_servers'), false);
  assert.equal(captured.files.config.content.includes('plugins'), false);
  assert.equal(captured.files.config.content.includes('hooks'), false);
  assert.equal(captured.files.config.content.includes('notifications'), false);
  assert.equal(captured.files.config.content.includes('private/project'), false);
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
  assert.equal(captured.generatorChild, '1');
  assert.equal(captured.stdinState, 'ended');
  assert.deepEqual(captured.files.auth, { exists: false, content: null, isSymbolicLink: false });
  assert.deepEqual(captured.files.config, { exists: false, content: null, isSymbolicLink: false });
  await assert.rejects(fs.access(captured.codexHome), { code: 'ENOENT' });
});

test('the real provider child pipeline strips a sentinel MCP server before a Codex-style loader can launch it', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'osmosis-provider-sentinel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const commandPath = path.join(directory, 'codex-config-probe.js');
  const capturePath = path.join(directory, 'child-environment.json');
  const sentinelPath = path.join(directory, 'sentinel-started');
  const realCodexHome = path.join(directory, 'real-codex-home');
  await fs.mkdir(realCodexHome);
  await Promise.all([
    fs.writeFile(path.join(realCodexHome, 'auth.json'), '{"token":"test-only"}\n'),
    fs.writeFile(
      path.join(realCodexHome, 'config.toml'),
      [
        'model = "test-model"',
        '',
        '[mcp_servers.sentinel]',
        'command = "node"',
        'args = ["/this/must/never/run.js"]',
        '',
        '[hooks]',
        'post_tool_use = "also-must-not-copy"',
        '',
      ].join('\n'),
    ),
    fs.writeFile(commandPath, sentinelAwareCodexScript(), { mode: 0o755 }),
  ]);

  const previousCapturePath = process.env.OSMOSIS_PROVIDER_CAPTURE_PATH;
  const previousSentinelPath = process.env.OSMOSIS_PROVIDER_SENTINEL_PATH;
  process.env.OSMOSIS_PROVIDER_CAPTURE_PATH = capturePath;
  process.env.OSMOSIS_PROVIDER_SENTINEL_PATH = sentinelPath;
  t.after(() => {
    if (previousCapturePath === undefined) delete process.env.OSMOSIS_PROVIDER_CAPTURE_PATH;
    else process.env.OSMOSIS_PROVIDER_CAPTURE_PATH = previousCapturePath;
    if (previousSentinelPath === undefined) delete process.env.OSMOSIS_PROVIDER_SENTINEL_PATH;
    else process.env.OSMOSIS_PROVIDER_SENTINEL_PATH = previousSentinelPath;
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
  assert.equal(captured.config, 'model = "test-model"\n');
  assert.equal(captured.config.includes('mcp_servers'), false);
  assert.equal(captured.config.includes('sentinel'), false);
  assert.equal(captured.config.includes('hooks'), false);
  assert.equal(captured.generatorChild, '1');
  assert.equal(captured.cwd.includes('generator-workdir'), true);
  await assert.rejects(fs.access(sentinelPath), { code: 'ENOENT' });
});

test('the generator-child guard makes server.js exit before it starts MCP or HTTP work', async () => {
  const result = await runNodeProcess(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      [GENERATOR_CHILD_ENV]: '1',
      OSMOSIS_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
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
