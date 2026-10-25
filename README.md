# ep_liveblog_webhook

Server-side Etherpad plugin for signed change notifications to the
[WP Etherpad to Liveblog](https://github.com/lstamellos/WP-etherpad-to-liveblog) WordPress plugin.

## Design

On the documented Etherpad `padUpdate` hook, the plugin sends a small HTTPS
POST with `origin`, `pad_id` and `revision`; **it never sends pad text**.
HMAC-SHA256 authenticates each request using these headers:

- `X-WPELB-Timestamp` (UNIX seconds)
- `X-WPELB-Event-ID` (random UUID)
- `X-WPELB-Signature` (`sha256=` + HMAC-SHA256 of `timestamp + "\\n" + eventId + "\\n" + raw request body`)

Only explicitly configured `padIds` or a `padPrefix` generate notifications.
The plugin debounces burst edits for 1.2 seconds and sends a second notification
7.5 seconds after the last edit, for the WordPress published-entry correction
debounce.

Webhook notifications are just **triggers**. WordPress continues to retrieve the
publicly readable Etherpad TXT and native revision exports **without any Etherpad
API credentials**. The WordPress post mapping and its existing single-flight
publication lock select the target Liveblog.

The WordPress plugin is independent of any specific publisher, domain or hosting
provider. Its [setup guide](https://github.com/lstamellos/WP-etherpad-to-liveblog#install-and-connect-a-pad)
explains how to connect pads from external Etherpad installations.

An independent system cron job is needed for guaranteed catch-up: notifications
are retried on transient errors, but are not persisted across Etherpad restarts.
Third-party Etherpad instances work without this plugin through the same cron.

## Installation

From the Etherpad root, clone this repository to a stable local path and install
it using Etherpad's own plugin manager:

```bash
git clone https://github.com/lstamellos/ep_liveblog_webhook.git /PATH/TO/ep_liveblog_webhook
cd /PATH/TO/ETHERPAD
pnpm run plugins i --path /PATH/TO/ep_liveblog_webhook
```

Restart Etherpad through its **existing** process-management setup. Never run
`npm install` in the Etherpad core directory.

### WordPress configuration

Install WP Etherpad to Liveblog **v0.4.0 or later**. Generate one random secret:

```bash
openssl rand -hex 32
```

In `wp-config.php`, before including WordPress:

```php
define('WPELB_WEBHOOK_SECRET', 'INSERT_RANDOM_SECRET_HERE');
```

### Etherpad configuration

Add this property to your existing `settings.json` (do **not** replace the file):

```json
{
  "ep_liveblog_webhook": {
    "enabled": true,
    "origin": "https://pad.example.org",
    "endpoint": "https://news.example.com/wp-json/wpelb/v1/notify",
    "padIds": ["YOUR_TEST_PAD_ID"]
  }
}
```

Provide the **same secret** to the Etherpad process with an environment variable
`EP_LIVEBLOG_WEBHOOK_SECRET`. Do not expose it to pad editors or commit it
to GitHub. A `secret` setting is supported if environment injection is unavailable
and the configuration file is adequately protected. For a group of purpose-built
pads, use `"padPrefix": "liveblog-"` instead of `padIds`.

Replace **both** example domains with the actual public HTTPS origins of your
Etherpad and WordPress installations. The configured `origin` must match the
pad's connection record in WordPress; the `endpoint` must be an HTTPS URL of
the WordPress site that runs WP Etherpad to Liveblog.

The WordPress endpoint uses HMAC, so incoming machine requests do not require a
WordPress user session. Valid signatures are restricted to a five-minute window.
Server clocks should be synchronized via NTP.

If a firewall or WAF challenges the POST, create a narrowly scoped exception on
**your WordPress hostname** for the Etherpad server egress IP, HTTP method `POST`,
and exact path `/wp-json/wpelb/v1/notify`. Keep other security mechanisms enabled.
This is different from any rule allowing your WordPress server to read the
public Etherpad export routes.

## Independent recovery cron (WordPress server)

Configure the **OS cron** through Virtualmin or crontab to run every minute
under the WordPress installation's correct OS user:

```cron
* * * * * /usr/bin/flock -n /PATH/TO/PRIVATE_DIR/wp-etherpad-liveblog.lock /PATH/TO/WP-CLI --path=/PATH/TO/WORDPRESS etherpad-liveblog run --once
```

Replace all paths with the actual server paths. Keep the lock file inside a
directory owned by the execution account. Test the command once manually before
enabling the schedule. The WP-Cron and Liveblog-reader polling triggers from
the WordPress plugin may remain active; they use the same publication lock.

## Verification

```bash
npm test
npm run check
```

End-to-end verification must cover a new `POSTOK`, correction of a published
entry, simultaneous visits to the Liveblog, and a webhook outage/recovery
through system cron, including a test with no Liveblog browser open.

## Notes

- Failed webhooks may be lost during restarts; cron is the recovery guarantee.
- Webhook HTTP 202 means the request was accepted, not that publication committed.
- Liveblog publication never occurs inside the Etherpad process.
- No systemd service is needed for the WordPress side; regular OS cron is sufficient.
- Rich text and unusually large public Etherpad archives remain limited by the
  WordPress plugin.
- This repository is licensed under GPL-3.0-only.
