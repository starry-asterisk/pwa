import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasPushRegistration, removePushSubscription, savePushSubscription } from './cloud'

const owner = 'aeb29c47-589c-47d5-aa2b-f32c30fd83b1'
const otherOwner = '192f9f29-1d3d-4ac8-a4f1-d649b0b8b22a'
const device = '03ada6d8-d9fc-4983-81c6-cf53a6eb744b'
const endpoint = 'https://push.example.test/current-device'
const subscription = { endpoint, keys: { auth: 'test-auth', p256dh: 'test-public-key' } }

function fakeClient(options: { ownerId?: string; sessionOwnerId?: string; row?: { endpoint: string } | null; error?: unknown } = {}) {
  const query = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.row ?? null, error: options.error ?? null }),
    upsert: vi.fn().mockResolvedValue({ error: options.error ?? null }),
    then(resolve: (value: unknown) => unknown) { return Promise.resolve({ error: options.error ?? null }).then(resolve) },
  }
  const from = vi.fn().mockReturnValue(query)
  const getUser = vi.fn().mockResolvedValue({ data: { user: { id: options.ownerId ?? owner } }, error: null })
  const getSession = vi.fn().mockResolvedValue({ data: { session: { user: { id: options.sessionOwnerId ?? options.ownerId ?? owner } } }, error: null })
  return { client: { from, auth: { getUser, getSession } } as unknown as SupabaseClient, query, from, getSession }
}

describe('owner-scoped push registration', () => {
  it('confirms only a matching endpoint for the authenticated owner and device, without reading keys', async () => {
    const { client, query, from } = fakeClient({ row: { endpoint } })
    expect(await hasPushRegistration(client, device, endpoint, owner)).toBe(true)
    expect(from).toHaveBeenCalledWith('push_subscriptions')
    expect(query.select).toHaveBeenCalledWith('endpoint:subscription->>endpoint')
    expect(query.eq.mock.calls).toEqual([['owner_id', owner], ['device_id', device]])
  })

  it('distinguishes a missing or replaced server subscription from a verified registration', async () => {
    expect(await hasPushRegistration(fakeClient().client, device, endpoint, owner)).toBe(false)
    expect(await hasPushRegistration(fakeClient({ row: { endpoint: `${endpoint}-old` } }).client, device, endpoint, owner)).toBe(false)
  })

  it('does not treat a failed server query as an unregistered device or expose the error payload', async () => {
    const { client } = fakeClient({ error: { message: 'private-response-body' } })
    await expect(hasPushRegistration(client, device, endpoint, owner)).rejects.toThrow('서버의 알림 등록을 확인하지 못했습니다')
    await expect(hasPushRegistration(client, device, endpoint, owner)).rejects.not.toThrow('private-response-body')
  })

  it('discards a successful lookup when the login changed while it was in flight', async () => {
    const { client } = fakeClient({ row: { endpoint }, sessionOwnerId: otherOwner })
    await expect(hasPushRegistration(client, device, endpoint, owner)).rejects.toThrow('로그인 계정이 변경')
  })

  it('never saves, deletes, or queries a different account after the caller captured its owner', async () => {
    const { client, from } = fakeClient({ ownerId: otherOwner })
    await expect(savePushSubscription(client, subscription, device, '', owner)).rejects.toThrow('로그인 계정이 변경')
    await expect(removePushSubscription(client, device, owner)).rejects.toThrow('로그인 계정이 변경')
    await expect(hasPushRegistration(client, device, endpoint, owner)).rejects.toThrow('로그인 계정이 변경')
    expect(from).not.toHaveBeenCalled()
  })

  it('upserts and removes the current owner/device only', async () => {
    const { client, query } = fakeClient()
    await savePushSubscription(client, subscription, device, ' browser ', owner)
    expect(query.upsert).toHaveBeenCalledWith(expect.objectContaining({
      owner_id: owner, device_id: device, subscription, label: 'browser',
    }), { onConflict: 'owner_id,device_id' })
    await removePushSubscription(client, device, owner)
    expect(query.eq.mock.calls).toEqual([['owner_id', owner], ['device_id', device]])
  })

  it('validates identifiers and HTTPS endpoints before a query and hides write error details', async () => {
    const invalid = fakeClient()
    await expect(hasPushRegistration(invalid.client, 'bad-id', endpoint, owner)).rejects.toThrow('올바르지')
    await expect(savePushSubscription(invalid.client, { ...subscription, endpoint: 'http://example.test' }, device, '', owner)).rejects.toThrow('올바르지')
    expect(invalid.from).not.toHaveBeenCalled()
    const failed = fakeClient({ error: { message: 'private-response-body' } })
    await expect(savePushSubscription(failed.client, subscription, device, '', owner)).rejects.not.toThrow('private-response-body')
    await expect(removePushSubscription(failed.client, device, owner)).rejects.not.toThrow('private-response-body')
  })
})
