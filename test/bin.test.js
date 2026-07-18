'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MOUNT_PROMPT,
  buildRuntimeManifest,
  commandInvocation,
  decideMount,
  healthCheck,
  installRuntime,
  mountArgs,
  mountOsmosis,
  openBrowser,
  parseArgs,
  run,
} = require('../bin/osmosis');

const REPOSITORY_ROOT = path.join(__dirname, '..');
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function makeDirectory(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFixtureRuntime(root) {
  await Promise.all([
    fs.mkdir(path.join(root, 'bin'), { recursive: true }),
    fs.mkdir(path.join(root, 'lib'), { recursive: true }),
    fs.mkdir(path.join(root, 'public'), { recursive: true }),
    fs.mkdir(path.join(root, '.git'), { recursive: true }),
    fs.mkdir(path.join(root, 'docs'), { recursive: true }),
    fs.mkdir(path.join(root, 'fixtures'), { recursive: true }),
    fs.mkdir(path.join(root, 'test'), { recursive: true }),
    fs.mkdir(path.join(root, '.osmosis'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, 'bin', 'osmosis.js'), '#!/usr/bin/env node\nconsole.log("fixture")\n'),
    fs.writeFile(path.join(root, 'lib', 'runtime.js'), 'module.exports = "first";\n'),
    fs.writeFile(path.join(root, 'public', 'index.html'), '<!doctype html><title>fixture</title>\n'),
    fs.writeFile(path.join(root, 'server.js'), 'process.exit(0);\n'),
    fs.writeFile(path.join(root, 'LICENSE'), 'fixture license\n'),
    fs.writeFile(path.join(root, 'README.md'), '# fixture\n'),
    fs.writeFile(path.join(root, '.git', 'config'), 'private git metadata\n'),
    fs.writeFile(path.join(root, 'docs', 'secret.md'), 'not runtime\n'),
    fs.writeFile(path.join(root, 'fixtures', 'replay.json'), '{"private":true}\n'),
    fs.writeFile(path.join(root, 'test', 'runner.test.js'), 'not runtime\n'),
    fs.writeFile(path.join(root, '.osmosis', 'cards.json'), '{"private":true}\n'),
    fs.writeFile(path.join(root, 'schemas.json'), 'not runtime\n'),
  ]);
  try {
    await fs.symlink(path.join(root, 'fixtures', 'replay.json'), path.join(root, 'lib', 'linked-fixture.json'));
  } catch {
    // Some Windows policies disallow test symlinks. The allowlist still gets
    // exercised by the other excluded source directories.
  }
}

async function listedFiles(root) {
  const files = [];
  async function visit(relativePath = '') {
    const directory = path.join(root, relativePath);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(relativePath, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
      } else {
        files.push(child.split(path.sep).join('/'));
      }
    }
  }
  await visit();
  return files.sort();
}

function fakeChild() {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function getHealth(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/health`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.once('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('error', reject);
  });
}

async function waitForHealth(url, timeoutMs = 5_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await getHealth(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError || new Error('Osmosis wall did not become healthy');
}

async function exitedProcessId() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('close', resolve));
  return child.pid;
}

test('runner argument parsing accepts only the release flags', () => {
  assert.deepEqual(parseArgs(['--yes', '--no-ambient', '--provider=codex']), {
    help: false,
    noAmbient: true,
    noMount: false,
    provider: 'codex',
    yes: true,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--provider=openai']), /Unsupported provider/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
});

test('self-install is idempotent, refreshes by allowlisted content hash, and excludes non-runtime files', async (t) => {
  const root = await makeDirectory('osmosis-runner-source-');
  const homeDir = path.join(root, 'home with spaces');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixtureRuntime(root);

  const first = await installRuntime({ homeDir, sourceRoot: root });
  const second = await installRuntime({ homeDir, sourceRoot: root });
  assert.equal(first.refreshed, true);
  assert.equal(second.refreshed, false);
  assert.equal(first.hash, second.hash);

  const installed = await listedFiles(first.appPath);
  assert.deepEqual(installed, [
    'LICENSE',
    'README.md',
    'bin/osmosis.js',
    'lib/runtime.js',
    'public/index.html',
    'server.js',
  ]);
  for (const excluded of ['.git', 'docs', 'fixtures', 'test', '.osmosis', 'schemas.json', 'lib/linked-fixture.json']) {
    await assert.rejects(fs.access(path.join(first.appPath, excluded)), { code: 'ENOENT' });
  }

  await fs.writeFile(path.join(root, 'lib', 'runtime.js'), 'module.exports = "second";\n');
  const refreshed = await installRuntime({ homeDir, sourceRoot: root });
  assert.equal(refreshed.refreshed, true);
  assert.notEqual(refreshed.hash, first.hash);
  assert.equal(await fs.readFile(path.join(refreshed.appPath, 'lib', 'runtime.js'), 'utf8'), 'module.exports = "second";\n');

  const concurrentHome = path.join(root, 'concurrent home');
  const concurrent = await Promise.all([
    installRuntime({ homeDir: concurrentHome, sourceRoot: root }),
    installRuntime({ homeDir: concurrentHome, sourceRoot: root }),
  ]);
  assert.equal(concurrent[0].hash, concurrent[1].hash);
  assert.equal(await fs.readFile(path.join(concurrentHome, '.osmosis', 'app', 'server.js'), 'utf8'), 'process.exit(0);\n');

  const recoveredHome = path.join(root, 'dead-lock-home');
  const recoveredRoot = path.join(recoveredHome, '.osmosis');
  await fs.mkdir(recoveredRoot, { recursive: true });
  await fs.writeFile(path.join(recoveredRoot, '.app.install.lock'), `${await exitedProcessId()}\n0\n`);
  const recovered = await installRuntime({ homeDir: recoveredHome, sourceRoot: root });
  assert.equal(recovered.refreshed, true);
});

test('onboarding has no non-TTY default, retries one blank answer, and supports --yes', async (t) => {
  const root = await makeDirectory('osmosis-runner-onboarding-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  let nonTtyAsked = false;
  assert.equal(
    await decideMount({
      ask: async () => {
        nonTtyAsked = true;
        return 'y';
      },
      homeDir: path.join(root, 'non-tty'),
      isInteractive: false,
    }),
    false,
  );
  assert.equal(nonTtyAsked, false);

  const prompts = [];
  const answers = ['', ''];
  const interactiveHome = path.join(root, 'interactive');
  assert.equal(
    await decideMount({
      ask: async (question) => {
        prompts.push(question);
        return answers.shift();
      },
      homeDir: interactiveHome,
      isInteractive: true,
    }),
    false,
  );
  assert.deepEqual(prompts, [MOUNT_PROMPT, MOUNT_PROMPT]);

  assert.equal(
    await decideMount({
      ask: async () => {
        throw new Error('the completed onboarding must not prompt again');
      },
      homeDir: interactiveHome,
      isInteractive: true,
    }),
    false,
  );
  assert.equal(await decideMount({ homeDir: path.join(root, 'yes'), isInteractive: false, yes: true }), true);
  assert.equal(await decideMount({ homeDir: path.join(root, 'skip'), isInteractive: true, noMount: true, yes: true }), false);
});

test('Codex mounting builds argument arrays safely and restores a replaced entry after add failure', async () => {
  const serverPath = '/stable home with spaces/.osmosis/app/server.js';
  assert.deepEqual(mountArgs({ ambientEnabled: true, provider: 'codex', serverPath }), [
    'mcp',
    'add',
    'osmosis',
    '--env',
    'OSMOSIS_PROVIDER=codex',
    '--env',
    'OSMOSIS_AMBIENT=1',
    '--',
    'node',
    serverPath,
  ]);

  const existing = {
    name: 'osmosis',
    transport: {
      args: ['/old target/server.js'],
      command: 'node',
      env: { OLD_SETTING: 'keep-this' },
      type: 'stdio',
    },
  };
  const calls = [];
  const logs = [];
  const result = await mountOsmosis({
    ask: async () => 'y',
    cwd: '/project with spaces',
    env: {},
    log: (message) => logs.push(message),
    runCommand: async (command, args, options) => {
      calls.push({ args, command, options });
      if (args[1] === 'get') {
        return { code: 0, stderr: '', stdout: JSON.stringify(existing) };
      }
      if (calls.length === 2) {
        return { code: 1, stderr: 'simulated add failure', stdout: '' };
      }
      return { code: 0, stderr: '', stdout: '' };
    },
    serverPath,
  });

  assert.deepEqual(calls[0].args, ['mcp', 'get', 'osmosis', '--json']);
  assert.deepEqual(calls[1].args, mountArgs({ ambientEnabled: true, provider: 'codex', serverPath }));
  assert.deepEqual(calls[2].args, [
    'mcp',
    'add',
    'osmosis',
    '--env',
    'OLD_SETTING=keep-this',
    '--',
    'node',
    '/old target/server.js',
  ]);
  assert.equal(calls[1].options.cwd, '/project with spaces');
  assert.equal(result.mounted, false);
  assert.equal(result.restored, true);
  assert.equal(logs.some((message) => message.includes('/old target/server.js')), true);
  assert.equal(logs.some((message) => message.includes('keep-this')), false);

  const protectedCalls = [];
  const protectedResult = await mountOsmosis({
    ask: async () => 'y',
    env: {},
    log: () => {},
    runCommand: async (command, args) => {
      protectedCalls.push({ args, command });
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          ...existing,
          transport: { ...existing.transport, cwd: '/old target' },
        }),
      };
    },
    serverPath,
  });
  assert.equal(protectedResult.reason, 'unsupported-existing');
  assert.equal(protectedCalls.length, 1);
});

test('--yes performs non-interactive Codex mounting when Codex is available', async (t) => {
  const root = await makeDirectory('osmosis-runner-yes-');
  const homeDir = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixtureRuntime(root);
  await fs.mkdir(projectDir);

  const calls = [];
  await run(['--yes'], {
    ask: async () => {
      throw new Error('--yes must not ask a terminal question');
    },
    cwd: projectDir,
    env: { OSMOSIS_PORT: '45322' },
    findCodex: async () => ({ found: true, path: '/fake/codex' }),
    healthCheck: async () => true,
    homeDir,
    isInteractive: false,
    log: () => {},
    openBrowser: async () => true,
    runCommand: async (command, args) => {
      calls.push({ args, command });
      if (args[1] === 'get') return { code: 1, stderr: 'not found', stdout: '' };
      return { code: 0, stderr: '', stdout: '' };
    },
    sourceRoot: root,
  });

  assert.deepEqual(calls.map((call) => call.args), [
    ['mcp', 'get', 'osmosis', '--json'],
    mountArgs({
      ambientEnabled: true,
      provider: 'codex',
      serverPath: path.join(homeDir, '.osmosis', 'app', 'server.js'),
    }),
  ]);
});

test('a second runner reuses a healthy wall, while a Codex-less run starts a detached template wall', async (t) => {
  const root = await makeDirectory('osmosis-runner-lifecycle-');
  const homeDir = path.join(root, 'home with spaces');
  const projectDir = path.join(root, 'project with spaces');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixtureRuntime(root);
  await fs.mkdir(projectDir);

  const spawnCalls = [];
  const openCalls = [];
  const baseDependencies = {
    cwd: projectDir,
    env: { OSMOSIS_AMBIENT: '1', OSMOSIS_PORT: '45321' },
    findCodex: async () => ({ found: false, path: null }),
    homeDir,
    isInteractive: false,
    log: () => {},
    openBrowser: async (url) => {
      openCalls.push(url);
      return true;
    },
    sourceRoot: root,
    spawnServer: (command, args, options) => {
      spawnCalls.push({ args, command, options });
      return fakeChild();
    },
    waitForWall: async () => true,
  };

  const first = await run(['--no-mount'], {
    ...baseDependencies,
    healthCheck: async () => false,
  });
  assert.equal(first.launched, true);
  assert.equal(first.provider, 'none');
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, [path.join(homeDir, '.osmosis', 'app', 'server.js')]);
  assert.equal(spawnCalls[0].options.cwd, projectDir);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(spawnCalls[0].options.env.OSMOSIS_PROVIDER, 'none');
  assert.equal(spawnCalls[0].options.env.OSMOSIS_AMBIENT, '0');

  const second = await run(['--no-mount'], {
    ...baseDependencies,
    healthCheck: async () => true,
  });
  assert.equal(second.alreadyRunning, true);
  assert.equal(second.launched, false);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(openCalls, ['http://127.0.0.1:45321', 'http://127.0.0.1:45321']);

  await assert.rejects(
    run(['--provider=codex', '--no-mount'], {
      ...baseDependencies,
      healthCheck: async () => true,
    }),
    /Codex CLI was not found on PATH/,
  );
});

test('browser opener uses the requested platform commands and leaves failure non-fatal', async () => {
  const calls = [];
  const opened = await openBrowser('http://127.0.0.1:4321', {
    platform: 'win32',
    spawnImpl: (command, args, options) => {
      calls.push({ args, command, options });
      const child = fakeChild();
      queueMicrotask(() => {
        child.emit('spawn');
        child.emit('close', 0);
      });
      return child;
    },
  });
  assert.equal(opened, true);
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', 'start "" http://127.0.0.1:4321']);
  assert.equal(calls[0].command, 'cmd.exe');

  assert.equal(
    await openBrowser('http://127.0.0.1:4321', {
      platform: 'darwin',
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.emit('spawn');
          child.emit('close', 1);
        });
        return child;
      },
    }),
    false,
  );

  assert.equal(
    await openBrowser('http://127.0.0.1:4321', {
      platform: 'linux',
      spawnImpl: () => {
        throw new Error('no browser');
      },
    }),
    false,
  );
});

test('Windows Codex command paths stay one quoted cmd.exe invocation when the CLI is a .cmd shim', () => {
  assert.deepEqual(
    commandInvocation('C:\\Program Files\\Codex\\codex.cmd', ['mcp', 'get', 'osmosis', '--json'], { platform: 'win32' }),
    {
      args: ['/d', '/s', '/c', '"C:\\Program Files\\Codex\\codex.cmd" "mcp" "get" "osmosis" "--json"'],
      command: 'cmd.exe',
    },
  );
});

test('wall reuse recognizes Osmosis health JSON rather than any HTTP 200 responder', async (t) => {
  let valid = false;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(valid ? JSON.stringify({ processCwd: '/project', provider: 'none' }) : JSON.stringify({ ok: true }));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  assert.equal(await healthCheck(url), false);
  valid = true;
  assert.equal(await healthCheck(url), true);
});

test('the packed tarball contains only runtime files and its installed bin runs offline', async (t) => {
  const temporary = await makeDirectory('osmosis-pack-');
  let wallPid = null;
  t.after(async () => {
    if (wallPid) {
      try {
        process.kill(wallPid, 'SIGTERM');
      } catch (error) {
        if (!error || error.code !== 'ESRCH') {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const packDirectory = path.join(temporary, 'tarballs');
  const prefix = path.join(temporary, 'prefix');
  await fs.mkdir(packDirectory);

  const packOutput = execFileSync(NPM_COMMAND, ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  });
  const [packed] = JSON.parse(packOutput);
  const packedFiles = packed.files.map((file) => file.path).sort();
  for (const excludedPrefix of ['.git/', '.osmosis/', 'docs/', 'fixtures/', 'schemas/', 'test/']) {
    assert.equal(packedFiles.some((file) => file.startsWith(excludedPrefix)), false, `${excludedPrefix} must not be packed`);
  }
  assert.equal(packedFiles.includes('bin/osmosis.js'), true);
  assert.equal(packedFiles.includes('lib/schemas/card-output.schema.json'), true);
  assert.equal(packedFiles.includes('server.js'), true);

  const tarball = path.join(packDirectory, packed.filename);
  execFileSync(NPM_COMMAND, ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  });

  const binPath = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', '.bin', 'osmosis.cmd')
    : path.join(prefix, 'node_modules', '.bin', 'osmosis');
  const output = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/s', '/c', `"${binPath}" --help`], { encoding: 'utf8' })
    : execFileSync(binPath, ['--help'], { encoding: 'utf8' });
  assert.match(output, /Usage: osmosis/);

  const manifest = await buildRuntimeManifest(path.join(prefix, 'node_modules', 'osmosis'));
  assert.equal(manifest.files.some((file) => file.relativePath.startsWith('test/')), false);

  if (process.platform === 'win32') {
    return;
  }

  const browserDirectory = path.join(temporary, 'browser-bin');
  const homeDir = path.join(temporary, 'runner home');
  const projectDir = path.join(temporary, 'project with spaces');
  const browserCommand = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const port = await freePort();
  await Promise.all([
    fs.mkdir(browserDirectory, { recursive: true }),
    fs.mkdir(projectDir, { recursive: true }),
  ]);
  const browserPath = path.join(browserDirectory, browserCommand);
  await fs.writeFile(browserPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.chmod(browserPath, 0o755);

  const lifecycleOutput = execFileSync(binPath, ['--provider=none', '--no-mount', '--no-ambient'], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      OSMOSIS_PORT: String(port),
      OSMOSIS_TEMPLATE_DELAY_MS: '60000',
      PATH: `${browserDirectory}${path.delimiter}${process.env.PATH}`,
      USERPROFILE: homeDir,
    },
    timeout: 10_000,
  });
  assert.match(lifecycleOutput, new RegExp(`Osmosis wall: http://127\\.0\\.0\\.1:${port}`));
  const health = await waitForHealth(`http://127.0.0.1:${port}`);
  wallPid = health.pid;
  assert.equal(health.processCwd, await fs.realpath(projectDir));
  assert.equal(health.provider, 'none');
  await assert.rejects(fs.access(path.join(homeDir, '.osmosis', 'app', 'test')), { code: 'ENOENT' });
});
