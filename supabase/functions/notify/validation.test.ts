import assert from "node:assert/strict";
import test from "node:test";
import {
  equalSecret,
  readNoteInsert,
  validSubscription,
} from "./validation.ts";

const one = "aeb29c47-589c-47d5-aa2b-f32c30fd83b1";
const two = "aeb29c47-589c-47d5-aa2b-f32c30fd83b2";
const event = {
  type: "INSERT",
  schema: "public",
  table: "notes",
  record: { id: one, owner_id: two, version: one, origin_device_id: two },
};
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/example",
  keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
};

test("only a complete notes insertion is accepted as a notification event", () => {
  assert.equal(readNoteInsert(event)?.owner_id, two);
  for (
    const invalid of [
      null,
      [],
      "text",
      { ...event, type: "UPDATE" },
      { ...event, schema: "storage" },
      { ...event, table: "push_subscriptions" },
      { ...event, record: {} },
      {
        ...event,
        record: { ...event.record, owner_id: `${two}&owner_id=not.null` },
      },
    ]
  ) assert.equal(readNoteInsert(invalid), null);
});

test("secret verification checks exact UTF-8 input, including different lengths", async () => {
  assert.equal(await equalSecret("a".repeat(64), "a".repeat(64)), true);
  assert.equal(await equalSecret("a".repeat(63), "a".repeat(64)), false);
  assert.equal(await equalSecret("a".repeat(63) + "b", "a".repeat(64)), false);
  assert.equal(await equalSecret("", "a".repeat(64)), false);
});

test("push destinations cannot target arbitrary or private hosts", () => {
  assert.equal(
    validSubscription(subscription)?.endpoint,
    subscription.endpoint,
  );
  assert.ok(
    validSubscription({
      ...subscription,
      endpoint: "https://wns1.notify.windows.com/w/?token=abc",
    }),
  );
  for (
    const endpoint of [
      "http://fcm.googleapis.com/fcm/send/a",
      "https://127.0.0.1/a",
      "https://169.254.169.254/latest/meta-data/",
      "https://fcm.googleapis.com.attacker.example/a",
      "https://attacker.example/fcm.googleapis.com",
      "https://user:pass@fcm.googleapis.com/a",
      "https://fcm.googleapis.com:8443/a",
      "https://notify.windows.com.attacker.example/a",
    ]
  ) {
    assert.equal(
      validSubscription({ ...subscription, endpoint }),
      null,
      endpoint,
    );
  }
  assert.equal(validSubscription({ ...subscription, keys: {} }), null);
});

test("a separately configured trusted host may be enabled without broadening other hosts", () => {
  assert.ok(
    validSubscription({
      ...subscription,
      endpoint: "https://push.example.test/a",
    }, "push.example.test"),
  );
  assert.equal(
    validSubscription({
      ...subscription,
      endpoint: "https://evil.push.example.test/a",
    }, "push.example.test"),
    null,
  );
});
