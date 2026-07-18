'use strict';

function log(...parts) {
  // stdout belongs exclusively to the MCP JSON-RPC transport.
  console.error('[osmosis]', ...parts);
}

module.exports = { log };
