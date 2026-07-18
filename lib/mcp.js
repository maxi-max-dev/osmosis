'use strict';

const { DEFAULT_ANSWER_URL, INLINE_CARD_URI, renderInlineCard } = require('./inline-card');
const { log } = require('./log');

const MCP_PROTOCOL_VERSION = '2025-06-18';

const REPORT_DESCRIPTION =
  'Call this immediately after completing each task or milestone, before starting the next. Write what_i_did in English.';

const REPORT_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string' },
    what_i_did: { type: 'string' },
    stack_hints: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'what_i_did', 'stack_hints'],
  additionalProperties: false,
};

const INLINE_CARD_TOOL_META = {
  ui: {
    resourceUri: INLINE_CARD_URI,
  },
};

const INLINE_CARD_RESOURCE = {
  uri: INLINE_CARD_URI,
  name: 'Osmosis inline lesson',
  description: 'The newest unanswered Osmosis lesson for the Codex conversation.',
  mimeType: 'text/html',
};

const REPORT_TOOL = {
  name: 'osmosis_report',
  description: REPORT_DESCRIPTION,
  inputSchema: REPORT_INPUT_SCHEMA,
  _meta: INLINE_CARD_TOOL_META,
};

function validateReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'arguments must be an object.' };
  }

  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    keys.some((key) => !['task', 'what_i_did', 'stack_hints'].includes(key)) ||
    typeof value.task !== 'string' ||
    typeof value.what_i_did !== 'string' ||
    !Array.isArray(value.stack_hints) ||
    value.stack_hints.some((hint) => typeof hint !== 'string')
  ) {
    return { error: 'arguments must match the osmosis_report input schema.' };
  }

  return {
    value: {
      task: value.task,
      what_i_did: value.what_i_did,
      stack_hints: value.stack_hints,
    },
  };
}

function createMcpServer({
  onReport,
  getInlineCardHtml = () => renderInlineCard(),
  getInlineAnswerOrigin = () => new URL(DEFAULT_ANSWER_URL).origin,
  input = process.stdin,
  output = process.stdout,
}) {
  let buffer = '';

  function write(message) {
    output.write(`${JSON.stringify(message)}\n`);
  }

  function inlineCardHtml() {
    try {
      const html = getInlineCardHtml();
      if (typeof html === 'string') {
        return html;
      }
    } catch (error) {
      log('could not render the inline MCP card', error && error.message ? error.message : error);
    }

    return renderInlineCard();
  }

  function inlineAnswerOrigin() {
    try {
      const candidate = getInlineAnswerOrigin();
      return new URL(candidate).origin;
    } catch {
      return new URL(DEFAULT_ANSWER_URL).origin;
    }
  }

  function result(id, value) {
    if (id === undefined || id === null) {
      return;
    }
    write({ jsonrpc: '2.0', id, result: value });
  }

  function error(id, code, message) {
    if (id === undefined || id === null) {
      return;
    }
    write({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  }

  function handle(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0') {
      error(request && request.id, -32600, 'Invalid Request');
      return;
    }

    const { id, method, params } = request;
    if (typeof method !== 'string') {
      error(id, -32600, 'Invalid Request');
      return;
    }

    if (method === 'notifications/initialized') {
      return;
    }

    if (method === 'initialize') {
      result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'osmosis', version: '0.1.0' },
        instructions: REPORT_DESCRIPTION,
      });
      return;
    }

    if (method === 'tools/list') {
      result(id, { tools: [REPORT_TOOL] });
      return;
    }

    if (method === 'resources/list') {
      result(id, { resources: [INLINE_CARD_RESOURCE] });
      return;
    }

    if (method === 'resources/read') {
      if (!params || params.uri !== INLINE_CARD_URI) {
        error(id, -32602, 'Unknown resource.');
        return;
      }

      result(id, {
        contents: [
          {
            uri: INLINE_CARD_URI,
            mimeType: 'text/html',
            text: inlineCardHtml(),
            _meta: {
              ui: {
                csp: {
                  connectDomains: [inlineAnswerOrigin()],
                  resourceDomains: [],
                },
              },
            },
          },
        ],
      });
      return;
    }

    if (method === 'tools/call') {
      if (!params || params.name !== 'osmosis_report') {
        error(id, -32602, 'Unknown tool.');
        return;
      }

      const validation = validateReport(params.arguments);
      if (validation.error) {
        error(id, -32602, validation.error);
        return;
      }

      onReport(validation.value);
      result(id, {
        content: [{ type: 'text', text: 'Osmosis recorded this milestone.' }],
        isError: false,
        _meta: INLINE_CARD_TOOL_META,
      });
      return;
    }

    error(id, -32601, 'Method not found');
  }

  function receive(chunk) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (rawLine) {
        try {
          handle(JSON.parse(rawLine));
        } catch {
          error(null, -32700, 'Parse error');
        }
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }

  function start() {
    input.setEncoding('utf8');
    input.on('data', receive);
  }

  return { handle, start };
}

module.exports = {
  INLINE_CARD_RESOURCE,
  INLINE_CARD_TOOL_META,
  INLINE_CARD_URI,
  MCP_PROTOCOL_VERSION,
  REPORT_DESCRIPTION,
  REPORT_INPUT_SCHEMA,
  REPORT_TOOL,
  createMcpServer,
  validateReport,
};
