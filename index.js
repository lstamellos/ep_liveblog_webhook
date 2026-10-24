'use strict';

const {Notifier} = require('./lib/notifier');
let notifier = null;

// The Etherpad core invokes loadSettings with the server-side settings object.
exports.loadSettings = (_hookName, context) => {
  notifier?.shutdown();
  notifier = null;
  const config = context?.settings?.ep_liveblog_webhook || {};
  if (config.enabled !== true) return;

  try {
    notifier = new Notifier({
      endpoint: config.endpoint || process.env.EP_LIVEBLOG_WEBHOOK_ENDPOINT,
      origin: config.origin || process.env.EP_LIVEBLOG_WEBHOOK_ORIGIN,
      secret: process.env.EP_LIVEBLOG_WEBHOOK_SECRET || config.secret,
      padIds: config.padIds,
      padPrefix: config.padPrefix,
      quietMs: 1200,
      // Recheck after the WordPress 5-second published-entry edit debounce.
      followupMs: 7500,
    });
  } catch (err) {
    console.error(`[ep_liveblog_webhook] Disabled due to invalid configuration: ${err.message}`);
  }
};

// Never block a pad save on outbound HTTPS delivery.
exports.padUpdate = (_hookName, context) => {
  if (!notifier) return;
  const padId = context?.pad?.id || context?.padId;
  const revision = context?.revs ?? context?.pad?.head;
  notifier.onPadUpdate(padId, revision);
};

exports.shutdown = async () => {
  notifier?.shutdown();
  notifier = null;
};
