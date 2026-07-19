'use strict';

const { renderInlineCard } = require('./inline-card');

/**
 * Keep the MCP Apps renderer pointed at the HTTP-owning broker when this
 * process is a port-loser. A loser intentionally has no broker or local
 * state: falling back to one would hydrate a channel and resume generation
 * from every competing MCP process. During an owner outage it returns a calm
 * reconnecting surface instead.
 */
function createRelayInlineCardResolver({
  getBroker = () => null,
  fetchImpl = globalThis.fetch,
  getBaseUrl,
  getDelivery = () => 'primary',
  getRelayIdentity = () => null,
  timeoutMs = 2_000,
} = {}) {
  if (typeof getBroker !== 'function') {
    throw new TypeError('createRelayInlineCardResolver needs a broker getter.');
  }
  if (typeof getBaseUrl !== 'function') {
    throw new TypeError('createRelayInlineCardResolver needs a primary base URL function.');
  }

  function timeoutSignal() {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  }

  function reconnectingCard(projectId) {
    const query = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
    return renderInlineCard({
      refreshUrl: `${getBaseUrl()}/inline-card${query}`,
      state: {},
    });
  }

  return async function inlineCardHtml(projectId) {
    const delivery = getDelivery();
    const broker = getBroker();
    if (delivery === 'primary') {
      if (broker && typeof broker.inlineCardHtml === 'function') {
        return broker.inlineCardHtml(projectId || broker.defaultProjectId);
      }
      return reconnectingCard(projectId);
    }

    // Relay mode trusts only the capability identity from the owner's
    // registration handshake. It never looks up a default channel locally.
    const targetProjectId = projectId || getRelayIdentity()?.project_id || null;
    if (delivery === 'relay' && targetProjectId && typeof fetchImpl === 'function') {
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
        // The owner may be handshaking after a takeover. The static pending
        // card is deliberately the only local fallback.
      }
    }
    return reconnectingCard(targetProjectId);
  };
}

module.exports = { createRelayInlineCardResolver };
