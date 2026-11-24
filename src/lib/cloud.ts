import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { CloudConfig } from '../types'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function validateCloudConfig(config: CloudConfig): CloudConfig {
  let url: URL
  try {
    url = new URL(config.url.trim())
  } catch {
    throw new Error('올바른 Supabase 프로젝트 URL을 입력해 주세요.')
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Supabase 프로젝트의 HTTPS URL을 입력해 주세요.')
  }

  const key = config.anonKey.trim()
  if (key.startsWith('sb_secret_')) {
    throw new Error('Secret 키는 앱에 사용할 수 없습니다. Publishable 또는 anon 키를 입력해 주세요.')
  }
  if (!key.startsWith('sb_publishable_')) {
    try {
      const parts = key.split('.')
      if (parts.length !== 3) throw new Error('invalid key')
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const claims: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')))
      if (!claims || typeof claims !== 'object' || !('role' in claims) || claims.role !== 'anon') throw new Error('invalid role')
    } catch {
      throw new Error('Publishable 또는 anon 공개 키를 입력해 주세요. service_role 키는 사용할 수 없습니다.')
    }
  }
  if (key === 'sb_publishable_') throw new Error('Supabase 공개 키를 입력해 주세요.')

  return { url: url.origin, anonKey: key, vapidPublicKey: config.vapidPublicKey.trim() }
}

export function createCloudClient(config: CloudConfig): SupabaseClient {
  const valid = validateCloudConfig(config)
  return createClient(valid.url, valid.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
}

export async function sendMagicLink(client: SupabaseClient, email: string, redirectTo?: string): Promise<void> {
  const cleanEmail = email.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error('올바른 이메일 주소를 입력해 주세요.')
  const fallback = typeof window === 'undefined' ? undefined : `${window.location.origin}${window.location.pathname}`
  const { error } = await client.auth.signInWithOtp({
    email: cleanEmail,
    options: { emailRedirectTo: redirectTo ?? fallback },
  })
  if (error) throw new Error(`로그인 메일을 보내지 못했습니다: ${error.message}`)
}

export async function signOutCloud(client: SupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut({ scope: 'local' })
  if (error) throw new Error(`로그아웃하지 못했습니다: ${error.message}`)
}

async function authenticatedOwner(client: SupabaseClient, expectedOwnerId?: string): Promise<string> {
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new Error('로그인한 뒤 다시 시도해 주세요.')
  if (expectedOwnerId !== undefined && data.user.id !== expectedOwnerId) {
    throw new Error('로그인 계정이 변경되었습니다. 현재 계정에서 다시 시도해 주세요.')
  }
  return data.user.id
}

async function confirmOwner(client: SupabaseClient, ownerId: string): Promise<void> {
  const { data, error } = await client.auth.getSession()
  if (error || data.session?.user.id !== ownerId) {
    throw new Error('로그인 계정이 변경되었습니다. 현재 계정에서 다시 시도해 주세요.')
  }
}

function validPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' && !url.username && !url.password && endpoint === endpoint.trim()
  } catch { return false }
}

/** Read only this owner's device endpoint; subscription encryption keys are not fetched. */
export async function hasPushRegistration(
  client: SupabaseClient,
  deviceId: string,
  endpoint: string,
  expectedOwnerId?: string,
): Promise<boolean> {
  if (!uuidPattern.test(deviceId) || !validPushEndpoint(endpoint)) throw new Error('알림 구독 정보가 올바르지 않습니다.')
  const ownerId = await authenticatedOwner(client, expectedOwnerId)
  const { data, error } = await client.from('push_subscriptions')
    .select('endpoint:subscription->>endpoint').eq('owner_id', ownerId).eq('device_id', deviceId).maybeSingle()
  if (error) throw new Error('서버의 알림 등록을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.')
  await confirmOwner(client, ownerId)
  return data?.endpoint === endpoint
}

export async function savePushSubscription(
  client: SupabaseClient,
  subscription: PushSubscription | PushSubscriptionJSON,
  deviceId: string,
  label = '',
  expectedOwnerId?: string,
): Promise<void> {
  if (!uuidPattern.test(deviceId)) throw new Error('기기 식별자가 올바르지 않습니다.')
  const ownerId = await authenticatedOwner(client, expectedOwnerId)
  const value = 'toJSON' in subscription ? subscription.toJSON() : subscription
  if (!validPushEndpoint(value.endpoint) || !value.keys?.p256dh || !value.keys.auth) {
    throw new Error('알림 구독 정보가 올바르지 않습니다.')
  }
  const { error } = await client.from('push_subscriptions').upsert({
    owner_id: ownerId,
    device_id: deviceId,
    label: label.trim().slice(0, 100),
    subscription: value,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'owner_id,device_id' })
  if (error) throw new Error('서버에 알림 기기를 등록하지 못했습니다. 로그인과 연결을 확인한 뒤 다시 시도해 주세요.')
  await confirmOwner(client, ownerId)
}

export async function removePushSubscription(client: SupabaseClient, deviceId: string, expectedOwnerId?: string): Promise<void> {
  if (!uuidPattern.test(deviceId)) throw new Error('기기 식별자가 올바르지 않습니다.')
  const ownerId = await authenticatedOwner(client, expectedOwnerId)
  const { error } = await client.from('push_subscriptions').delete().eq('owner_id', ownerId).eq('device_id', deviceId)
  if (error) throw new Error('서버의 알림 등록을 해제하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.')
  await confirmOwner(client, ownerId)
}

/** Realtime is an invalidation signal; syncNotes retrieves authoritative data. */
export function subscribeToNoteChanges(client: SupabaseClient, ownerId: string, onChange: () => void): () => void {
  if (!uuidPattern.test(ownerId)) throw new Error('계정 식별자가 올바르지 않습니다.')
  const channel = client.channel(`notes:${ownerId}:${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notes', filter: `owner_id=eq.${ownerId}` }, onChange)
    .subscribe()
  return () => { void client.removeChannel(channel) }
}
