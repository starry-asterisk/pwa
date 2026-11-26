import assert from "node:assert/strict";
import test from "node:test";
import { createNotifyHandler } from "./handler.ts";

const owner = "10000000-0000-4000-8000-000000000001";
const otherOwner = "10000000-0000-4000-8000-000000000002";
const noteId = "20000000-0000-4000-8000-000000000001";
const sender = "30000000-0000-4000-8000-000000000001";
const receiver = "30000000-0000-4000-8000-000000000002";
const secret = "test-only-webhook-secret-with-at-least-32-characters";
const environment: Record<string, string> = {
  WEBHOOK_SECRET: secret,
  SUPABASE_URL: "https://test-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-only-service-key",
  VAPID_PUBLIC_KEY: "test-public-key",
  VAPID_PRIVATE_KEY: "test-private-key",
  VAPID_SUBJECT: "mailto:test@example.com",
  APP_URL: "https://example.github.io/pwa/",
};

const event = {
  type: "INSERT",
  schema: "public",
  table: "notes",
  record: {
    id: noteId,
    owner_id: owner,
    version: noteId,
    origin_device_id: sender,
  },
};
const subscription = (path = "good") => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${path}`,
  keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
});
let queries: { url: URL; method: string }[] = [];
let sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
let lookupOwner = owner;
let deletedAt: string | null = null;
let previewNote: Record<string, unknown>;
let devices: { device_id: string; subscription: unknown }[] = [];

const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  const method = init?.method || "GET";
  queries.push({ url, method });
  if (method === "DELETE") {
    return Promise.resolve(new Response(null, { status: 204 }));
  }
  if (url.pathname === "/rest/v1/notes") {
    return Promise.resolve(Response.json([
      {
        id: noteId,
        owner_id: lookupOwner,
        data: { ...previewNote, deletedAt },
      },
    ]));
  }
  if (url.pathname === "/rest/v1/push_subscriptions") {
    return Promise.resolve(Response.json(devices));
  }
  throw new Error("Unexpected network destination");
}) as typeof fetch;

const sendNotification = async (
  target: { endpoint: string },
  message: string,
) => {
  if (target.endpoint.endsWith("/dead")) {
    throw Object.assign(new Error("Expired subscription"), { statusCode: 410 });
  }
  sent.push({ endpoint: target.endpoint, payload: JSON.parse(message) });
  return { statusCode: 201 };
};
const handler = createNotifyHandler({
  env: (key) => environment[key],
  fetch: fakeFetch,
  push: { setVapidDetails: () => {}, sendNotification },
});

function reset() {
  queries = [];
  sent = [];
  lookupOwner = owner;
  deletedAt = null;
  previewNote = { title: "  장보기  ", body: "## 준비물\n- **우유**와 [빵](https://example.com/private)" };
  devices = [];
}

function request(payload: unknown = event, webhookSecret = secret) {
  return new Request("https://test-project.supabase.co/functions/v1/notify", {
    method: "POST",
    headers: {
      "x-webhook-secret": webhookSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

test("unauthenticated webhook requests cannot query private data or send pushes", async () => {
  reset();
  assert.equal((await handler(request(event, "wrong-secret"))).status, 401);
  assert.equal(queries.length, 0);
  assert.equal(sent.length, 0);
});

test("edits, foreign tables and malformed owners cannot trigger notifications", async () => {
  reset();
  for (
    const payload of [
      { ...event, type: "UPDATE" },
      { ...event, table: "push_subscriptions" },
      {
        ...event,
        record: { ...event.record, owner_id: `${owner}&owner_id=not.null` },
      },
    ]
  ) assert.equal((await handler(request(payload))).status, 400);
  assert.equal(queries.length, 0);
});

test("notifications use the verified owner's note, exclude the sender and show plain text", async () => {
  reset();
  devices = [{ device_id: receiver, subscription: subscription() }];
  const result = await handler(request({
    ...event,
    record: { ...event.record, data: { title: "untrusted title", body: "untrusted body" } },
  }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { sent: 1, removed: 0, failed: 0 });
  const noteQuery =
    queries.find(({ url }) => url.pathname.endsWith("/notes"))!.url;
  assert.equal(noteQuery.searchParams.get("owner_id"), `eq.${owner}`);
  assert.equal(noteQuery.searchParams.get("id"), `eq.${noteId}`);
  const deviceQuery =
    queries.find(({ url }) => url.pathname.endsWith("/push_subscriptions"))!
      .url;
  assert.equal(deviceQuery.searchParams.get("owner_id"), `eq.${owner}`);
  assert.equal(deviceQuery.searchParams.get("device_id"), `neq.${sender}`);
  assert.equal(sent[0].payload.noteId, noteId);
  assert.equal(
    new URL(sent[0].payload.url as string).searchParams.get("note"),
    noteId,
  );
  assert.equal(sent[0].payload.ownerId, owner);
  assert.equal(sent[0].payload.projectUrl, "https://test-project.supabase.co");
  assert.equal(sent[0].payload.title, "장보기");
  assert.equal(sent[0].payload.body, "준비물 우유와 빵");
  assert.ok(!JSON.stringify(sent[0].payload).includes("untrusted"));
  assert.ok(!JSON.stringify(sent[0].payload).includes("/private"));
});


test("attachment-only notifications identify media without file names or URLs", async () => {
  reset();
  devices = [{ device_id: receiver, subscription: subscription() }];
  previewNote = {
    title: "   ",
    body: "",
    attachments: [
      { mime: "image/webp", name: "private-first.webp" },
      { mime: "image/webp", name: "private-second.webp" },
      { mime: "video/mp4", name: "private-recording.mp4" },
      { mime: "application/octet-stream", name: "private-unknown" },
    ],
  };
  assert.equal((await handler(request())).status, 200);
  assert.equal(sent[0].payload.title, "새 메모");
  assert.equal(sent[0].payload.body, "📷 사진 2장 · 🎬 녹화 1개");
  assert.ok(!JSON.stringify(sent[0].payload).includes("private-"));
});

test("untitled text and title-only notes both have usable previews", async () => {
  reset();
  devices = [{ device_id: receiver, subscription: subscription() }];
  previewNote = { title: "\n ", body: "다음 주에 확인할 일" };
  assert.equal((await handler(request())).status, 200);
  assert.equal(sent[0].payload.title, "새 메모");
  assert.equal(sent[0].payload.body, "다음 주에 확인할 일");

  previewNote = { title: "이번 주 계획", body: " \r\n \t" };
  assert.equal((await handler(request())).status, 200);
  assert.equal(sent[1].payload.title, "이번 주 계획");
  assert.equal(sent[1].payload.body, "다른 기기에 새 메모를 저장했어요.");
});

test("notifications bound long multi-codepoint Unicode previews", async () => {
  reset();
  devices = [{ device_id: receiver, subscription: subscription() }];
  const emoji = "👩🏽‍💻";
  previewNote = { title: emoji.repeat(2_000), body: "한글".repeat(40_000) };
  assert.equal((await handler(request())).status, 200);
  const { title, body } = sent[0].payload;
  assert.equal(title, emoji.repeat(12) + "…");
  assert.equal(body, "한글".repeat(55) + "…");
  assert.ok(new TextEncoder().encode(JSON.stringify(sent[0].payload)).length < 1_500);
});

test("a mismatched database owner or deleted note prevents delivery", async () => {
  reset();
  devices = [{ device_id: receiver, subscription: subscription() }];
  lookupOwner = otherOwner;
  assert.deepEqual(await (await handler(request())).json(), {
    sent: 0,
    skipped: true,
  });
  assert.equal(sent.length, 0);
  lookupOwner = owner;
  deletedAt = "2026-11-24T00:00:00.000Z";
  assert.deepEqual(await (await handler(request())).json(), {
    sent: 0,
    skipped: true,
  });
  assert.equal(sent.length, 0);
});

test("dead endpoint cleanup matches its owner, device and exact old endpoint", async () => {
  reset();
  devices = [{ device_id: receiver, subscription: subscription("dead") }];
  assert.deepEqual(await (await handler(request())).json(), {
    sent: 0,
    removed: 1,
    failed: 0,
  });
  const cleanup = queries.find(({ method }) => method === "DELETE")!.url;
  assert.equal(cleanup.searchParams.get("owner_id"), `eq.${owner}`);
  assert.equal(cleanup.searchParams.get("device_id"), `eq.${receiver}`);
  assert.equal(
    cleanup.searchParams.get("subscription->>endpoint"),
    `eq.${subscription("dead").endpoint}`,
  );
});

test("untrusted push hosts are skipped and duplicate endpoints are sent once", async () => {
  reset();
  devices = [
    { device_id: receiver, subscription: subscription() },
    { device_id: receiver, subscription: subscription() },
    {
      device_id: receiver,
      subscription: {
        ...subscription(),
        endpoint: "https://169.254.169.254/private",
      },
    },
  ];
  assert.deepEqual(await (await handler(request())).json(), {
    sent: 1,
    removed: 0,
    failed: 0,
  });
  assert.equal(sent.length, 1);
});
