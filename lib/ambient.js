'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ACTIVE_FILE_AGE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_EMIT_INTERVAL_MS = 45_000;
const NOISE_COMMANDS = new Set(['cd', 'cat', 'echo', 'ls', 'pwd']);

const TOOL_HINTS = [
  [/\b(?:npm|npx)\b/i, 'npm'],
  [/\bpnpm\b/i, 'pnpm'],
  [/\byarn\b/i, 'yarn'],
  [/\bbun\b/i, 'bun'],
  [/\bgit\b/i, 'git'],
  [/\brg\b/i, 'rg'],
  [/\bnode\b/i, 'node'],
  [/\bpython(?:3)?\b/i, 'python'],
  [/\bpytest\b/i, 'pytest'],
  [/\bgo\b/i, 'go'],
  [/\bcargo\b/i, 'cargo'],
  [/\bdocker\b/i, 'docker'],
  [/\bvitest\b/i, 'vitest'],
  [/\bjest\b/i, 'jest'],
];

const FRAMEWORK_HINTS = [
  [/\bthree(?:\.js)?\b/i, 'three.js'],
  [/\breact\b/i, 'react'],
  [/\bnext(?:\.js)?\b/i, 'next.js'],
  [/\bvue\b/i, 'vue'],
  [/\bsvelte\b/i, 'svelte'],
  [/\bexpress\b/i, 'express'],
  [/\bvite\b/i, 'vite'],
  [/\btailwind\b/i, 'tailwind'],
  [/\btypescript\b/i, 'typescript'],
];

function unique(values, limit = 12) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function shortText(value, fallback = '', limit = 100) {
  if (typeof value !== 'string') {
    return fallback;
  }
  return value.replace(/\s+/g, ' ').trim().slice(0, limit) || fallback;
}

function safeLog(log, message, error) {
  try {
    log(message, error && error.message ? error.message : error);
  } catch {
    // A diagnostic sink must not become a watcher failure path.
  }
}

function dateDirectories(sessionsDir, timestamp) {
  const dates = [new Date(timestamp), new Date(timestamp - 24 * 60 * 60 * 1_000)];
  return unique(
    dates.map((date) =>
      path.join(
        sessionsDir,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      ),
    ),
    2,
  );
}

function looksLikeRolloutFile(name) {
  return /^rollout-.*\.jsonl$/i.test(name);
}

function hintsFromText(value) {
  const text = typeof value === 'string' ? value : '';
  return unique([
    ...TOOL_HINTS.filter(([pattern]) => pattern.test(text)).map(([, hint]) => hint),
    ...FRAMEWORK_HINTS.filter(([pattern]) => pattern.test(text)).map(([, hint]) => hint),
  ]);
}

function extensionHints(filePaths) {
  return unique(
    filePaths
      .map((filePath) => path.extname(filePath).toLowerCase())
      .filter((extension) => /^\.[a-z0-9]{1,12}$/.test(extension)),
  );
}

function commandName(command) {
  const tokens = shortText(command, '', 2_000).split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens.shift();
  }
  return path.basename(tokens[0] || '').toLowerCase();
}

function isNoiseCommand(command) {
  const normalized = shortText(command, '', 2_000);
  if (!normalized || /(?:&&|\|\||[;|]|\n)/.test(normalized)) {
    return false;
  }
  return NOISE_COMMANDS.has(commandName(normalized));
}

function objectFromExecInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input;
  }

  if (typeof input !== 'string') {
    return null;
  }

  let candidate = input.trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      if (typeof parsed !== 'string') {
        break;
      }
      candidate = parsed;
    } catch {
      break;
    }
  }

  const commandMatch = candidate.match(/(?:["']?(?:cmd|command)["']?\s*[:=]\s*)(["'])([\s\S]*?)\1/i);
  const workdirMatch = candidate.match(/(?:["']?(?:workdir|cwd)["']?\s*[:=]\s*)(["'])([\s\S]*?)\1/i);
  return {
    cmd: commandMatch ? commandMatch[2] : '',
    workdir: workdirMatch ? workdirMatch[2] : '',
  };
}

function execSignal(payload) {
  if (payload?.type !== 'custom_tool_call' || payload.name !== 'exec') {
    return null;
  }

  const input = objectFromExecInput(payload.input);
  const command = shortText(input?.cmd || input?.command, '', 2_000);
  if (!command || isNoiseCommand(command)) {
    return null;
  }

  const hints = hintsFromText(command);
  const toolLabel = hints.filter((hint) => !hint.startsWith('.')).slice(0, 3);
  return {
    key: 'exec:' + unique(hints.length > 0 ? hints : [commandName(command) || 'terminal']).join(','),
    label: toolLabel.length > 0 ? 'ran ' + toolLabel.join(' and ') : 'ran a terminal command',
    hints: hints.length > 0 ? hints : ['terminal'],
    workdir: shortText(input?.workdir || input?.cwd, '', 500),
  };
}

function patchSignal(payload) {
  if (payload?.type !== 'patch_apply_end' || payload.success !== true || !payload.changes || typeof payload.changes !== 'object') {
    return null;
  }

  const changedPaths = Object.keys(payload.changes).filter((filePath) => typeof filePath === 'string');
  const files = unique(changedPaths.map((filePath) => path.basename(filePath)).filter(Boolean), 6);
  if (files.length === 0) {
    return null;
  }

  const hints = unique([...extensionHints(changedPaths), ...hintsFromText(changedPaths.join(' '))]);
  return {
    key: 'patch:' + files.join(','),
    label: 'changed ' + files.join(', '),
    hints: hints.length > 0 ? hints : ['file change'],
    workdir: '',
  };
}

function mcpSignal(payload) {
  if (payload?.type !== 'mcp_tool_call_end') {
    return null;
  }

  const server = shortText(payload.invocation?.server, '', 48);
  const tool = shortText(payload.invocation?.tool, '', 48);
  if (!server || !tool || server.toLowerCase() === 'osmosis') {
    return null;
  }

  const name = shortText(server + '.' + tool, 'MCP tool', 100);
  return {
    key: 'mcp:' + name.toLowerCase(),
    label: 'used ' + name,
    hints: unique([name, ...hintsFromText(name)]),
    workdir: '',
  };
}

function signalsFromEvent(event) {
  if (!event || typeof event !== 'object' || !event.payload || typeof event.payload !== 'object') {
    return [];
  }

  if (event.type === 'response_item') {
    const signal = execSignal(event.payload);
    return signal ? [signal] : [];
  }

  if (event.type !== 'event_msg') {
    return [];
  }

  return [patchSignal(event.payload), mcpSignal(event.payload)].filter(Boolean);
}

function projectName(workdir, fallback) {
  const directory = shortText(workdir || fallback, '', 500);
  return shortText(path.basename(directory), 'current project', 80);
}

function makeReport(state, config) {
  const signals = [...state.pending.values()];
  const project = projectName(state.workdir, config.cwd);
  const descriptions = unique(signals.map((signal) => signal.label), 4);
  const stackHints = unique(signals.flatMap((signal) => signal.hints), 12);

  return {
    task: 'Observed work in ' + project,
    what_i_did: 'Observed ' + descriptions.join('; ') + ' in ' + project + '.',
    stack_hints: stackHints,
    source: 'observed',
  };
}

function createFileState(offset, workdir) {
  return {
    lastEmitAt: null,
    lastSeenAt: 0,
    offset,
    pending: new Map(),
    // Keep incomplete bytes rather than an incomplete JavaScript string. A
    // rollout write can end in the middle of a multi-byte character, while
    // offsets must remain byte offsets.
    trailing: Buffer.alloc(0),
    workdir,
  };
}

function createAmbientWatcher({
  config,
  onReport,
  log = () => {},
  now = () => Date.now(),
  fsApi = fs,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timers = {},
}) {
  const fileStates = new Map();
  const setIntervalFn = timers.setInterval || setInterval;
  const clearIntervalFn = timers.clearInterval || clearInterval;
  const emitIntervalMs = Number.isFinite(config?.ambientEmitIntervalMs) && config.ambientEmitIntervalMs > 0
    ? config.ambientEmitIntervalMs
    : DEFAULT_EMIT_INTERVAL_MS;
  let interval = null;
  let polling = false;
  let running = false;
  let stopped = false;

  function enabled() {
    return Boolean(config?.ambientEnabled && config?.sessionsDir);
  }

  async function discoverFiles(timestamp) {
    const files = new Map();
    for (const directory of dateDirectories(config.sessionsDir, timestamp)) {
      let entries;
      try {
        entries = await fsApi.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !looksLikeRolloutFile(entry.name)) {
          continue;
        }
        const filePath = path.join(directory, entry.name);
        try {
          const stats = await fsApi.stat(filePath);
          if (stats.mtimeMs >= timestamp - ACTIVE_FILE_AGE_MS) {
            files.set(filePath, stats);
          }
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            safeLog(log, 'ambient watcher could not inspect a rollout file', error);
          }
        }
      }
    }
    return files;
  }

  async function readAppended(filePath, offset, size) {
    const bytesToRead = size - offset;
    if (bytesToRead <= 0) {
      return Buffer.alloc(0);
    }

    const handle = await fsApi.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  function emit(state) {
    if (state.pending.size === 0) {
      return;
    }

    const report = makeReport(state, config);
    state.pending.clear();
    state.lastEmitAt = now();
    try {
      const result = onReport(report);
      if (result && typeof result.then === 'function') {
        void result.catch((error) => safeLog(log, 'ambient watcher could not deliver a report', error));
      }
    } catch (error) {
      safeLog(log, 'ambient watcher could not deliver a report', error);
    }
  }

  function flushDue(timestamp) {
    for (const state of fileStates.values()) {
      if (state.pending.size === 0) {
        continue;
      }
      if (state.lastEmitAt === null || timestamp - state.lastEmitAt >= emitIntervalMs) {
        emit(state);
      }
    }
  }

  async function processFile(filePath, stats, timestamp) {
    let state = fileStates.get(filePath);
    if (!state) {
      state = createFileState(stats.size, config.cwd);
      state.lastSeenAt = timestamp;
      fileStates.set(filePath, state);
      return;
    }

    state.lastSeenAt = timestamp;
    if (stats.size < state.offset) {
      state.offset = stats.size;
      state.trailing = Buffer.alloc(0);
      return;
    }
    if (stats.size === state.offset) {
      return;
    }

    let appended;
    try {
      appended = await readAppended(filePath, state.offset, stats.size);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        safeLog(log, 'ambient watcher could not read a rollout file', error);
      }
      return;
    }
    if (stopped) {
      return;
    }

    state.offset += appended.length;
    const lines = [];
    const bytes = Buffer.concat([state.trailing, appended]);
    let lineStart = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) {
        continue;
      }
      let line = bytes.subarray(lineStart, index);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, -1);
      }
      lines.push(line.toString('utf8'));
      lineStart = index + 1;
    }
    state.trailing = bytes.subarray(lineStart);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      for (const signal of signalsFromEvent(event)) {
        if (signal.workdir) {
          state.workdir = signal.workdir;
        }
        state.pending.set(signal.key, signal);
      }
    }
  }

  function pruneStates(timestamp, activeFiles) {
    for (const [filePath, state] of fileStates) {
      if (
        !activeFiles.has(filePath) &&
        state.pending.size === 0 &&
        state.lastSeenAt > 0 &&
        timestamp - state.lastSeenAt > ACTIVE_FILE_AGE_MS
      ) {
        fileStates.delete(filePath);
      }
    }
  }

  async function poll() {
    if (!enabled() || stopped || polling) {
      return;
    }
    polling = true;
    try {
      const timestamp = now();
      const activeFiles = await discoverFiles(timestamp);
      if (stopped) {
        return;
      }
      for (const [filePath, stats] of activeFiles) {
        await processFile(filePath, stats, timestamp);
        if (stopped) {
          return;
        }
      }
      flushDue(timestamp);
      pruneStates(timestamp, activeFiles);
    } catch (error) {
      safeLog(log, 'ambient watcher poll failed', error);
    } finally {
      polling = false;
    }
  }

  function start() {
    if (!enabled() || running) {
      return;
    }
    stopped = false;
    running = true;
    void poll();
    interval = setIntervalFn(() => {
      void poll();
    }, pollIntervalMs);
    interval.unref?.();
  }

  function stop() {
    stopped = true;
    running = false;
    if (interval) {
      clearIntervalFn(interval);
      interval = null;
    }
    fileStates.clear();
  }

  return { poll, start, stop };
}

module.exports = {
  ACTIVE_FILE_AGE_MS,
  DEFAULT_EMIT_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  createAmbientWatcher,
  dateDirectories,
  signalsFromEvent,
};
