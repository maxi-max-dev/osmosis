'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const ACTIVE_FILE_AGE_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_EMIT_INTERVAL_MS = 45_000;
const DEFAULT_MAX_TRACKED_FILES = 32;
const DEFAULT_MAX_BYTES_PER_POLL = 256 * 1024;
const DEFAULT_MAX_JSONL_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_PARTIAL_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_PENDING_SIGNALS = 24;
const MAX_CANONICAL_CACHE_ENTRIES = 64;
const MAX_STACK_HINTS = 8;
const MAX_EVENT_TEXT_BYTES = 4 * 1024;
const NOISE_COMMANDS = new Set(['cd', 'cat', 'echo', 'ls', 'pwd']);

// Every value that can make it into a card is deliberately selected from one
// of these short allowlists. Rollout records can contain arbitrary commands,
// paths, server names, and tool inputs; none of those strings are displayed.
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

const MCP_HINTS = [
  [/\bbrowser\b/i, 'browser'],
  [/\bgithub\b/i, 'github'],
  [/\bfilesystem\b/i, 'filesystem'],
  [/\bfigma\b/i, 'figma'],
  [/\bnotion\b/i, 'notion'],
  [/\bslack\b/i, 'slack'],
  [/\bplaywright\b/i, 'playwright'],
];

const ALLOWED_EXTENSIONS = new Set([
  '.cjs', '.css', '.go', '.html', '.java', '.js', '.json', '.jsx', '.kt', '.md',
  '.mjs', '.php', '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.ts', '.tsx',
  '.yaml', '.yml',
]);

function positiveLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function limitsFor(config) {
  return {
    maxBytesPerPoll: positiveLimit(config?.ambientMaxBytesPerPoll, DEFAULT_MAX_BYTES_PER_POLL),
    maxJsonlLineBytes: positiveLimit(config?.ambientMaxJsonlLineBytes, DEFAULT_MAX_JSONL_LINE_BYTES),
    maxPartialLineBytes: positiveLimit(config?.ambientMaxPartialLineBytes, DEFAULT_MAX_PARTIAL_LINE_BYTES),
    maxPendingSignals: positiveLimit(config?.ambientMaxPendingSignals, DEFAULT_MAX_PENDING_SIGNALS),
    maxTrackedFiles: positiveLimit(config?.ambientMaxTrackedFiles, DEFAULT_MAX_TRACKED_FILES),
  };
}

function unique(values, limit = MAX_STACK_HINTS) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function shortText(value, fallback = '', limit = MAX_EVENT_TEXT_BYTES) {
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
  const text = shortText(value);
  return unique([
    ...TOOL_HINTS.filter(([pattern]) => pattern.test(text)).map(([, hint]) => hint),
    ...frameworkHintsFromText(text),
  ]);
}

function frameworkHintsFromText(value) {
  const text = shortText(value);
  return unique(FRAMEWORK_HINTS.filter(([pattern]) => pattern.test(text)).map(([, hint]) => hint));
}

function mcpHintsFromText(value) {
  const text = shortText(value);
  return unique([
    ...MCP_HINTS.filter(([pattern]) => pattern.test(text)).map(([, hint]) => hint),
    ...frameworkHintsFromText(text),
  ]);
}

function extensionHints(filePaths) {
  return unique(
    filePaths
      .slice(0, 64)
      .map((filePath) => path.extname(shortText(filePath, '', 1_024)).toLowerCase())
      .filter((extension) => ALLOWED_EXTENSIONS.has(extension)),
  );
}

function commandName(command) {
  const tokens = shortText(command, '', MAX_EVENT_TEXT_BYTES).split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    tokens.shift();
  }
  return path.basename(tokens[0] || '').toLowerCase();
}

function isNoiseCommand(command) {
  const normalized = shortText(command, '', MAX_EVENT_TEXT_BYTES);
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

function execDetails(payload) {
  if (payload?.type !== 'custom_tool_call' || payload.name !== 'exec') {
    return null;
  }
  const input = objectFromExecInput(payload.input);
  return {
    command: shortText(input?.cmd || input?.command, '', MAX_EVENT_TEXT_BYTES),
    workdir: shortText(input?.workdir || input?.cwd, '', 2_048),
  };
}

function execSignal(payload) {
  const details = execDetails(payload);
  if (!details || !details.command || isNoiseCommand(details.command)) {
    return null;
  }

  const hints = hintsFromText(details.command);
  const displayHints = hints.slice(0, 3);
  return {
    key: 'exec:' + (hints.length > 0 ? hints.join(',') : 'terminal'),
    kind: 'activity',
    label: displayHints.length > 0 ? 'ran ' + joinWords(displayHints) : 'ran a terminal command',
    hints: hints.length > 0 ? hints : ['terminal'],
    workdir: details.workdir,
  };
}

function patchSignal(payload) {
  if (payload?.type !== 'patch_apply_end' || payload.success !== true || !payload.changes || typeof payload.changes !== 'object') {
    return null;
  }

  const changedPaths = Object.keys(payload.changes).filter((filePath) => typeof filePath === 'string');
  if (changedPaths.length === 0) {
    return null;
  }

  const hints = unique([...extensionHints(changedPaths), ...frameworkHintsFromText(changedPaths.join(' '))]);
  return {
    key: 'patch:' + (hints.length > 0 ? hints.join(',') : 'file-change'),
    kind: 'patch',
    label: 'applied a file change',
    hints: hints.length > 0 ? hints : ['file-change'],
    workdir: '',
  };
}

function mcpSignal(payload) {
  if (payload?.type !== 'mcp_tool_call_end') {
    return null;
  }

  const server = shortText(payload.invocation?.server, '', 96);
  const tool = shortText(payload.invocation?.tool, '', 96);
  if (!server || !tool || server.toLowerCase() === 'osmosis') {
    return null;
  }

  // Keep the raw invocation only long enough to match an allowlisted category.
  // Never use its server/tool strings in an identifier, hint, or display line.
  const hints = mcpHintsFromText(server + ' ' + tool);
  const displayHint = hints.find((hint) => MCP_HINTS.some(([, allowed]) => allowed === hint));
  return {
    key: 'mcp:' + (hints.length > 0 ? hints.join(',') : 'mcp'),
    kind: 'activity',
    label: displayHint ? 'used ' + displayHint : 'used an MCP tool',
    hints: hints.length > 0 ? hints : ['mcp'],
    workdir: '',
  };
}

function metadataHasIgnoreMarker(metadata, depth = 0) {
  if (depth > 2 || metadata === null || metadata === undefined) {
    return false;
  }
  if (typeof metadata === 'string') {
    return /(?:OSMOSIS_AMBIENT_IGNORE|osmosis-ambient-ignore)/i.test(metadata.slice(0, MAX_EVENT_TEXT_BYTES));
  }
  if (typeof metadata !== 'object') {
    return false;
  }
  return Object.entries(metadata)
    .slice(0, 32)
    .some(([key, value]) =>
      /(?:OSMOSIS_AMBIENT_IGNORE|osmosis-ambient-ignore)/i.test(key) || metadataHasIgnoreMarker(value, depth + 1),
    );
}

function eventHasIgnoreMarker(event) {
  if (!event || typeof event !== 'object') {
    return false;
  }
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  return [event.metadata, event._meta, payload.metadata, payload._meta, payload.input].some((value) =>
    metadataHasIgnoreMarker(value),
  );
}

function signalsFromEvent(event) {
  if (!event || typeof event !== 'object' || !event.payload || typeof event.payload !== 'object' || eventHasIgnoreMarker(event)) {
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

function workdirFromEvent(event) {
  if (!event || event.type !== 'response_item' || eventHasIgnoreMarker(event)) {
    return '';
  }
  return execDetails(event.payload)?.workdir || '';
}

function joinWords(values) {
  if (values.length <= 1) {
    return values[0] || '';
  }
  if (values.length === 2) {
    return values.join(' and ');
  }
  return values.slice(0, -1).join(', ') + ', and ' + values.at(-1);
}

function makeReport(state) {
  const signals = [...state.pending.values()];
  const descriptions = unique(signals.map((signal) => signal.label), 4);
  const stackHints = unique(signals.flatMap((signal) => signal.hints), MAX_STACK_HINTS);
  const observedKind = signals.some((signal) => signal.kind === 'patch') ? 'change' : 'activity';

  return {
    task: 'Observed local activity',
    what_i_did: descriptions.length > 0
      ? 'Observed ' + descriptions.join('; ') + ' locally.'
      : 'Observed local development activity.',
    stack_hints: stackHints,
    source: 'observed',
    observed_kind: observedKind,
  };
}

function fileIdentity(stats) {
  if (!stats || !Number.isFinite(stats.dev) || !Number.isFinite(stats.ino)) {
    return null;
  }
  return String(stats.dev) + ':' + String(stats.ino);
}

function createFileState({ offset, identity }) {
  return {
    discardUntilNewline: false,
    identity,
    ignoreAmbient: false,
    lastEmitAt: null,
    lastSeenAt: 0,
    offset,
    pending: new Map(),
    projectMatched: false,
    // Keep incomplete bytes rather than an incomplete JavaScript string. A
    // rollout write can end in the middle of a multi-byte character, while
    // offsets must remain byte offsets.
    trailing: Buffer.alloc(0),
    workdir: '',
  };
}

function resetFileState(state, { offset, identity }) {
  state.discardUntilNewline = false;
  state.identity = identity;
  state.ignoreAmbient = false;
  state.lastEmitAt = null;
  state.offset = offset;
  state.projectMatched = false;
  state.trailing = Buffer.alloc(0);
  state.workdir = '';
}

function logLimit(log, budget, key, message) {
  if (budget.logged.has(key)) {
    return;
  }
  budget.logged.add(key);
  safeLog(log, message);
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
  const canonicalCache = new Map();
  const limits = limitsFor(config);
  const setIntervalFn = timers.setInterval || setInterval;
  const clearIntervalFn = timers.clearInterval || clearInterval;
  const emitIntervalMs = Number.isFinite(config?.ambientEmitIntervalMs) && config.ambientEmitIntervalMs > 0
    ? config.ambientEmitIntervalMs
    : DEFAULT_EMIT_INTERVAL_MS;
  let interval = null;
  let initialScanComplete = false;
  let startupBaseline = null;
  let pendingSignalCount = 0;
  let polling = false;
  let running = false;
  let stopped = false;

  function enabled() {
    return Boolean(config?.ambientEnabled && config?.sessionsDir && config?.mode !== 'record' && config?.mode !== 'replay');
  }

  async function canonicalizeCwd(value) {
    const raw = shortText(value, '', 2_048);
    if (!raw) {
      return '';
    }
    const resolved = path.resolve(raw);
    if (!canonicalCache.has(resolved)) {
      if (canonicalCache.size >= MAX_CANONICAL_CACHE_ENTRIES) {
        canonicalCache.clear();
      }
      const canonical = (async () => {
        try {
          return typeof fsApi.realpath === 'function' ? await fsApi.realpath(resolved) : '';
        } catch {
          // Project identity is an isolation boundary. If either path cannot
          // be canonicalized, the session stays unknown and emits nothing.
          return '';
        }
      })();
      canonicalCache.set(resolved, canonical);
    }
    const canonical = await canonicalCache.get(resolved);
    // A transient filesystem race must not turn an unknown session into a
    // permanently unknown one. Successful canonical paths stay cached; a
    // failed lookup is retried on a later exec event before any signal emits.
    if (!canonical) {
      canonicalCache.delete(resolved);
    }
    return canonical;
  }

  const projectCwd = canonicalizeCwd(config?.cwd || process.cwd());

  function captureStartupBaseline() {
    const candidates = [];
    let overflow = false;
    const timestamp = now();
    for (const directory of dateDirectories(config.sessionsDir, timestamp).sort()) {
      let entries;
      try {
        entries = fsSync.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          safeLog(log, 'ambient watcher could not snapshot startup rollout files', error);
        }
        continue;
      }

      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !looksLikeRolloutFile(entry.name)) {
          continue;
        }
        if (candidates.length >= limits.maxTrackedFiles) {
          overflow = true;
          continue;
        }
        const filePath = path.join(directory, entry.name);
        try {
          const stats = fsSync.statSync(filePath);
          candidates.push({ filePath, stats });
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            safeLog(log, 'ambient watcher could not snapshot a rollout file', error);
          }
        }
      }
    }

    if (overflow) {
      safeLog(log, 'ambient watcher dropped startup rollout files because the tracked-file limit was reached');
    }
    return new Map(
      candidates.map(({ filePath, stats }) => [filePath, { identity: fileIdentity(stats), offset: stats.size }]),
    );
  }

  async function discoverFiles(timestamp, budget) {
    const candidates = [];
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

      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !looksLikeRolloutFile(entry.name)) {
          continue;
        }
        const filePath = path.join(directory, entry.name);
        try {
          const stats = await fsApi.stat(filePath);
          if (stats.mtimeMs >= timestamp - ACTIVE_FILE_AGE_MS) {
            candidates.push({ filePath, stats });
          }
        } catch (error) {
          if (!error || error.code !== 'ENOENT') {
            safeLog(log, 'ambient watcher could not inspect a rollout file', error);
          }
        }
      }
    }

    candidates.sort((left, right) => left.filePath.localeCompare(right.filePath));
    const known = candidates.filter(({ filePath }) => fileStates.has(filePath));
    const unknown = candidates.filter(({ filePath }) => !fileStates.has(filePath));
    const selected = [...known, ...unknown].slice(0, limits.maxTrackedFiles);
    if (selected.length < candidates.length) {
      logLimit(log, budget, 'tracked-files', 'ambient watcher dropped rollout files because the tracked-file limit was reached');
    }
    return new Map(selected.map(({ filePath, stats }) => [filePath, stats]));
  }

  async function readAppended(filePath, offset, size, byteLimit) {
    const bytesToRead = Math.min(size - offset, byteLimit);
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

  function consumeLines(state, appended, budget) {
    let bytes = Buffer.concat([state.trailing, appended]);
    if (state.discardUntilNewline) {
      const newline = bytes.indexOf(0x0a);
      if (newline === -1) {
        return [];
      }
      state.discardUntilNewline = false;
      bytes = bytes.subarray(newline + 1);
    }

    const lines = [];
    let lineStart = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== 0x0a) {
        continue;
      }
      let line = bytes.subarray(lineStart, index);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length > limits.maxJsonlLineBytes) {
        logLimit(log, budget, 'line-length', 'ambient watcher dropped an oversized JSONL line');
      } else {
        lines.push(line.toString('utf8'));
      }
      lineStart = index + 1;
    }

    const trailing = bytes.subarray(lineStart);
    if (trailing.length > limits.maxPartialLineBytes) {
      state.trailing = Buffer.alloc(0);
      state.discardUntilNewline = true;
      logLimit(log, budget, 'partial-line-length', 'ambient watcher dropped an oversized partial JSONL line');
    } else {
      state.trailing = trailing;
    }
    return lines;
  }

  async function updateSessionCwd(state, workdir) {
    if (!workdir) {
      return;
    }
    const [candidate, project] = await Promise.all([canonicalizeCwd(workdir), projectCwd]);
    state.workdir = candidate;
    state.projectMatched = Boolean(candidate && candidate === project);
    if (!state.projectMatched) {
      // A session can change directories. Never mix its prior target-project
      // signals with events after a move to another project.
      clearPendingSignals(state);
    }
  }

  function clearPendingSignals(state) {
    pendingSignalCount = Math.max(0, pendingSignalCount - state.pending.size);
    state.pending.clear();
  }

  function addPendingSignal(state, signal, budget) {
    if (state.pending.has(signal.key)) {
      state.pending.set(signal.key, signal);
      return;
    }
    if (pendingSignalCount >= limits.maxPendingSignals) {
      logLimit(log, budget, 'pending-signals', 'ambient watcher dropped signals because the pending-signal limit was reached');
      return;
    }
    state.pending.set(signal.key, signal);
    pendingSignalCount += 1;
  }

  function emit(state) {
    if (state.pending.size === 0) {
      return;
    }

    const report = makeReport(state);
    clearPendingSignals(state);
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

  async function processEvent(state, event, budget) {
    if (state.ignoreAmbient) {
      return;
    }
    if (eventHasIgnoreMarker(event)) {
      // The Codex provider gives its isolated child an explicit marker. This
      // is only a belt-and-braces guard; it never affects the MCP process.
      clearPendingSignals(state);
      state.ignoreAmbient = true;
      state.projectMatched = false;
      return;
    }

    const details = execDetails(event?.payload);
    const eventWorkdir = workdirFromEvent(event);
    if (details) {
      // Only patch/MCP events inherit the session cwd. An exec event with no
      // usable workdir is not evidence that it ran in the previously known
      // project, so it contributes no observed signal.
      if (!eventWorkdir) {
        return;
      }
      await updateSessionCwd(state, eventWorkdir);
    }
    if (!state.projectMatched) {
      return;
    }
    for (const signal of signalsFromEvent(event)) {
      addPendingSignal(state, signal, budget);
    }
  }

  async function processFile(filePath, stats, timestamp, budget, initialScan) {
    let state = fileStates.get(filePath);
    const identity = fileIdentity(stats);
    if (!state) {
      if (fileStates.size >= limits.maxTrackedFiles) {
        logLimit(log, budget, 'tracked-files', 'ambient watcher dropped rollout files because the tracked-file limit was reached');
        return;
      }
      const baseline = startupBaseline?.get(filePath);
      state = createFileState({
        offset: baseline ? baseline.offset : initialScan && !startupBaseline ? stats.size : 0,
        identity: baseline?.identity || identity,
      });
      state.lastSeenAt = timestamp;
      fileStates.set(filePath, state);
      // Manual first polls retain the established EOF behavior. When start()
      // captured a baseline, only paths actually present in that synchronous
      // snapshot are history; a file created after start begins at byte zero.
      if (initialScan && !startupBaseline) {
        return;
      }
    }

    state.lastSeenAt = timestamp;
    if (state.identity && identity && state.identity !== identity) {
      clearPendingSignals(state);
      resetFileState(state, { offset: 0, identity });
    } else if (stats.size < state.offset) {
      clearPendingSignals(state);
      resetFileState(state, { offset: 0, identity });
    } else if (!state.identity && identity) {
      state.identity = identity;
    }

    if (stats.size === state.offset) {
      return;
    }
    if (budget.remainingBytes <= 0) {
      logLimit(log, budget, 'poll-bytes', 'ambient watcher deferred rollout bytes because the per-poll byte limit was reached');
      return;
    }

    let appended;
    try {
      appended = await readAppended(filePath, state.offset, stats.size, budget.remainingBytes);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        safeLog(log, 'ambient watcher could not read a rollout file', error);
      }
      return;
    }
    if (stopped || appended.length === 0) {
      return;
    }

    state.offset += appended.length;
    budget.remainingBytes -= appended.length;
    if (state.offset < stats.size) {
      logLimit(log, budget, 'poll-bytes', 'ambient watcher deferred rollout bytes because the per-poll byte limit was reached');
    }

    for (const rawLine of consumeLines(state, appended, budget)) {
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
      await processEvent(state, event, budget);
      if (stopped) {
        return;
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
    const budget = { logged: new Set(), remainingBytes: limits.maxBytesPerPoll };
    try {
      const timestamp = now();
      const initialScan = !initialScanComplete;
      const activeFiles = await discoverFiles(timestamp, budget);
      if (stopped) {
        return;
      }
      for (const [filePath, stats] of activeFiles) {
        await processFile(filePath, stats, timestamp, budget, initialScan);
        if (stopped) {
          return;
        }
      }
      initialScanComplete = true;
      startupBaseline = null;
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
    // Snapshot the current EOFs synchronously before scheduling the first
    // asynchronous discovery. Files created after start() returns are absent
    // from this map and therefore read from byte zero, even if their first
    // event arrives before the first poll completes.
    startupBaseline = captureStartupBaseline();
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
    canonicalCache.clear();
    fileStates.clear();
    pendingSignalCount = 0;
    startupBaseline = null;
  }

  function getDebugState() {
    return {
      trackedFiles: fileStates.size,
      pendingSignals: pendingSignalCount,
    };
  }

  return { getDebugState, poll, start, stop };
}

module.exports = {
  ACTIVE_FILE_AGE_MS,
  DEFAULT_EMIT_INTERVAL_MS,
  DEFAULT_MAX_BYTES_PER_POLL,
  DEFAULT_MAX_JSONL_LINE_BYTES,
  DEFAULT_MAX_PARTIAL_LINE_BYTES,
  DEFAULT_MAX_PENDING_SIGNALS,
  DEFAULT_MAX_TRACKED_FILES,
  DEFAULT_POLL_INTERVAL_MS,
  createAmbientWatcher,
  dateDirectories,
  eventHasIgnoreMarker,
  signalsFromEvent,
  workdirFromEvent,
};
