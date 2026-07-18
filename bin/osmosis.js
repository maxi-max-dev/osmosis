#!/usr/bin/env node
'use strict';

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawn } = require('node:child_process');

const APP_DIRECTORY = 'app';
const IDENTITY_FILENAME = '.app.identity';
const INSTALL_LOCK_FILENAME = '.app.install.lock';
const ONBOARDING_FILENAME = 'runner.json';
const INSTALL_LOCK_WAIT_MS = 80;
const INSTALL_LOCK_ATTEMPTS = 100;
const RENAME_ATTEMPTS = 6;
const RENAME_WAIT_MS = 60;
const DEFAULT_PORT = 4321;
const BROWSER_RESULT_TIMEOUT_MS = 750;
const MOUNT_PROMPT = 'Mount Osmosis into your Codex so lessons appear while it works? (y/n) ';

// Keep this list deliberately narrow. It is both the npm publication boundary
// and the local self-install boundary, so a source checkout cannot copy test
// fixtures, project state, or arbitrary files into the durable app home.
const RUNTIME_ENTRIES = [
  { relativePath: 'bin', type: 'directory' },
  { relativePath: 'lib', type: 'directory' },
  { relativePath: 'public', type: 'directory' },
  { relativePath: 'server.js', type: 'file' },
  { relativePath: 'LICENSE', type: 'file' },
  { relativePath: 'README.md', type: 'file' },
];

function usage() {
  return [
    'Usage: osmosis [options]',
    '',
    'Install Osmosis locally, optionally mount it into Codex, and open the learning wall.',
    '',
    'Options:',
    '  --yes                 Script the full setup, including Codex mounting when available.',
    '  --no-mount            Do not mount Osmosis into Codex.',
    '  --provider=none       Run template lessons only.',
    '  --provider=codex      Require the local Codex CLI and generate live lessons.',
    '  --no-ambient          Disable Ambient Watch for this wall and mounted server.',
    '  --help                Show this help text.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = {
    help: false,
    noAmbient: false,
    noMount: false,
    provider: null,
    yes: false,
  };

  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      parsed.help = true;
      continue;
    }
    if (argument === '--yes') {
      parsed.yes = true;
      continue;
    }
    if (argument === '--no-mount') {
      parsed.noMount = true;
      continue;
    }
    if (argument === '--no-ambient') {
      parsed.noAmbient = true;
      continue;
    }
    if (argument.startsWith('--provider=')) {
      const provider = argument.slice('--provider='.length);
      if (provider !== 'none' && provider !== 'codex') {
        throw new Error(`Unsupported provider ${JSON.stringify(provider)}. Use --provider=none or --provider=codex.`);
      }
      parsed.provider = provider;
      continue;
    }
    throw new Error(`Unknown option ${JSON.stringify(argument)}. Run osmosis --help for usage.`);
  }

  return parsed;
}

function installPaths(homeDir) {
  const root = path.join(homeDir, '.osmosis');
  return {
    app: path.join(root, APP_DIRECTORY),
    identity: path.join(root, IDENTITY_FILENAME),
    lock: path.join(root, INSTALL_LOCK_FILENAME),
    onboarding: path.join(root, ONBOARDING_FILENAME),
    root,
  };
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function lstatRequired(filePath, label) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Osmosis runtime is missing required ${label}: ${filePath}`);
    }
    throw error;
  }
}

async function collectDirectoryFiles(sourceRoot, relativeDirectory, files) {
  const directoryPath = path.join(sourceRoot, relativeDirectory);
  const directoryStats = await fs.lstat(directoryPath);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    return;
  }
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const sourcePath = path.join(sourceRoot, relativePath);
    const stats = await fs.lstat(sourcePath);
    // Never traverse or reproduce a link. The installed app should contain
    // only files copied from the published runtime, never pointers back into
    // a checkout or outside it.
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (stats.isDirectory()) {
      await collectDirectoryFiles(sourceRoot, relativePath, files);
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }

    const contents = await fs.readFile(sourcePath);
    const afterRead = await fs.lstat(sourcePath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile()) {
      continue;
    }
    files.push({
      contents,
      relativePath: normalizeRelativePath(relativePath),
    });
  }
}

async function buildRuntimeManifest(sourceRoot = path.resolve(__dirname, '..')) {
  const files = [];

  for (const entry of RUNTIME_ENTRIES) {
    const sourcePath = path.join(sourceRoot, entry.relativePath);
    const stats = await lstatRequired(sourcePath, entry.relativePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Osmosis runtime entry must not be a symbolic link: ${entry.relativePath}`);
    }
    if (entry.type === 'directory') {
      if (!stats.isDirectory()) {
        throw new Error(`Osmosis runtime entry must be a directory: ${entry.relativePath}`);
      }
      await collectDirectoryFiles(sourceRoot, entry.relativePath, files);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Osmosis runtime entry must be a file: ${entry.relativePath}`);
    }
    const contents = await fs.readFile(sourcePath);
    const afterRead = await fs.lstat(sourcePath);
    if (afterRead.isSymbolicLink() || !afterRead.isFile()) {
      throw new Error(`Osmosis runtime entry changed while it was being read: ${entry.relativePath}`);
    }
    files.push({ contents, relativePath: normalizeRelativePath(entry.relativePath) });
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.contents.length));
    hash.update('\0');
    hash.update(file.contents);
    hash.update('\0');
  }

  return { files, hash: hash.digest('hex') };
}

async function readTextIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function isUsableInstallation(paths, expectedHash) {
  const identity = await readTextIfPresent(paths.identity);
  if (!identity || identity.trim() !== expectedHash) {
    return false;
  }
  try {
    const server = await fs.lstat(path.join(paths.app, 'server.js'));
    return server.isFile() && !server.isSymbolicLink();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function uniqueSibling(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${randomBytes(5).toString('hex')}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLockError(error) {
  return Boolean(error) && ['EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code);
}

async function retryRename(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!isLockError(error) || attempt === RENAME_ATTEMPTS - 1) {
        throw error;
      }
      await delay(RENAME_WAIT_MS * (attempt + 1));
    }
  }
  throw lastError;
}

async function safelyRemove(filePath) {
  try {
    await fs.rm(filePath, { force: true, recursive: true });
  } catch (error) {
    if (!isLockError(error)) {
      throw error;
    }
  }
}

async function recoverInterruptedInstall(paths) {
  let appExists = false;
  try {
    const appStats = await fs.lstat(paths.app);
    appExists = appStats.isDirectory() && !appStats.isSymbolicLink();
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (appExists) {
    return;
  }

  const entries = await fs.readdir(paths.root, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('.app-backup-'))
    .map((entry) => entry.name)
    .sort();
  if (backups.length > 0) {
    await retryRename(path.join(paths.root, backups.at(-1)), paths.app);
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user. Treat it as
    // live: retaining a lock is safe, while stealing it could corrupt an app.
    return Boolean(error) && error.code !== 'ESRCH';
  }
}

async function removeDeadInstallLock(paths) {
  const contents = await readTextIfPresent(paths.lock);
  const ownerPid = Number.parseInt(String(contents || '').split(/\r?\n/, 1)[0], 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || processIsAlive(ownerPid)) {
    return false;
  }
  try {
    await fs.unlink(paths.lock);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return true;
    }
    throw error;
  }
}

async function claimInstallLock(paths) {
  const candidate = path.join(paths.root, uniqueSibling('.app-install-candidate'));
  let candidateCreated = false;
  let candidateHandle;
  try {
    candidateHandle = await fs.open(candidate, 'wx', 0o600);
    candidateCreated = true;
    await candidateHandle.writeFile(`${process.pid}\n${Date.now()}\n`);
    await candidateHandle.close();
    candidateHandle = null;
    // Linking a fully written candidate into the fixed lock name is atomic:
    // unlike creating the fixed file then writing its owner PID, no observer
    // can mistake a half-written lock for a crashed install.
    await fs.link(candidate, paths.lock);
    return true;
  } catch (error) {
    if (candidateCreated && error && error.code === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    await candidateHandle?.close();
    if (candidateCreated) {
      try {
        await fs.unlink(candidate);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }
}

async function acquireInstallLock(paths, expectedHash) {
  for (let attempt = 0; attempt < INSTALL_LOCK_ATTEMPTS; attempt += 1) {
    try {
      if (await claimInstallLock(paths)) {
        return { ownsLock: true, reused: false };
      }
    } catch (error) {
      throw error;
    }
    if (await isUsableInstallation(paths, expectedHash)) {
      return { ownsLock: false, reused: true };
    }
    if (await removeDeadInstallLock(paths)) {
      continue;
    }
    await delay(INSTALL_LOCK_WAIT_MS);
  }
  throw new Error('Another Osmosis install is still in progress. Please try again in a moment.');
}

async function releaseInstallLock(paths, ownsLock) {
  if (!ownsLock) {
    return;
  }
  try {
    await fs.unlink(paths.lock);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function writeManifest(destination, manifest) {
  for (const file of manifest.files) {
    const destinationPath = path.join(destination, file.relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    const mode = file.relativePath === 'bin/osmosis.js' ? 0o755 : 0o644;
    await fs.writeFile(destinationPath, file.contents, { mode });
    if (file.relativePath === 'bin/osmosis.js') {
      await fs.chmod(destinationPath, 0o755);
    }
  }
}

async function replaceApplication(paths, temporaryApp) {
  const backup = path.join(paths.root, uniqueSibling('.app-backup'));
  let movedCurrentApp = false;
  try {
    await retryRename(paths.app, backup);
    movedCurrentApp = true;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      if (isLockError(error)) {
        return { deferred: true };
      }
      throw error;
    }
  }

  try {
    await retryRename(temporaryApp, paths.app);
  } catch (error) {
    if (movedCurrentApp) {
      try {
        await retryRename(backup, paths.app);
      } catch (restoreError) {
        throw new Error(`Could not update Osmosis and could not restore the previous app: ${restoreError.message}`);
      }
    }
    if (isLockError(error) && movedCurrentApp) {
      return { deferred: true };
    }
    throw error;
  }

  if (movedCurrentApp) {
    await safelyRemove(backup);
  }
  return { deferred: false };
}

async function writeIdentity(paths, hash) {
  const temporaryIdentity = path.join(paths.root, uniqueSibling('.app.identity'));
  await fs.writeFile(temporaryIdentity, `${hash}\n`, { mode: 0o600 });
  try {
    await retryRename(temporaryIdentity, paths.identity);
  } catch (error) {
    // Windows cannot always replace an existing file in one rename. The lock
    // prevents a reader from observing this short replacement window.
    if (!isLockError(error)) {
      throw error;
    }
    await fs.rm(paths.identity, { force: true });
    await retryRename(temporaryIdentity, paths.identity);
  }
}

async function replaceSmallFile(temporaryPath, destinationPath) {
  try {
    await retryRename(temporaryPath, destinationPath);
  } catch (error) {
    if (!isLockError(error)) {
      throw error;
    }
    await fs.rm(destinationPath, { force: true });
    await retryRename(temporaryPath, destinationPath);
  }
}

async function installRuntime({ homeDir = os.homedir(), log = () => {}, sourceRoot = path.resolve(__dirname, '..') } = {}) {
  const manifest = await buildRuntimeManifest(sourceRoot);
  const paths = installPaths(homeDir);
  await fs.mkdir(paths.root, { recursive: true });

  if (await isUsableInstallation(paths, manifest.hash)) {
    return { appPath: paths.app, hash: manifest.hash, refreshed: false };
  }

  const lockResult = await acquireInstallLock(paths, manifest.hash);
  if (lockResult.reused) {
    return { appPath: paths.app, hash: manifest.hash, refreshed: false };
  }

  let temporaryApp;
  try {
    await recoverInterruptedInstall(paths);
    if (await isUsableInstallation(paths, manifest.hash)) {
      return { appPath: paths.app, hash: manifest.hash, refreshed: false };
    }

    temporaryApp = path.join(paths.root, uniqueSibling('.app-tmp'));
    await fs.mkdir(temporaryApp, { recursive: false, mode: 0o700 });
    await writeManifest(temporaryApp, manifest);
    const replacement = await replaceApplication(paths, temporaryApp);
    if (replacement.deferred) {
      log('Osmosis is already running from a locked older install; it will refresh on a later run.');
      return { appPath: paths.app, deferred: true, hash: manifest.hash, refreshed: false };
    }
    temporaryApp = null;
    await writeIdentity(paths, manifest.hash);
    return { appPath: paths.app, hash: manifest.hash, refreshed: true };
  } finally {
    if (temporaryApp) {
      await safelyRemove(temporaryApp);
    }
    await releaseInstallLock(paths, lockResult.ownsLock);
  }
}

function commandResult(command, args, { cwd, env, platform = process.platform, spawnImpl = spawn } = {}) {
  const invocation = commandInvocation(command, args, { platform });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(invocation.command, invocation.args, {
        cwd,
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: null, error, stderr: '', stdout: '' });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on?.('data', (chunk) => {
      stderr += chunk;
    });
    child.once?.('error', (error) => resolve({ code: null, error, stderr, stdout }));
    child.once?.('close', (code) => resolve({ code, error: null, stderr, stdout }));
  });
}

function quoteForCmd(value) {
  return `"${String(value).replace(/["^&|<>()%!]/g, '^$&')}"`;
}

function commandInvocation(command, args, { platform = process.platform } = {}) {
  if (platform === 'win32' && /\.(?:bat|cmd)$/i.test(command)) {
    return {
      args: ['/d', '/s', '/c', [command, ...args].map(quoteForCmd).join(' ')],
      command: 'cmd.exe',
    };
  }
  return { args, command };
}

async function findCodex({ cwd, env, platform = process.platform, runCommand = commandResult } = {}) {
  const command = platform === 'win32' ? 'where.exe' : 'which';
  const result = await runCommand(command, ['codex'], { cwd, env, platform });
  if (result.code !== 0) {
    return { found: false, path: null };
  }
  const firstPath = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  return { found: Boolean(firstPath), path: firstPath };
}

function isYes(value) {
  return /^(?:y|yes)$/i.test(String(value || '').trim());
}

async function askTerminal(question, { input = process.stdin, output = process.stdout } = {}) {
  const terminal = readline.createInterface({ input, output });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

async function readOnboarding(paths) {
  const text = await readTextIfPresent(paths.onboarding);
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeOnboarding(paths, onboarding) {
  await fs.mkdir(paths.root, { recursive: true });
  const temporaryPath = path.join(paths.root, uniqueSibling('.runner'));
  await fs.writeFile(temporaryPath, `${JSON.stringify(onboarding)}\n`, { mode: 0o600 });
  await replaceSmallFile(temporaryPath, paths.onboarding);
}

async function decideMount({
  ask = askTerminal,
  homeDir = os.homedir(),
  isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  noMount = false,
  yes = false,
} = {}) {
  if (noMount) {
    return false;
  }
  const paths = installPaths(homeDir);
  if (yes) {
    await writeOnboarding(paths, { mountOnboardingComplete: true });
    return true;
  }
  if (!isInteractive) {
    return false;
  }

  const onboarding = await readOnboarding(paths);
  if (onboarding.mountOnboardingComplete) {
    return false;
  }

  let answer = await ask(MOUNT_PROMPT);
  if (!String(answer || '').trim()) {
    answer = await ask(MOUNT_PROMPT);
  }
  await writeOnboarding(paths, { mountOnboardingComplete: true });
  return isYes(answer);
}

function mcpTarget(existing) {
  const transport = existing && existing.transport;
  if (!transport || typeof transport !== 'object') {
    return 'an unknown target';
  }
  if (transport.type === 'stdio') {
    const command = typeof transport.command === 'string' ? transport.command : 'unknown command';
    const args = Array.isArray(transport.args) ? transport.args : [];
    return [command, ...args].join(' ');
  }
  if (typeof transport.url === 'string') {
    return transport.url;
  }
  return transport.type || 'an unknown target';
}

function stdioMcpArgs(name, command, commandArgs, environment) {
  const args = ['mcp', 'add', name];
  for (const [key, value] of Object.entries(environment || {})) {
    args.push('--env', `${key}=${value}`);
  }
  args.push('--', command, ...(Array.isArray(commandArgs) ? commandArgs : []));
  return args;
}

function mountArgs({ ambientEnabled, provider, serverPath }) {
  return stdioMcpArgs('osmosis', 'node', [serverPath], {
    OSMOSIS_PROVIDER: provider,
    OSMOSIS_AMBIENT: ambientEnabled ? '1' : '0',
  });
}

function rollbackArgs(existing) {
  const transport = existing && existing.transport;
  if (!transport || typeof transport !== 'object') {
    return null;
  }
  const unsupportedEntrySettings = [
    existing.enabled !== undefined && existing.enabled !== true,
    existing.disabled_reason !== undefined && existing.disabled_reason !== null,
    existing.enabled_tools !== undefined && existing.enabled_tools !== null,
    existing.disabled_tools !== undefined && existing.disabled_tools !== null,
    existing.startup_timeout_sec !== undefined && existing.startup_timeout_sec !== null,
    existing.tool_timeout_sec !== undefined && existing.tool_timeout_sec !== null,
    transport.cwd !== undefined && transport.cwd !== null,
    Array.isArray(transport.env_vars) && transport.env_vars.length > 0,
  ];
  if (unsupportedEntrySettings.some(Boolean)) {
    return null;
  }
  if (transport.type === 'stdio' && typeof transport.command === 'string' && (!transport.env || typeof transport.env === 'object')) {
    return stdioMcpArgs('osmosis', transport.command, transport.args, transport.env);
  }
  return null;
}

async function getExistingMcp({ codexCommand = 'codex', cwd, env, platform = process.platform, runCommand = commandResult }) {
  const result = await runCommand(codexCommand, ['mcp', 'get', 'osmosis', '--json'], { cwd, env, platform });
  if (result.code === 1) {
    return null;
  }
  if (result.code !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit code ${result.code}`;
    throw new Error(`Codex could not read its existing Osmosis MCP entry (${detail}).`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('Codex returned an unreadable existing Osmosis MCP entry; it was not replaced.');
  }
}

async function mountOsmosis({
  ambientEnabled = true,
  ask = askTerminal,
  assumeYes = false,
  codexCommand = 'codex',
  cwd,
  env,
  log = () => {},
  platform = process.platform,
  provider = 'codex',
  runCommand = commandResult,
  serverPath,
} = {}) {
  let existing;
  try {
    existing = await getExistingMcp({ codexCommand, cwd, env, platform, runCommand });
  } catch (error) {
    log(error.message);
    return { mounted: false, reason: 'unreadable-existing' };
  }

  if (existing) {
    log(`Osmosis is already mounted to ${mcpTarget(existing)}.`);
    const replace = assumeYes || isYes(await ask('Replace that Osmosis MCP entry? (y/n) '));
    if (!replace) {
      log('Kept the existing Osmosis MCP entry.');
      return { mounted: false, reason: 'kept-existing' };
    }
    if (!rollbackArgs(existing)) {
      log('Cannot safely restore that existing Osmosis MCP entry, so it was not replaced.');
      return { mounted: false, reason: 'unsupported-existing' };
    }
  }

  const result = await runCommand(codexCommand, mountArgs({ ambientEnabled, provider, serverPath }), { cwd, env, platform });
  if (result.code === 0) {
    log('Mounted Osmosis into Codex. Restart the Codex desktop app before opening a new session if it was already running.');
    return { mounted: true };
  }

  let restored = false;
  if (existing) {
    const previousArgs = rollbackArgs(existing);
    const rollback = await runCommand(codexCommand, previousArgs, { cwd, env, platform });
    restored = rollback.code === 0;
  }
  const detail = result.stderr.trim() || result.error?.message || `exit code ${result.code}`;
  log(`Could not mount Osmosis into Codex (${detail}).${existing ? restored ? ' Restored the previous MCP entry.' : ' Could not restore the previous MCP entry.' : ''}`);
  return { mounted: false, reason: 'add-failed', restored };
}

function validPort(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

function wallUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function healthCheck(url, { timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const request = http.get(`${url}/health`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        if (body.length < 8_192) {
          body += chunk;
        }
      });
      response.once('end', () => {
        if (response.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          const health = JSON.parse(body);
          resolve(Boolean(health && typeof health.provider === 'string' && typeof health.processCwd === 'string'));
        } catch {
          resolve(false);
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
    request.once('error', () => resolve(false));
  });
}

async function waitForWall(url, { health = healthCheck, timeoutMs = 2_500 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await health(url)) {
      return true;
    }
    await delay(80);
  }
  return false;
}

function launchWall({ cwd, env, serverPath, spawnImpl = spawn }) {
  const child = spawnImpl(process.execPath, [serverPath], {
    cwd,
    detached: true,
    env,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  // A detached child can report a late spawn error (for example, a transient
  // Windows lock). Do not let that turn into an unhandled runner exception.
  child.once?.('error', () => {});
  child.unref?.();
  return child;
}

function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  let command;
  let args;
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd.exe';
    args = ['/d', '/s', '/c', `start "" ${url}`];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  return new Promise((resolve) => {
    let settled = false;
    let resultTimer = null;
    const settle = (opened) => {
      if (!settled) {
        settled = true;
        clearTimeout(resultTimer);
        resolve(opened);
      }
    };
    try {
      const child = spawnImpl(command, args, {
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once?.('error', () => settle(false));
      child.once?.('close', (code) => settle(code === 0));
      child.once?.('spawn', () => {
        resultTimer = setTimeout(() => settle(true), BROWSER_RESULT_TIMEOUT_MS);
      });
      child.unref?.();
      // Lightweight fakes used by callers may not expose ChildProcess events.
      // A real spawn emits either `spawn` or `error` before this turn ends.
      if (typeof child.once !== 'function') {
        setImmediate(() => settle(true));
      }
    } catch {
      settle(false);
    }
  });
}

function wallEnvironment({ ambientEnabled, baseEnvironment, port, provider }) {
  return {
    ...baseEnvironment,
    OSMOSIS_AMBIENT: ambientEnabled ? '1' : '0',
    OSMOSIS_HOST: '127.0.0.1',
    OSMOSIS_MODE: 'live',
    OSMOSIS_PORT: String(port),
    OSMOSIS_PROVIDER: provider,
  };
}

async function run(argv, dependencies = {}) {
  const parsed = parseArgs(argv);
  const log = dependencies.log || ((message) => process.stdout.write(`${message}\n`));
  if (parsed.help) {
    log(usage());
    return { help: true };
  }

  const homeDir = dependencies.homeDir || os.homedir();
  const cwd = dependencies.cwd || process.cwd();
  const env = dependencies.env || process.env;
  const sourceRoot = dependencies.sourceRoot || path.resolve(__dirname, '..');
  const install = await installRuntime({ homeDir, log, sourceRoot });
  const codex = await (dependencies.findCodex || findCodex)({
    cwd,
    env,
    platform: dependencies.platform || process.platform,
    runCommand: dependencies.runCommand || commandResult,
  });

  if (parsed.provider === 'codex' && !codex.found) {
    throw new Error('The local Codex CLI was not found on PATH. Install Codex or use --provider=none.');
  }

  const provider = parsed.provider || (codex.found ? 'codex' : 'none');
  const ambientEnabled = provider === 'codex' && codex.found && !parsed.noAmbient;
  const wantsMount = await decideMount({
    ask: dependencies.ask || askTerminal,
    homeDir,
    isInteractive: dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    noMount: parsed.noMount,
    yes: parsed.yes,
  });

  let mount = { mounted: false, reason: 'not-requested' };
  if (wantsMount) {
    if (!codex.found) {
      log('Codex was not found on PATH, so Osmosis could not be mounted. Starting the template wall instead.');
      mount = { mounted: false, reason: 'codex-unavailable' };
    } else {
      mount = await mountOsmosis({
        ambientEnabled,
        ask: dependencies.ask || askTerminal,
        assumeYes: parsed.yes,
        codexCommand: codex.path || 'codex',
        cwd,
        env,
        log,
        platform: dependencies.platform || process.platform,
        provider,
        runCommand: dependencies.runCommand || commandResult,
        serverPath: path.join(install.appPath, 'server.js'),
      });
    }
  }

  const port = validPort(env.OSMOSIS_PORT);
  const url = wallUrl(port);
  const health = dependencies.healthCheck || healthCheck;
  const alreadyRunning = await health(url);
  let launched = false;
  if (alreadyRunning) {
    log(`Reusing the healthy Osmosis wall at ${url}.`);
  } else {
    launchWall({
      cwd,
      env: wallEnvironment({ ambientEnabled, baseEnvironment: env, port, provider }),
      serverPath: path.join(install.appPath, 'server.js'),
      spawnImpl: dependencies.spawnServer || spawn,
    });
    launched = true;
    const ready = await (dependencies.waitForWall || waitForWall)(url, { health });
    if (!ready) {
      log(`Osmosis is starting. If the browser does not open it automatically, visit ${url}`);
    }
  }

  const opened = await (dependencies.openBrowser || openBrowser)(url, {
    platform: dependencies.platform || process.platform,
    spawnImpl: dependencies.spawnBrowser || spawn,
  });
  if (!opened) {
    log(`Open ${url} in your browser.`);
  } else {
    log(`Osmosis wall: ${url}`);
  }

  return { alreadyRunning, appPath: install.appPath, launched, mount, provider, url };
}

async function main() {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Osmosis: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  APP_DIRECTORY,
  MOUNT_PROMPT,
  RUNTIME_ENTRIES,
  buildRuntimeManifest,
  commandResult,
  commandInvocation,
  decideMount,
  findCodex,
  healthCheck,
  installPaths,
  installRuntime,
  launchWall,
  main,
  mountArgs,
  mountOsmosis,
  openBrowser,
  parseArgs,
  rollbackArgs,
  run,
  stdioMcpArgs,
  quoteForCmd,
  usage,
  validPort,
  waitForWall,
  wallEnvironment,
  wallUrl,
};
