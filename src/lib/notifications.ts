import type { SupabaseClient } from '@supabase/supabase-js'
import { getDeviceId } from './db'
import { removePushSubscription, savePushSubscription } from './cloud'
function applicationKey(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=').replace(/-/g, '+').replace(/_/g, '/')
  const decoded = atob(padded)
  return Uint8Array.from(decoded, character => character.charCodeAt(0))
}
export function supportsPush(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}
export async function enablePush(client: SupabaseClient, publicKey: string): Promise<void> {
  if (!supportsPush()) throw new Error('이 브라우저에서는 알림을 사용할 수 없습니다. iPhone에서는 홈 화면에 추가한 앱에서 열어 주세요.')
  if (!publicKey.trim()) throw new Error('알림 서버를 설정한 뒤 VAPID 공개 키를 입력해 주세요.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('브라우저 설정에서 알림 권한을 허용해 주세요.')
  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(publicKey.trim()) })
  await savePushSubscription(client, subscription, await getDeviceId(), navigator.userAgent.slice(0, 100))
}
export async function disablePush(client: SupabaseClient): Promise<void> {
  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.getSubscription()
  await removePushSubscription(client, await getDeviceId())
  await subscription?.unsubscribe()
}