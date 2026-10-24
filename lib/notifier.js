'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const MAX_RESPONSE_BYTES = 4096;

function makeSignedRequest(body, secret,
  timestamp = Math.floor(Date.now() / 1000), eventId = crypto.randomUUID()) {
  const raw = JSON.stringify(body);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(`${timestamp}\n${eventId}\n${raw}`, 'utf8')
    .digest('hex');
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(raw),
      'user-agent': 'ep_liveblog_webhook/0.1.0',
      'x-wpelb-timestamp': String(timestamp),
      'x-wpelb-event-id': eventId,
      'x-wpelb-signature': signature,
    },
  };
}

/** Deliver an authenticated event. Never follow redirects. */
function postHttps(endpoint, payload, secret, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.username || url.password ||
          url.hash || url.search || url.port) {
        throw new Error('Webhook endpoint must be an HTTPS URL without credentials, port, query or fragment');
      }
    } catch (error) {
      reject(error);
      return;
    }
    const {raw, headers} = makeSignedRequest(payload, secret);
    const req = https.request(url, {method: 'POST', headers, timeout: timeoutMs}, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) req.destroy(new Error('Webhook response too large'));
      });
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          resolve(status);
        } else {
          const error = new Error(`Webhook endpoint returned HTTP ${status}`);
          error.retryable = status === 408 || status === 429 || status >= 500;
          reject(error);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Webhook request timeout')));
    req.on('error', reject);
    req.end(raw);
  });
}

class Notifier {
  constructor({endpoint, origin, secret, padIds, padPrefix,
    quietMs = 1200, followupMs = 7500, maxRetries = 4,
    transport = postHttps, logger = console}) {
    if (typeof origin !== 'string' ||
        !/^https:\/\/[a-z0-9.-]+$/i.test(origin)) {
      throw new Error('origin must be the Etherpad public HTTPS origin');
    }
    let url;
    try { url = new URL(endpoint); } catch (_) {
      throw new Error('endpoint must be an HTTPS WordPress webhook URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.hash || url.search || url.port) {
      throw new Error('endpoint must be an HTTPS WordPress webhook URL');
    }
    if (typeof secret !== 'string' || secret.length < 32) {
      throw new Error('secret must be at least 32 characters');
    }
    const allowed = Array.isArray(padIds) ?
      padIds.filter((x) => typeof x === 'string') : [];
    if (!allowed.length && !(typeof padPrefix === 'string' && padPrefix.length >= 3)) {
      throw new Error('Explicit padIds or a padPrefix (min 3 characters) is required');
    }
    this.config = {
      endpoint, origin, secret, padIds: new Set(allowed), padPrefix,
      quietMs, followupMs, maxRetries,
    };
    this.transport = transport;
    this.logger = logger;
    this.pending = new Map();
    this.closed = false;
  }

  allowed(padId) {
    return this.config.padIds.has(padId) ||
      Boolean(this.config.padPrefix && padId.startsWith(this.config.padPrefix));
  }

  onPadUpdate(padId, revision) {
    if (this.closed || typeof padId !== 'string' || !this.allowed(padId) ||
        !Number.isSafeInteger(revision) || revision < 0) return;

    const existing = this.pending.get(padId) || {
      revision: -1, immediate: null, followup: null,
    };
    existing.revision = Math.max(revision, existing.revision);
    if (existing.immediate) clearTimeout(existing.immediate);
    if (existing.followup) clearTimeout(existing.followup);

    existing.immediate = setTimeout(() => {
      existing.immediate = null;
      void this.deliver(padId, existing.revision).catch(() => {});
    }, this.config.quietMs);

    // A second notification is necessary for the WordPress per-block edit
    // debounce: the first sync records dirty text; the next one publishes it.
    existing.followup = setTimeout(() => {
      existing.followup = null;
      void this.deliver(padId, existing.revision).catch(() => {});
      if (!existing.immediate && !existing.followup) this.pending.delete(padId);
    }, this.config.followupMs);

    this.pending.set(padId, existing);
  }

  async deliver(padId, revision) {
    // Only pad identity and revision are sent; never pad contents.
    const payload = {origin: this.config.origin, pad_id: padId, revision};
    let tries = 0;
    while (!this.closed && tries <= this.config.maxRetries) {
      try {
        await this.transport(this.config.endpoint, payload, this.config.secret);
        return;
      } catch (error) {
        tries++;
        if (error.retryable === false || tries > this.config.maxRetries || this.closed) {
          this.logger.error(`[ep_liveblog_webhook] ${padId}: ${error.message}`);
          throw error;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, Math.min(15000, 1000 * (2 ** (tries - 1))));
        });
      }
    }
  }

  shutdown() {
    this.closed = true;
    for (const state of this.pending.values()) {
      clearTimeout(state.immediate);
      clearTimeout(state.followup);
    }
    this.pending.clear();
  }
}

module.exports = {Notifier, makeSignedRequest, postHttps};
