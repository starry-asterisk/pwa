import { useEffect, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Bell, Check } from 'lucide-react'
import { enablePush, preparePush, supportsPush, verifyPushRegistration, type PushEnrollmentStage, type PushPreparation } from '../lib/notifications'
import './LoginPushPrompt.css'

interface Props {
  client: SupabaseClient
  projectUrl: string
  ownerId: string
  sessionId: string
  publicKey: string
  workerReady: boolean
}

const stageLabels: Record<PushEnrollmentStage, string> = {
  permission: '알림 권한 확인 중…',
  browser: '이 기기의 알림 구독 준비 중…',
  server: '서버에 이 기기 등록 중…',
  verify: '서버 등록 확인 중…',
}

export default function LoginPushPrompt({ client, projectUrl, ownerId, sessionId, publicKey, workerReady }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const handled = useRef(false)
  const operation = useRef(false)
  const [offer, setOffer] = useState<PushPreparation | null>(null)
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const [stage, setStage] = useState<PushEnrollmentStage | null>(null)
  const [registered, setRegistered] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!publicKey.trim() || !supportsPush()) return
    const key = `moa:push-prompt:${projectUrl}`
    const wasHandled = () => {
      if (handled.current) return true
      try { return localStorage.getItem(key) === sessionId } catch { return false }
    }
    let active = true
    let checking = false
    const check = async () => {
      if (wasHandled() || checking) return
      checking = true
      try {
        const preparation = await preparePush()
        const browserPermission = Notification.permission
        const isRegistered = browserPermission === 'granted' && preparation.subscription
          ? await verifyPushRegistration(client, preparation.subscription, ownerId)
          : false
        if (!active || wasHandled()) return
        handled.current = true
        try { localStorage.setItem(key, sessionId) } catch { /* Keep the decision in memory if storage is unavailable. */ }
        if (!isRegistered) {
          setPermission(browserPermission)
          setOffer(preparation)
        }
      } catch {
        // A failed server lookup does not establish that notifications are off.
      } finally { checking = false }
    }
    const onFocus = () => { setPermission(Notification.permission); void check() }
    void check()
    window.addEventListener('focus', onFocus)
    return () => { active = false; window.removeEventListener('focus', onFocus) }
  }, [client, projectUrl, ownerId, sessionId, publicKey, workerReady])

  const visible = offer !== null
  useEffect(() => {
    const element = dialog.current
    if (visible && element && !element.open) element.showModal()
    return () => { if (element?.open) element.close() }
  }, [visible])

  async function register() {
    if (!offer || operation.current) return
    operation.current = true
    setError('')
    setStage('permission')
    try {
      await enablePush(client, publicKey, {
        prepared: offer.registration?.active ? offer : undefined,
        expectedOwnerId: ownerId,
        onStage: setStage,
      })
      setRegistered(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '알림을 등록하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      operation.current = false
      setStage(null)
      setPermission(Notification.permission)
    }
  }

  if (!visible) return null

  return <dialog className="login-push-dialog" aria-labelledby="login-push-title" aria-describedby="login-push-description" ref={dialog}
    onCancel={event => { event.preventDefault(); if (!operation.current) setOffer(null) }}>
    <div className="login-push-icon" aria-hidden="true">{registered ? <Check size={24} /> : <Bell size={24} />}</div>
    <h2 id="login-push-title">{registered ? '새 메모 알림이 켜졌어요' : '새 메모 알림을 받을까요?'}</h2>
    <p id="login-push-description">{registered ? '이 기기의 서버 등록을 확인했어요.' : '다른 기기에서 새 메모를 저장하면 제목과 내용 일부를 이 기기에 알려드려요.'}</p>
    {registered && <span className="settings-status connected" role="status">서버 등록 완료</span>}
    {stage && <p className="login-push-progress" role="status">{stageLabels[stage]}</p>}
    {error && <p className="login-push-error" role="alert">{error}</p>}
    {!registered && permission === 'denied' && <p className="login-push-error">브라우저의 사이트 설정에서 알림을 허용한 뒤 다시 시도해 주세요.</p>}
    <div className="login-push-actions">
      <button type="button" className={`button ${registered || permission === 'denied' ? 'primary' : 'secondary'}`} disabled={stage !== null} onClick={() => setOffer(null)}>{registered || permission === 'denied' ? '확인' : '나중에'}</button>
      {!registered && permission !== 'denied' && <button type="button" className="button primary" disabled={stage !== null} onClick={() => void register()}>이 기기에서 알림 켜기</button>}
    </div>
  </dialog>
}
