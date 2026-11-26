import {
  equalSecret,
  type PushSubscriptionData,
  readNoteInsert,
  UUID,
  validSubscription,
} from "./validation.ts";

interface DeviceSubscription {
  device_id: string;
  subscription: unknown;
}

interface NotePreviewData {
  deletedAt?: string | null;
  title?: unknown;
  body?: unknown;
  attachments?: unknown;
}

const previewSegments = new Intl.Segmenter("ko", { granularity: "grapheme" });
const previewEncoder = new TextEncoder();

function plainLine(value: string): string {
  return value
    .replace(/[\p{Cc}\u202A-\u202E\u2066-\u2069]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clipPreview(value: string, limit: number): string {
  let result = "";
  let count = 0;
  let bytes = 0;
  for (const { segment } of previewSegments.segment(value)) {
    bytes += previewEncoder.encode(segment).length;
    if (count === limit || bytes > limit * 4) {
      return result ? result.trimEnd() + "…" : "";
    }
    result += segment;
    count++;
  }
  return result;
}

function notificationPreview(note: NotePreviewData) {
  const title = typeof note.title === "string" ? plainLine(note.title) : "";
  const body = typeof note.body === "string"
    ? plainLine(
      note.body.trimStart().slice(0, 3_000)
        .replace(/\r\n?/g, "\n")
        .replace(/^[ \t]*(?:\x60{3,}|~{3,})[^\n]*$/gm, "")
        .replace(/^[ \t]*(?:#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, "")
        .replace(/!?\[([^\]\n]*)\]\([^\n)]*\)/g, "$1")
        .replace(/(\*\*|__|~~|\x60)([^\n]+?)\1/g, "$2"),
    )
    : "";
  let photos = 0;
  let recordings = 0;
  if (Array.isArray(note.attachments)) {
    for (const attachment of note.attachments) {
      if (attachment?.mime === "image/webp") photos++;
      if (attachment?.mime === "video/mp4") recordings++;
    }
  }
  const parts = [
    photos ? "📷 사진 " + photos + "장" : "",
    recordings ? "🎬 녹화 " + recordings + "개" : "",
    clipPreview(body, photos || recordings ? 72 : 110),
  ];
  return {
    title: clipPreview(title, 46) || "새 메모",
    body: parts.filter(Boolean).join(" · ") || "다른 기기에 새 메모를 저장했어요.",
  };
}

const MAX_BODY_BYTES = 1_600_000;
const response = (status: number, value: Record<string, unknown>) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

interface NotificationDependencies {
  env: (key: string) => string | undefined;
  fetch: typeof globalThis.fetch;
  push: {
    setVapidDetails: (
      subject: string,
      publicKey: string,
      privateKey: string,
    ) => void;
    sendNotification: (
      subscription: PushSubscriptionData,
      message: string,
      options: { TTL: number; urgency: "normal"; timeout: number },
    ) => Promise<unknown>;
  };
}

export function createNotifyHandler(
  { env, fetch, push }: NotificationDependencies,
) {
  return async (request: Request) => {
    if (request.method !== "POST") {
      return response(405, { error: "Method not allowed" });
    }
    const secret = env("WEBHOOK_SECRET") || "";
    if (secret.length < 32) {
      return response(503, { error: "Notification service is not configured" });
    }
    const suppliedSecret = request.headers.get("x-webhook-secret") || "";
    if (
      suppliedSecret.length > 1024 || !await equalSecret(suppliedSecret, secret)
    ) {
      return response(401, { error: "Unauthorized" });
    }
    if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
      return response(413, { error: "Payload too large" });
    }

    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
        return response(413, { error: "Payload too large" });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return response(400, { error: "Invalid JSON" });
      }
      const event = readNoteInsert(payload);
      if (!event) {
        return response(400, { error: "Expected a public.notes INSERT event" });
      }

      const supabaseUrl = env("SUPABASE_URL") || "";
      const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY") || "";
      const vapidPublic = env("VAPID_PUBLIC_KEY") || "";
      const vapidPrivate = env("VAPID_PRIVATE_KEY") || "";
      const vapidSubject = env("VAPID_SUBJECT") || "";
      const appUrl = env("APP_URL") || "";
      if (
        !supabaseUrl || !serviceKey || !vapidPublic || !vapidPrivate ||
        !vapidSubject || !appUrl
      ) {
        return response(503, {
          error: "Notification service is not configured",
        });
      }
      const destination = new URL(appUrl);
      if (
        destination.protocol !== "https:" &&
        destination.hostname !== "localhost"
      ) {
        return response(503, { error: "Invalid application URL" });
      }
      destination.searchParams.set("note", event.id);
      const headers = {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
      };
      const restUrl = (table: string, query: Record<string, string>) => {
        const url = new URL(`/rest/v1/${table}`, supabaseUrl);
        for (const [key, value] of Object.entries(query)) {
          url.searchParams.set(key, value);
        }
        return url;
      };

      // Recheck ownership against the database instead of trusting a webhook body
      // to choose arbitrary recipients. Deleted notes do not produce notifications.
      const noteResponse = await fetch(
        restUrl("notes", {
          select: "id,owner_id,data",
          id: `eq.${event.id}`,
          owner_id: `eq.${event.owner_id}`,
          limit: "1",
        }),
        { headers, signal: AbortSignal.timeout(8_000) },
      );
      if (!noteResponse.ok) throw new Error("Note lookup failed");
      const notes = await noteResponse.json() as {
        id: string;
        owner_id: string;
        data: NotePreviewData;
      }[];
      const note = notes[0];
      if (
        !note || note.id !== event.id || note.owner_id !== event.owner_id ||
        !note.data || note.data.deletedAt
      ) {
        return response(200, { sent: 0, skipped: true });
      }

      const subscriptionResponse = await fetch(
        restUrl("push_subscriptions", {
          select: "device_id,subscription",
          owner_id: `eq.${event.owner_id}`,
          device_id: `neq.${event.origin_device_id}`,
          limit: "100",
        }),
        { headers, signal: AbortSignal.timeout(8_000) },
      );
      if (!subscriptionResponse.ok) {
        throw new Error("Subscription lookup failed");
      }
      const subscriptions = await subscriptionResponse
        .json() as DeviceSubscription[];
      push.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
      const seenEndpoints = new Set<string>();
      let sent = 0;
      let removed = 0;
      let failed = 0;
      const message = JSON.stringify({
        ...notificationPreview(note.data),
        ownerId: note.owner_id,
        projectUrl: new URL(supabaseUrl).origin,
        tag: `note-${event.id}`,
        noteId: event.id,
        url: destination.href,
      });

      await Promise.all(subscriptions.map(async (device) => {
        if (!UUID.test(device.device_id)) return;
        const subscription = validSubscription(
          device.subscription,
          env("PUSH_ALLOWED_HOSTS") || "",
        );
        if (!subscription || seenEndpoints.has(subscription.endpoint)) return;
        seenEndpoints.add(subscription.endpoint);
        try {
          await push.sendNotification(subscription, message, {
            TTL: 86_400,
            urgency: "normal",
            timeout: 8_000,
          });
          sent++;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // An endpoint may have been replaced while this request was running;
            // only remove the exact dead subscription we attempted to use.
            const cleanup = await fetch(
              restUrl("push_subscriptions", {
                owner_id: `eq.${event.owner_id}`,
                device_id: `eq.${device.device_id}`,
                "subscription->>endpoint": `eq.${subscription.endpoint}`,
              }),
              { method: "DELETE", headers, signal: AbortSignal.timeout(8_000) },
            );
            if (cleanup.ok) removed++;
            else failed++;
          } else {
            failed++;
          }
        }
      }));
      // Log counts only: endpoints, keys, note bodies and account IDs are private.
      console.info("Notification delivery", { sent, removed, failed });
      return response(200, { sent, removed, failed });
    } catch {
      console.error("Notification delivery failed");
      return response(500, { error: "Notification delivery failed" });
    }
  };
}
