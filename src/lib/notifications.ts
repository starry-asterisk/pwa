import type { SupabaseClient } from '@supabase/supabase-js'
import { getDeviceId } from './db'
import { hasPushRegistration, removePushSubscription, savePushSubscription } from './cloud'

export interface PushPreparation {
  registration: ServiceWorkerRegistration | null
  subscription: PushSubscription | null
}
export type PushEnrollmentStage = 'permission' | 'browser' | 'server' | 'verify'
export interface PushEnrollmentOptions {
  prepared?: PushPreparation
  expectedOwnerId?: string
  onStage?: (stage: PushEnrollmentStage) => void
}

export class PushEnrollmentError extends Error {
  constructor(readonly stage: PushEnrollmentStage, message: string) { super(message); this.name = 'PushEnrollmentError' }
}

const workerError = '앱의 알림 준비가 아직 완료되지 않았습니다. 앱을 새로고침한 뒤 다시 시도해 주세요.'
const browserError = '브라우저에서 알림 구독을 만들지 못했습니다. 알림 권한과 앱 설치 상태를 확인한 뒤 다시 시도해 주세요.'
const serverError = '서버에 이 기기의 알림을 등록하지 못했습니다. 로그인과 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
const verifyError = '브라우저 알림 구독은 있지만 서버 등록을 확인하지 못했습니다. 등록을 다시 시도해 주세요.'

function applicationKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=').replace(/-/g, '+').replace(/_/g, '/')
  const decoded = atob(padded)
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('invalid application key')
  return bytes
}

export function supportsPush(): boolean {
  return typeof navigator !== 'undefined' && typeof window !== 'undefined'
    && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** Only read operations are bounded. A subscription or server write must settle before another mutation. */
async function readWithin<T>(action: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([action, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

/** Prepare before showing an enable button, so subscribe can run in the subsequent native user gesture. */
export async function preparePush(): Promise<PushPreparation> {
  if (!supportsPush()) return { registration: null, subscription: null }
  try {
    const registration = await readWithin(navigator.serviceWorker.getRegistration(), 4000, workerError)
    if (!registration?.active) throw new Error(workerError)
    const subscription = await readWithin(registration.pushManager.getSubscription(), 4000, workerError)
    return { registration, subscription }
  } catch { throw new PushEnrollmentError('browser', workerError) }
}

/** Browser permission and a local subscription alone do not confirm server enrollment. */
export async function verifyPushRegistration(
  client: SupabaseClient,
  subscription: PushSubscription,
  expectedOwnerId?: string,
): Promise<boolean> {
  try {
    const deviceId = await getDeviceId()
    const registered = await readWithin(hasPushRegistration(client, deviceId, subscription.endpoint, expectedOwnerId), 15000, verifyError)
    if (await getDeviceId() !== deviceId) throw new Error('device changed')
    return registered
  } catch { throw new PushEnrollmentError('verify', verifyError) }
}

// Modal/popup lifetimes must not allow a second mutation while the first request can still commit.
let mutationInFlight = false
function mutatePush(action: () => Promise<void>): Promise<void> {
  if (mutationInFlight) return Promise.reject(new Error('다른 알림 설정 변경이 진행 중입니다. 완료된 뒤 다시 시도해 주세요.'))
  mutationInFlight = true
  // Calling the action synchronously preserves the click's user activation for PushManager.subscribe.
  return action().finally(() => { mutationInFlight = false })
}

export function enablePush(client: SupabaseClient, publicKey: string, options: PushEnrollmentOptions = {}): Promise<void> {
  return mutatePush(() => registerPush(client, publicKey, options))
}

async function registerPush(client: SupabaseClient, publicKey: string, options: PushEnrollmentOptions): Promise<void> {
  if (!supportsPush()) throw new PushEnrollmentError('browser', '이 브라우저에서는 알림을 사용할 수 없습니다. iPhone에서는 홈 화면에 추가한 앱에서 열어 주세요.')
  let key: Uint8Array<ArrayBuffer>
  try { key = applicationKey(publicKey.trim()) }
  catch { throw new PushEnrollmentError('browser', '알림 연결 설정의 VAPID 공개 키를 확인해 주세요.') }

  options.onStage?.('permission')
  if (Notification.permission === 'denied') throw new PushEnrollmentError('permission', '브라우저 설정에서 알림 권한을 허용해 주세요.')
  const prepared = options.prepared ?? await preparePush()
  if (!prepared.registration?.active) throw new PushEnrollmentError('browser', workerError)
  // subscribe requests permission itself. Keep a new subscription in the click's activation on WebKit.
  if (prepared.subscription && Notification.permission !== 'granted') {
    let permission: NotificationPermission
    try { permission = await Notification.requestPermission() }
    catch { throw new PushEnrollmentError('permission', '알림 권한을 요청하지 못했습니다. 브라우저 설정을 확인해 주세요.') }
    if (permission !== 'granted') throw new PushEnrollmentError('permission', '브라우저 설정에서 알림 권한을 허용해 주세요.')
  }

  options.onStage?.('browser')
  let subscription = prepared.subscription
  if (!subscription) {
    try {
      subscription = await prepared.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    } catch (error) {
      if ((Notification.permission as NotificationPermission) === 'denied' || error instanceof Error && error.name === 'NotAllowedError') {
        throw new PushEnrollmentError('permission', '알림 권한을 허용한 뒤 다시 시도해 주세요. 차단한 경우 브라우저 설정에서 변경할 수 있습니다.')
      }
      throw new PushEnrollmentError('browser', browserError)
    }
  }

  options.onStage?.('server')
  let deviceId: string
  try {
    deviceId = await getDeviceId()
    await savePushSubscription(client, subscription, deviceId, navigator.userAgent.slice(0, 100), options.expectedOwnerId)
  } catch { throw new PushEnrollmentError('server', serverError) }

  options.onStage?.('verify')
  try {
    if (await getDeviceId() !== deviceId || !await verifyPushRegistration(client, subscription, options.expectedOwnerId)) {
      throw new Error(verifyError)
    }
  } catch { throw new PushEnrollmentError('verify', verifyError) }
}

export function disablePush(client: SupabaseClient, expectedOwnerId?: string): Promise<void> {
  return mutatePush(async () => {
    const { subscription } = await preparePush()
    await removePushSubscription(client, await getDeviceId(), expectedOwnerId)
    if (subscription) {
      try {
        if (!await subscription.unsubscribe()) throw new Error('unsubscribe failed')
      } catch { throw new Error('서버 등록은 해제했지만 브라우저 구독을 정리하지 못했습니다. 알림 상태를 다시 확인해 주세요.') }
    }
  })
}
