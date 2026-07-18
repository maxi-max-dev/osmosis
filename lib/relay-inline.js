'use strict';

/**
 * Keep the MCP Apps renderer pointed at the HTTP-owning broker when this
 * process is a port-loser. If the owner is restarting or its loopback request
 * fails, return this process's own hydrated channel instead of making a
 * conversation iframe fail. The fallback is intentionally quiet: an inline
 * card must never interrupt the coding agent over a transient wall outage.
 */
function createRelayInlineCardResolver({
  broker,
  fetchImpl = globalThis.fetch,
  getBaseUrl,
  getDelivery = () => 'primary',
  getRelayIdentity = () => null,
  timeoutMs = 2_000,
} = {}) {
  if (!broker || typeof broker.inlineCardHtml !== 'function') {
    throw new TypeError('createRelayInlineCardResolver needs a broker inline-card renderer.');
  }
  if (typeof getBaseUrl !== 'function') {
    throw new TypeError('createRelayInlineCardResolver needs a primary base URL function.');
  }

  function timeoutSignal() {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  }

  return async function inlineCardHtml(projectId) {
    const targetProjectId = projectId || getRelayIdentity()?.project_id || broker.defaultProjectId;
    if (getDelivery() === 'relay' && targetProjectId && typeof fetchImpl === 'function') {
      try {
        const response = await fetchImpl(
          `${getBaseUrl()}/inline-card?project=${encodeURIComponent(targetProjectId)}`,
          { cache: 'no-store', signal: timeoutSignal() },
        );
        if (response?.ok) {
          const html = await response.text();
          if (typeof html === 'string') {
            return html;
          }
        }
      } catch {
        // Fall through to the local channel below.
      }
    }
    return broker.inlineCardHtml(targetProjectId);
  };
}

module.exports = { createRelayInlineCardResolver };
