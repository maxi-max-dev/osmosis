'use strict';

function formatEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

class SseHub {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(': heartbeat\n\n');
        } catch {
          this.clients.delete(client);
        }
      }
    }, 15_000);
    this.heartbeat.unref();
  }

  connect(request, response, initialEvents) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders?.();
    const events = Array.isArray(initialEvents)
      ? initialEvents
      : [{ type: 'snapshot', payload: initialEvents }];
    for (const event of events) {
      if (event && typeof event.type === 'string') {
        response.write(formatEvent(event.type, event.payload));
      }
    }
    this.clients.add(response);
    request.once('close', () => this.clients.delete(response));
  }

  broadcast(type, payload) {
    const message = formatEvent(type, payload);
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }
}

module.exports = { SseHub };
