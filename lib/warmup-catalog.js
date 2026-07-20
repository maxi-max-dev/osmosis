'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The catalog is deliberately data-only. It is safe to consult from the
// Ambient fast path because matching never asks a model, reads a rollout
// payload for display, or starts a subprocess.
const CATALOG_VERSION = 1;
const WARMUP_CATALOG_PATH = path.join(__dirname, 'warmup-catalog.json');
const MAX_ARGV_TOKENS = 32;
const MAX_ARGV_TOKEN_LENGTH = 512;
const MAX_COMMAND_LENGTH = 4_096;
const USER_COPY_FIELDS = ['title', 'lesson', 'question', 'explanation'];
const CATALOG_FIELDS = ['catalog_version', 'concepts'];
const CONCEPT_FIELDS = [
  'concept_id',
  'aliases',
  'triggers',
  'title',
  'lesson',
  'question',
  'options',
  'correct_index',
  'explanation',
];

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return Object.freeze(value);
}

/**
 * Load the checked-in data file without executing catalog code. Parse and
 * schema failures deliberately return null: normal qualification then turns
 * them into the existing `catalog-invalid` suppression instead of
 * interrupting the agent.
 */
function loadWarmupCatalog(filePath = WARMUP_CATALOG_PATH) {
  try {
    const catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Function declarations are hoisted, so an explicit catalog can be
    // validated safely while this module initializes its checked-in data.
    return validateWarmupCatalog(catalog).valid ? freeze(catalog) : null;
  } catch {
    return null;
  }
}

const WARMUP_CATALOG = loadWarmupCatalog();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/u.test(value);
}

function onlyCodeMayContainLatin(value) {
  const outsideCode = value.replace(/`[^`\r\n]+`/g, '');
  return !/[A-Za-z]/.test(outsideCode);
}

function validConceptId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{1,95}$/.test(value);
}

function validAlias(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9:._/-]{0,95}$/.test(value);
}

function validArgv(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_ARGV_TOKENS
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_ARGV_TOKEN_LENGTH);
}

function validTrigger(trigger) {
  if (!isPlainObject(trigger) || typeof trigger.type !== 'string') {
    return false;
  }
  if (trigger.type === 'exec') {
    return hasExactKeys(trigger, ['type', 'argv']) && validArgv(trigger.argv);
  }
  if (trigger.type === 'patch') {
    return hasExactKeys(trigger, ['type', 'extension'])
      && typeof trigger.extension === 'string'
      && /^\.[a-z0-9]{1,12}$/.test(trigger.extension);
  }
  if (trigger.type === 'mcp') {
    return hasExactKeys(trigger, ['type', 'server', 'tool'])
      && typeof trigger.server === 'string'
      && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(trigger.server)
      && typeof trigger.tool === 'string'
      && /^[a-z0-9][a-z0-9._-]{0,95}$/.test(trigger.tool);
  }
  return false;
}

function validateChineseCopy(value, location, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${location} 缺少中文文案`);
    return;
  }
  if (!hasChinese(value)) {
    errors.push(`${location} 必须包含自然中文`);
  }
  if (!onlyCodeMayContainLatin(value)) {
    errors.push(`${location} 的非中文内容必须使用反引号标记代码标识符`);
  }
}

/**
 * Validate an arbitrary catalog before it is allowed to serve a learner.
 * Validation returns data instead of throwing so the owner can ledger a
 * `catalog-invalid` suppression and keep the agent's work uninterrupted.
 */
function validateWarmupCatalog(catalog = WARMUP_CATALOG) {
  const errors = [];
  if (!hasExactKeys(catalog, CATALOG_FIELDS)) {
    return { valid: false, errors: ['卡库外层结构无效'] };
  }
  if (catalog.catalog_version !== CATALOG_VERSION) {
    errors.push('卡库版本无效');
  }
  if (!Array.isArray(catalog.concepts) || catalog.concepts.length < 20) {
    errors.push('卡库至少需要二十个概念');
  }

  const conceptIds = new Set();
  const aliases = new Set();
  for (const [index, concept] of (Array.isArray(catalog.concepts) ? catalog.concepts : []).entries()) {
    const location = `概念 ${index + 1}`;
    if (!hasExactKeys(concept, CONCEPT_FIELDS)) {
      errors.push(`${location} 结构无效`);
      continue;
    }
    if (!validConceptId(concept.concept_id)) {
      errors.push(`${location} 的概念标识无效`);
    } else if (conceptIds.has(concept.concept_id) || aliases.has(concept.concept_id)) {
      errors.push(`${location} 的概念标识重复`);
    } else {
      conceptIds.add(concept.concept_id);
    }
    if (!Array.isArray(concept.aliases) || concept.aliases.some((alias) => !validAlias(alias))) {
      errors.push(`${location} 的别名无效`);
    } else {
      for (const alias of concept.aliases) {
        if (aliases.has(alias) || conceptIds.has(alias)) {
          errors.push(`${location} 的别名重复`);
        }
        aliases.add(alias);
      }
    }
    if (!Array.isArray(concept.triggers) || concept.triggers.length === 0 || concept.triggers.some((trigger) => !validTrigger(trigger))) {
      errors.push(`${location} 的触发器无效`);
    }
    for (const field of USER_COPY_FIELDS) {
      validateChineseCopy(concept[field], `${location} 的${field}`, errors);
    }
    if (!Array.isArray(concept.options) || concept.options.length !== 3 || concept.options.some((option) => typeof option !== 'string' || !option.trim())) {
      errors.push(`${location} 的选项必须恰好有三个`);
    } else {
      for (const [optionIndex, option] of concept.options.entries()) {
        validateChineseCopy(option, `${location} 的选项 ${optionIndex + 1}`, errors);
      }
      if (new Set(concept.options).size !== 3) {
        errors.push(`${location} 的选项不能重复`);
      }
    }
    if (!Number.isInteger(concept.correct_index) || concept.correct_index < 0 || concept.correct_index > 2) {
      errors.push(`${location} 的正确答案无效`);
    }
  }
  return { valid: errors.length === 0, errors };
}

function assertValidWarmupCatalog(catalog = WARMUP_CATALOG) {
  const result = validateWarmupCatalog(catalog);
  if (!result.valid) {
    throw new Error(`Warmup catalog is invalid: ${result.errors.join('; ')}`);
  }
  return catalog;
}

function localConceptId(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const colon = value.indexOf(':');
  return colon > 0 && colon < value.length - 1 ? value.slice(colon + 1) : value;
}

function catalogEntryForConceptId(value, catalog = WARMUP_CATALOG) {
  const localId = localConceptId(value);
  if (!isPlainObject(catalog) || !Array.isArray(catalog.concepts) || !localId) {
    return null;
  }
  return catalog.concepts.find((concept) => concept?.concept_id === localId || concept?.aliases?.includes(localId)) || null;
}

// Provider cards and warmup cards can point at the same canonical concept
// without comparing their human-facing titles.  Namespaced provider ids are
// deliberately reduced to their local id for this lookup only.
function canonicalWarmupConceptId(value, catalog = WARMUP_CATALOG) {
  return catalogEntryForConceptId(value, catalog)?.concept_id || '';
}

function decodeInput(value) {
  if (isPlainObject(value) || Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.length > MAX_COMMAND_LENGTH) {
    return null;
  }
  let current = value.trim();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const parsed = JSON.parse(current);
      if (isPlainObject(parsed) || Array.isArray(parsed)) {
        return parsed;
      }
      if (typeof parsed !== 'string') {
        return null;
      }
      current = parsed;
    } catch {
      return { cmd: current };
    }
  }
  return { cmd: current };
}

// This is a deliberately small shell-word reader, not a shell interpreter.
// It accepts plain argv-like commands and rejects composition, expansion, and
// redirection.  An unparseable command is a suppression, never a guess.
function parseSimpleArgv(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_LENGTH) {
    return null;
  }
  if (/[\r\n;|&<>`$\\]/.test(command)) {
    return null;
  }
  const argv = [];
  let token = '';
  let quote = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        token += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        argv.push(token);
        token = '';
      }
      continue;
    }
    token += char;
  }
  if (quote) {
    return null;
  }
  if (token) {
    argv.push(token);
  }
  if (!validArgv(argv)) {
    return null;
  }
  // Do not try to skip environment assignments or interpret `sh -c`: doing
  // so would turn a compound shell expression into a false positive.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
    return null;
  }
  return argv;
}

function structuredArgvFromInput(input) {
  const decoded = decodeInput(input);
  if (Array.isArray(decoded)) {
    return validArgv(decoded) ? [...decoded] : null;
  }
  if (!isPlainObject(decoded)) {
    return null;
  }
  if (validArgv(decoded.argv)) {
    return [...decoded.argv];
  }
  const command = typeof decoded.cmd === 'string'
    ? decoded.cmd
    : typeof decoded.command === 'string'
      ? decoded.command
      : '';
  return parseSimpleArgv(command);
}

function payloadForEvent(event) {
  return isPlainObject(event?.payload) ? event.payload : isPlainObject(event) ? event : null;
}

function execObservation(event) {
  const payload = payloadForEvent(event);
  if (!payload || payload.type !== 'custom_tool_call' || payload.name !== 'exec') {
    return null;
  }
  const argv = structuredArgvFromInput(payload.input);
  if (!argv) {
    return null;
  }
  const first = path.basename(argv[0]);
  if (!first || first === '.' || first === path.sep) {
    return null;
  }
  return { type: 'exec', argv: [first, ...argv.slice(1)] };
}

function patchObservation(event) {
  const payload = payloadForEvent(event);
  if (!payload || payload.type !== 'patch_apply_end' || payload.success !== true || !isPlainObject(payload.changes)) {
    return null;
  }
  const extensions = [...new Set(Object.keys(payload.changes)
    .filter((filePath) => typeof filePath === 'string')
    .map((filePath) => path.extname(filePath).toLowerCase())
    .filter(Boolean))].sort();
  return extensions.length > 0 ? { type: 'patch', extensions } : null;
}

function mcpObservation(event) {
  const payload = payloadForEvent(event);
  const invocation = payload?.invocation;
  if (!payload || payload.type !== 'mcp_tool_call_end' || !isPlainObject(invocation)) {
    return null;
  }
  if (typeof invocation.server !== 'string' || typeof invocation.tool !== 'string') {
    return null;
  }
  return { type: 'mcp', server: invocation.server, tool: invocation.tool };
}

function observationsFromEvent(event) {
  return [execObservation(event), patchObservation(event), mcpObservation(event)].filter(Boolean);
}

function triggerMatchesObservation(trigger, observation) {
  if (trigger.type !== observation.type) {
    return false;
  }
  if (trigger.type === 'exec') {
    return trigger.argv.every((value, index) => observation.argv[index] === value);
  }
  if (trigger.type === 'patch') {
    return observation.extensions.includes(trigger.extension);
  }
  return observation.server === trigger.server && observation.tool === trigger.tool;
}

function publicTrigger(trigger) {
  if (trigger.type === 'exec') {
    return { type: 'exec', argv: [...trigger.argv] };
  }
  if (trigger.type === 'patch') {
    return { type: 'patch', extension: trigger.extension };
  }
  return { type: 'mcp', server: trigger.server, tool: trigger.tool };
}

function matchesForWarmupEvent(event, catalog = WARMUP_CATALOG) {
  const validation = validateWarmupCatalog(catalog);
  if (!validation.valid) {
    return [];
  }
  const observations = observationsFromEvent(event);
  const matches = [];
  for (const observation of observations) {
    for (const concept of catalog.concepts) {
      for (const trigger of concept.triggers) {
        if (triggerMatchesObservation(trigger, observation)) {
          matches.push({
            concept,
            observation: freeze({ ...observation, ...(observation.argv ? { argv: [...observation.argv] } : {}), ...(observation.extensions ? { extensions: [...observation.extensions] } : {}) }),
            trigger: publicTrigger(trigger),
          });
        }
      }
    }
  }
  return matches;
}

function toCanonicalSet(values, catalog) {
  const result = new Set();
  for (const value of values || []) {
    const canonical = canonicalWarmupConceptId(value, catalog);
    if (canonical) {
      result.add(canonical);
    }
  }
  return result;
}

function makeWarmupCandidate(match, {
  catalog = WARMUP_CATALOG,
  observation_id = null,
  activity_epoch_id = observation_id,
  warmup_id = null,
} = {}) {
  const concept = match?.concept;
  if (!concept) {
    return null;
  }
  return {
    kind: 'warmup',
    catalog_version: catalog.catalog_version,
    warmup_id,
    concept_id: concept.concept_id,
    concept_name: concept.title,
    observation_id,
    activity_epoch_id,
    title: concept.title,
    lesson: concept.lesson,
    question: concept.question,
    options: [...concept.options],
    correct_index: concept.correct_index,
    explanation: concept.explanation,
    trigger: match.trigger,
    state: {
      answered: false,
      chosen_index: null,
      correct: null,
    },
  };
}

/**
 * Catalog-only qualification.  The owner supplies durable project/studio
 * facts; this helper returns a stable, ledger-friendly reason rather than
 * making any write or starting any generation.
 */
function qualifyWarmupEvent({
  event,
  catalog = WARMUP_CATALOG,
  observation_id = null,
  activity_epoch_id = observation_id,
  warmup_id = null,
  masteredConceptIds = [],
  servedConceptIds = [],
  paused = false,
  registered = true,
  carried = true,
  nowKind = null,
  nextReady = false,
  rateLimited = false,
} = {}) {
  const validation = validateWarmupCatalog(catalog);
  if (!validation.valid) {
    return { qualified: false, reason: 'catalog-invalid', errors: validation.errors, matches: [] };
  }
  if (paused) {
    return { qualified: false, reason: 'learning-paused', matches: [] };
  }
  if (!registered) {
    return { qualified: false, reason: 'project-unregistered', matches: [] };
  }
  if (!carried) {
    return { qualified: false, reason: 'project-uncarried', matches: [] };
  }
  const matches = matchesForWarmupEvent(event, catalog);
  if (matches.length === 0) {
    return { qualified: false, reason: 'trigger-not-allowlisted', matches };
  }
  const match = matches[0];
  const mastered = toCanonicalSet(masteredConceptIds, catalog);
  if (mastered.has(match.concept.concept_id)) {
    return { qualified: false, reason: 'mastered', concept_id: match.concept.concept_id, matches };
  }
  const served = toCanonicalSet(servedConceptIds, catalog);
  if (served.has(match.concept.concept_id)) {
    return { qualified: false, reason: 'epoch-duplicate', concept_id: match.concept.concept_id, matches };
  }
  if (nowKind === 'real') {
    return { qualified: false, reason: 'current-real', concept_id: match.concept.concept_id, matches };
  }
  if (nowKind === 'warmup') {
    return { qualified: false, reason: 'current-warmup', concept_id: match.concept.concept_id, matches };
  }
  if (nowKind !== null && nowKind !== undefined) {
    return { qualified: false, reason: 'current-occupied', concept_id: match.concept.concept_id, matches };
  }
  if (nextReady) {
    return { qualified: false, reason: 'next-ready', concept_id: match.concept.concept_id, matches };
  }
  if (rateLimited) {
    return { qualified: false, reason: 'rate-limited', concept_id: match.concept.concept_id, matches };
  }
  return {
    qualified: true,
    reason: null,
    concept_id: match.concept.concept_id,
    matches,
    candidate: makeWarmupCandidate(match, { catalog, observation_id, activity_epoch_id, warmup_id }),
  };
}

module.exports = {
  CATALOG_VERSION,
  WARMUP_CATALOG_PATH,
  WARMUP_CATALOG,
  assertValidWarmupCatalog,
  canonicalWarmupConceptId,
  catalogEntryForConceptId,
  makeWarmupCandidate,
  matchesForWarmupEvent,
  observationsFromEvent,
  loadWarmupCatalog,
  qualifyWarmupEvent,
  structuredArgvFromInput,
  validateWarmupCatalog,
};
