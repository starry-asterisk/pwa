import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { disablePush, enablePush, preparePush, verifyPushRegistration, type PushEnrollmentStage } from './notifications'
import { hasPushRegistration, removePushSubscription, savePushSubscription } from './cloud'
import { getDeviceId } from './db'

vi.mock('./cloud', () => ({ hasPushRegistration: vi.fn(), savePushSubscription: vi.fn(), removePushSubscription: vi.fn() }))
vi.mock('./db', () => ({ getDeviceId: vi.fn() }))

const owner = 'aeb29c47-589c-47d5-aa2b-f32c30fd83b1'
const device = '03ada6d8-d9fc-4983-81c6-cf53a6eb744b'
const client = {} as SupabaseClient
const key = btoa(String.fromCharCode(4, ...Array<number>(64).fill(1))).replace(/=+$/, '')
let permission: NotificationPermission
let requestPermission: ReturnType<typeof vi.fn>
let subscription: PushSubscription
let registration: ServiceWorkerRegistration
let getRegistration: ReturnType<typeof vi.fn>
let subscribe: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  permission = 'granted'
  requestPermission = vi.fn().mockResolvedValue('granted')
  subscription = { endpoint: 'https://push.example.test/current-device', unsubscribe: vi.fn().mockResolvedValue(true) } as unknown as PushSubscription
  subscribe = vi.fn().mockResolvedValue(subscription)
  registration = { active: {}, pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription), subscribe } } as unknown as ServiceWorkerRegistration
  getRegistration = vi.fn().mockResolvedValue(registration)
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration, ready: new Promise(() => {}) }, userAgent: 'test-browser' })
  const notification = { get permission() { return permission }, requestPermission }
  vi.stubGlobal('Notification', notification)
  vi.stubGlobal('window', { PushManager: {}, Notification: notification })
  vi.mocked(getDeviceId).mockResolvedValue(device)
  vi.mocked(hasPushRegistration).mockResolvedValue(true)
  vi.mocked(savePushSubscription).mockResolvedValue()
  vi.mocked(removePushSubscription).mockResolvedValue()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('push enrollment', () => {
  it('requires an active in-scope worker and never waits for serviceWorker.ready', async () => {
    getRegistration.mockResolvedValue({ ...registration, active: null })
    await expect(preparePush()).rejects.toThrow('알림 준비가 아직 완료되지')
    await expect(enablePush(client, key)).rejects.toThrow('알림 준비가 아직 완료되지')
    expect(savePushSubscription).not.toHaveBeenCalled()
  })

  it.each(['default', 'granted'] as const)('calls subscribe directly in the click with %s permission, then confirms the server', async initialPermission => {
    permission = initialPermission
    const stages: PushEnrollmentStage[] = []
    const enrollment = enablePush(client, key, { prepared: { registration, subscription: null }, expectedOwnerId: owner, onStage: stage => stages.push(stage) })
    // This assertion precedes any await: activation cannot depend on a read or a separate permission promise.
    expect(subscribe).toHaveBeenCalledOnce()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(getRegistration).not.toHaveBeenCalled()
    await enrollment
    expect(stages).toEqual(['permission', 'browser', 'server', 'verify'])
    expect(savePushSubscription).toHaveBeenCalledWith(client, subscription, device, 'test-browser', owner)
    expect(hasPushRegistration).toHaveBeenCalledWith(client, device, subscription.endpoint, owner)
  })

  it('classifies denied permission separately from a browser subscribe failure, with no server write', async () => {
    subscribe.mockRejectedValueOnce(new DOMException('private-browser-detail', 'NotAllowedError'))
    await expect(enablePush(client, key, { prepared: { registration, subscription: null } })).rejects.toMatchObject({ stage: 'permission' })
    subscribe.mockRejectedValueOnce(new Error('private-browser-detail'))
    await expect(enablePush(client, key, { prepared: { registration, subscription: null } })).rejects.toMatchObject({ stage: 'browser' })
    expect(savePushSubscription).not.toHaveBeenCalled()
  })

  it('does not report success for a failed server save or missing readback', async () => {
    vi.mocked(savePushSubscription).mockRejectedValueOnce(new Error('private-server-detail'))
    await expect(enablePush(client, key, { prepared: { registration, subscription } })).rejects.toMatchObject({ stage: 'server' })
    expect(hasPushRegistration).not.toHaveBeenCalled()
    vi.mocked(hasPushRegistration).mockResolvedValueOnce(false)
    await expect(enablePush(client, key, { prepared: { registration, subscription } })).rejects.toMatchObject({ stage: 'verify' })
  })

  it('bounds a stalled registration lookup and does not issue a server write', async () => {
    vi.useFakeTimers()
    getRegistration.mockReturnValue(new Promise(() => {}))
    const check = expect(preparePush()).rejects.toThrow('알림 준비가 아직 완료되지')
    await vi.advanceTimersByTimeAsync(4001)
    await check
    expect(savePushSubscription).not.toHaveBeenCalled()
  })

  it('keeps a pending mutation locked across modal lifetimes without an uncancelled POST timeout', async () => {
    vi.useFakeTimers()
    let finishSave!: () => void
    vi.mocked(savePushSubscription).mockReturnValueOnce(new Promise(resolve => { finishSave = resolve }))
    const enrollment = enablePush(client, key, { prepared: { registration, subscription }, expectedOwnerId: owner })
    await vi.advanceTimersByTimeAsync(16000)
    expect(hasPushRegistration).not.toHaveBeenCalled()
    await expect(disablePush(client, owner)).rejects.toThrow('다른 알림 설정 변경')
    await expect(enablePush(client, key, { prepared: { registration, subscription } })).rejects.toThrow('다른 알림 설정 변경')
    finishSave()
    await enrollment
    await disablePush(client, owner)
    expect(removePushSubscription).toHaveBeenCalledWith(client, device, owner)
    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
  })

  it('rejects a stale device identity and prevents browser unsubscribe when owner-guarded removal fails', async () => {
    vi.mocked(getDeviceId).mockResolvedValueOnce(device).mockResolvedValueOnce('changed-device')
    await expect(verifyPushRegistration(client, subscription, owner)).rejects.toThrow('서버 등록을 확인하지 못했습니다')
    vi.mocked(removePushSubscription).mockRejectedValueOnce(new Error('로그인 계정이 변경되었습니다.'))
    await expect(disablePush(client, owner)).rejects.toThrow('로그인 계정이 변경')
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
  })
})
