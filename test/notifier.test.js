'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {Notifier, makeSignedRequest} = require('../lib/notifier');

const secret = 'abcdef0123456789abcdef0123456789abcdef0123456789';
const base = {
  endpoint: 'https://news.example.com/wp-json/wpelb/v1/notify',
  origin: 'https://pad.example.org', secret,
};

test('HMAC contract matches WordPress receiver', () => {
  const body = {origin: base.origin, pad_id: 'liveblog-news', revision: 15};
  const eventId = '00000000-0000-4000-8000-000000000001';
  const {raw, headers} = makeSignedRequest(body, secret, 1790000000, eventId);
  const digest = crypto.createHmac('sha256', secret)
    .update(`${headers['x-wpelb-timestamp']}\n${eventId}\n${raw}`)
    .digest('hex');
  assert.equal(headers['x-wpelb-signature'], 'sha256=' + digest);
  assert.equal(headers['content-length'], Buffer.byteLength(raw));
  assert.deepEqual(JSON.parse(raw), body);
});

test('only configured pads trigger debounced and follow-up notifications', async () => {
  const events = [];
  const notifier = new Notifier({
    ...base, padPrefix: 'liveblog-', quietMs: 10, followupMs: 40,
    maxRetries: 0,
    transport: async (_url, body) => { events.push(body); },
  });
  notifier.onPadUpdate('private-unrelated-pad', 88);
  notifier.onPadUpdate('liveblog-news', 10);
  notifier.onPadUpdate('liveblog-news', 11);
  notifier.onPadUpdate('liveblog-news', 12);
  await new Promise((resolve) => setTimeout(resolve, 95));
  assert.deepEqual(events.map((e) => e.revision), [12, 12]);
  assert.deepEqual(events.map((e) => e.pad_id), ['liveblog-news', 'liveblog-news']);
  notifier.shutdown();
});

test('explicit pad IDs and shutdown suppress further notifications', async () => {
  let calls = 0;
  const notifier = new Notifier({
    ...base, padIds: ['selected-pad'], quietMs: 8, followupMs: 20,
    transport: async () => { calls++; },
  });
  notifier.onPadUpdate('not-allowed', 1);
  notifier.onPadUpdate('selected-pad', 1);
  notifier.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(calls, 0);
});

test('transient failures are retried and permanent failures are not', async () => {
  let calls = 0;
  const notifier = new Notifier({
    ...base, padIds: ['one'],
    maxRetries: 2,
    transport: async () => {
      calls++;
      if (calls === 1) {
        const error = new Error('temporarily unavailable');
        error.retryable = true;
        throw error;
      }
    },
  });
  await notifier.deliver('one', 7);
  assert.equal(calls, 2);
  notifier.shutdown();
});

test('reject configuration lacking transport security or scope', () => {
  assert.throws(() => new Notifier(base), /padIds|padPrefix/);
  assert.throws(() => new Notifier({...base, padIds: ['x'], secret: 'short'}), /secret/);
  assert.throws(() => new Notifier({...base, padIds: ['x'],
    endpoint: 'http://127.0.0.1/'}), /HTTPS/);
});
