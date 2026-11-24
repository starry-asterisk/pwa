export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NoteInsert {
  id: string;
  owner_id: string;
  version: string;
  origin_device_id: string;
}

export function readNoteInsert(value: unknown): NoteInsert | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (
    event.type !== "INSERT" || event.schema !== "public" ||
    event.table !== "notes"
  ) return null;
  if (
    !event.record || typeof event.record !== "object" ||
    Array.isArray(event.record)
  ) return null;
  const record = event.record as Record<string, unknown>;
  for (const key of ["id", "owner_id", "version", "origin_device_id"]) {
    if (typeof record[key] !== "string" || !UUID.test(record[key])) return null;
  }
  return {
    id: record.id as string,
    owner_id: record.owner_id as string,
    version: record.version as string,
    origin_device_id: record.origin_device_id as string,
  };
}

// Compare fixed-size SHA-256 digests rather than branching on secret length.
export async function equalSecret(
  actual: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

export interface PushSubscriptionData {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

const DEFAULT_PUSH_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
  "*.notify.windows.com",
];

// Never allow a stored subscription to turn this privileged function into a
// request proxy to arbitrary hosts or private IP addresses.
export function validSubscription(
  value: unknown,
  additionalHosts = "",
): PushSubscriptionData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const subscription = value as Record<string, unknown>;
  if (
    typeof subscription.endpoint !== "string" ||
    subscription.endpoint.length > 2048
  ) return null;
  const keys = subscription.keys as Record<string, unknown> | undefined;
  if (
    !keys || typeof keys !== "object" || Array.isArray(keys) ||
    typeof keys.p256dh !== "string" ||
    !/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(keys.p256dh) ||
    typeof keys.auth !== "string" ||
    !/^[A-Za-z0-9_-]{20,30}={0,2}$/.test(keys.auth)
  ) return null;
  try {
    const endpoint = new URL(subscription.endpoint);
    if (
      endpoint.protocol !== "https:" || endpoint.username ||
      endpoint.password ||
      endpoint.port && endpoint.port !== "443"
    ) return null;
    const host = endpoint.hostname.toLowerCase();
    const hosts = [
      ...DEFAULT_PUSH_HOSTS,
      ...additionalHosts.split(",").map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ];
    if (
      !hosts.some((allowed) =>
        allowed.startsWith("*.")
          ? host.endsWith(allowed.slice(1)) && host !== allowed.slice(2)
          : host === allowed
      )
    ) return null;
    return {
      endpoint: endpoint.href,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    };
  } catch {
    return null;
  }
}
