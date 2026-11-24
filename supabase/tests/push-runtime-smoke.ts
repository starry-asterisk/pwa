// Generate an encrypted request in Deno without making a network request.
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import * as webpush from 'npm:web-push@4.0.0';

const vapid = webpush.generateVAPIDKeys();
const client = createECDH('prime256v1');
client.generateKeys();
const details = webpush.generateRequestDetails({
  endpoint: 'https://fcm.googleapis.com/fcm/send/runtime-smoke-only',
  keys: {
    p256dh: client.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  },
}, JSON.stringify({ title: '테스트', noteId: crypto.randomUUID() }), {
  vapidDetails: { subject: 'mailto:test@example.com', ...vapid },
  TTL: 60,
});
assert.equal(details.method, 'POST');
assert.ok(details.body.length > 0);
assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
assert.ok(details.headers.Authorization.startsWith('vapid '));
console.log('Deno web-push import, VAPID generation and payload encryption passed; no network request made.');
