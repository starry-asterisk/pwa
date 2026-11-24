import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LocalOwner } from '../lib/offline-owner'
import { Bell, Check, Cloud, Download, HardDrive, LogOut, Mail, RefreshCw, Save, ShieldCheck, Upload, X } from 'lucide-react'
import type { CloudConfig } from '../types'
import { db, formatBytes, requestDurableStorage } from '../lib/db'
import { exportBackup, importBackup } from '../lib/backup'
import { sendMagicLink } from '../lib/cloud'
import { disablePush, enablePush, preparePush, supportsPush, verifyPushRegistration, type PushEnrollmentStage, type PushPreparation } from '../lib/notifications'

interface Props {
  config: CloudConfig
  client: SupabaseClient | null
  user: LocalOwner | null
  authenticated: boolean
  onSignOut: () => Promise<void>
  onSaveConfig: (config: CloudConfig | null) => Promise<void>
  onClose: () => void
  notify: (message: string) => void
  onSync: () => Promise<void>
  onAdopt: () => Promise<void>
  syncing: boolean
}

type Tab = 'general' | 'sync' | 'notifications'
const tabs = [
  { id: 'general' as const, label: '일반', icon: HardDrive },
  { id: 'sync' as const, label: '동기화', icon: Cloud },
  { id: 'notifications' as const, label: '알림', icon: Bell },
]
type PushServerStatus = 'unknown' | 'checking' | 'registered' | 'missing' | 'unavailable' | 'error'
interface PushContext { client: SupabaseClient | null; ownerId: string | null; authenticated: boolean; online: boolean }
const pushStageLabels: Record<PushEnrollmentStage, string> = {
  permission: '알림 권한 확인 중…', browser: '브라우저 알림 준비 중…',
  server: '서버에 기기 등록 중…', verify: '서버 등록 확인 중…',
}

export default function SettingsDialog({ config, client, user, authenticated, onSignOut, onSaveConfig, onClose, notify, onSync, onAdopt, syncing }: Props) {
  const dialogId = useId()
  const dialog = useRef<HTMLElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const [tab, setTab] = useState<Tab>('general')
  const [draft, setDraft] = useState(config)
  const [vapidKey, setVapidKey] = useState(config.vapidPublicKey)
  const [email, setEmail] = useState('')
  const [mailSent, setMailSent] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [persistent, setPersistent] = useState(false)
  const [localPush, setLocalPush] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [pushChecking, setPushChecking] = useState(false)
  const [pushStage, setPushStage] = useState<PushEnrollmentStage | null>(null)
  const [pushError, setPushError] = useState('')
  const pushErrorSource = useRef<'prepare' | 'verify' | 'mutation' | null>(null)
  const [pushServer, setPushServer] = useState<{ client: SupabaseClient | null; ownerId: string | null; status: PushServerStatus }>({ client: null, ownerId: null, status: 'unknown' })
  const preparedPush = useRef<PushPreparation | null>(null)
  const pushSequence = useRef(0)
  const pushAlive = useRef(true)
  const pushJob = useRef<symbol | null>(null)
  const refreshPush = useRef<(clearError?: boolean) => Promise<void>>(async () => {})
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const pushSupported = supportsPush()
  const occupied = busy !== null
  const ownerId = user?.id ?? null
  const pushContext = useRef<PushContext>({ client, ownerId, authenticated, online })
  pushContext.current = { client, ownerId, authenticated, online }
  const pushServerStatus = pushServer.client === client && pushServer.ownerId === ownerId ? pushServer.status : 'unknown'
  const pushRegistered = pushServerStatus === 'registered' && localPush && permission === 'granted' && authenticated && online
  const stats = useLiveQuery(() => db.transaction('r', db.notes, db.images, async () => {
    const notes = await db.notes.filter(note => note.cloudOwnerId === null
      || ownerId !== null && note.cloudOwnerId === ownerId).toArray()
    const imageIds = [...new Set(notes.flatMap(note => note.attachments.map(image => image.id)))]
    const images = (await db.images.bulkGet(imageIds)).filter(image => image !== undefined)
    return { notes: notes.filter(note => !note.deletedAt).length,
      images: images.length, imageBytes: images.reduce((sum, image) => sum + image.blob.size, 0) }
  }), [ownerId])

  useEffect(() => { setDraft(config); setVapidKey(config.vapidPublicKey) }, [config])

  useEffect(() => {
    pushAlive.current = true
    void navigator.storage?.persisted?.().then(value => { if (pushAlive.current) setPersistent(value) }).catch(() => {})
    return () => { pushAlive.current = false; pushSequence.current++ }
  }, [])

  function samePushContext(context: PushContext): boolean {
    const current = pushContext.current
    return pushAlive.current && current.client === context.client && current.ownerId === context.ownerId
      && current.authenticated === context.authenticated && current.online === context.online
  }

  useEffect(() => {
    let active = true
    setPushError('')
    pushErrorSource.current = null
    const refresh = async (clearError = false) => {
      // Permission dialogs can refocus the page during enrollment; leave that operation in control.
      if (pushJob.current) return
      const sequence = ++pushSequence.current
      const context = pushContext.current
      const current = () => active && sequence === pushSequence.current && samePushContext(context)
      const setStatus = (status: PushServerStatus) => setPushServer({ client: context.client, ownerId: context.ownerId, status })
      if (clearError) { setPushError(''); pushErrorSource.current = null }
      if (typeof Notification !== 'undefined') setPermission(Notification.permission)
      setPushChecking(true)
      preparedPush.current = null
      let phase: 'prepare' | 'verify' = 'prepare'
      try {
        const prepared = await preparePush()
        if (!current()) return
        preparedPush.current = prepared
        setLocalPush(Boolean(prepared.subscription))
        if (pushErrorSource.current === 'prepare') { setPushError(''); pushErrorSource.current = null }
        if (!pushSupported || !context.client || !context.ownerId || !context.authenticated || !context.online || !navigator.onLine) {
          setStatus('unavailable')
        } else if (!prepared.subscription) {
          setStatus('missing')
        } else {
          setStatus('checking')
          phase = 'verify'
          const registered = await verifyPushRegistration(context.client, prepared.subscription, context.ownerId)
          if (!current()) return
          setStatus(registered ? 'registered' : 'missing')
          if (registered) { setPushError(''); pushErrorSource.current = null }
        }
      } catch (error) {
        if (!current()) return
        setStatus('error')
        if (pushErrorSource.current !== 'mutation') {
          pushErrorSource.current = phase
          setPushError(error instanceof Error ? error.message : '알림 등록을 확인하지 못했습니다. 다시 시도해 주세요.')
        }
      } finally { if (current()) setPushChecking(false) }
    }
    refreshPush.current = refresh
    const updateOnline = () => setOnline(navigator.onLine)
    const onFocus = () => { updateOnline(); void refresh() }
    const onWorkerChange = () => { void refresh() }
    const subscription = client?.auth.onAuthStateChange(() => { queueMicrotask(() => { if (active) void refresh() }) }).data.subscription
    void refresh()
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)
    navigator.serviceWorker?.addEventListener('controllerchange', onWorkerChange)
    return () => {
      active = false
      pushSequence.current++
      subscription?.unsubscribe()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
      navigator.serviceWorker?.removeEventListener('controllerchange', onWorkerChange)
    }
  }, [client, ownerId, authenticated, online, pushSupported])

  function changePush(enable: boolean) {
    const context = pushContext.current
    if (occupied || pushJob.current || !context.client || !context.ownerId || !context.authenticated || !context.online || !navigator.onLine) return
    const prepared = preparedPush.current
    if (enable && !prepared?.registration?.active) {
      pushErrorSource.current = 'prepare'
      setPushError('앱의 알림 준비를 다시 확인한 뒤 등록해 주세요.')
      return
    }
    const job = Symbol('push-change')
    pushJob.current = job
    pushSequence.current++
    setPushChecking(false)
    setPushError('')
    pushErrorSource.current = null
    setBusy(enable ? 'push-enable' : 'push-disable')
    const current = () => pushJob.current === job && samePushContext(context)
    // Do not await preparation here: subscribe/requestPermission must begin in this click.
    const operation = enable ? enablePush(context.client, config.vapidPublicKey, {
      prepared: prepared ?? undefined,
      expectedOwnerId: context.ownerId,
      onStage: stage => { if (current()) setPushStage(stage) },
    }) : disablePush(context.client, context.ownerId)
    void operation.then(() => {
      if (!current()) return
      setLocalPush(enable)
      setPushServer({ client: context.client, ownerId: context.ownerId, status: enable ? 'registered' : 'missing' })
      notify(enable ? '서버 등록을 확인했습니다. 이 기기로 새 메모 알림을 받습니다.' : '이 기기의 알림을 껐습니다.')
    }).catch((error: unknown) => {
      if (!current()) return
      const message = error instanceof Error ? error.message : '알림 설정을 변경하지 못했습니다. 다시 시도해 주세요.'
      setPushServer({ client: context.client, ownerId: context.ownerId, status: 'error' })
      pushErrorSource.current = 'mutation'
      setPushError(message)
      notify(message)
    }).finally(() => {
      if (pushJob.current !== job) return
      pushJob.current = null
      if (!pushAlive.current) return
      setBusy(null)
      setPushStage(null)
      if (typeof Notification !== 'undefined') setPermission(Notification.permission)
      void refreshPush.current()
    })
  }

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.querySelector<HTMLButtonElement>('[data-dialog-close]')?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab' || !dialog.current) return
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],summary,[tabindex="0"]',
      )].filter(element => element.getClientRects().length > 0 && element.tabIndex >= 0)
      if (!focusable.length) { event.preventDefault(); dialog.current.focus(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); previous?.focus() }
  }, [])

  async function run(name: string, action: () => Promise<unknown>, success?: string) {
    if (occupied) return
    setBusy(name)
    try {
      await action()
      if (success) notify(success)
    } catch (error) {
      notify(error instanceof Error ? error.message : '작업을 완료하지 못했습니다. 다시 시도해 주세요.')
    } finally {
      setBusy(null)
      if (typeof Notification !== 'undefined') setPermission(Notification.permission)
    }
  }

  function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run('config', () => onSaveConfig(draft), '동기화 연결 정보를 저장했습니다.')
  }

  const permissionLabel = permission === 'unsupported' ? '이 브라우저에서 지원하지 않음'
    : permission === 'denied' ? '브라우저에서 차단됨'
      : permission === 'granted' ? '알림 권한 허용됨' : '아직 알림을 허용하지 않음'
  const pushStatusLabel = pushServerStatus === 'registered' ? '서버 등록 완료'
    : pushChecking || pushServerStatus === 'checking' ? '서버 확인 중…'
      : pushServerStatus === 'missing' ? '서버 미등록' : '서버 확인 필요'

  return <div className="modal-backdrop settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby={`${dialogId}-title`} ref={dialog} tabIndex={-1}>
      <header className="settings-header">
        <div><h2 id={`${dialogId}-title`}>설정</h2><p>이 기기의 저장과 연결을 관리하세요.</p></div>
        <button type="button" className="icon-button" aria-label="설정 닫기" data-dialog-close onClick={onClose}><X size={20} /></button>
      </header>

      <nav className="settings-tabs" role="tablist" aria-label="설정 항목">
        {tabs.map(({ id, label, icon: Icon }, index) => <button key={id} type="button" role="tab"
          className={tab === id ? 'active' : ''} id={`${dialogId}-tab-${id}`} aria-selected={tab === id}
          aria-controls={`${dialogId}-panel-${id}`} tabIndex={tab === id ? 0 : -1}
          onClick={() => setTab(id)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
            if (next >= 0) { event.preventDefault(); setTab(tabs[next].id); document.getElementById(`${dialogId}-tab-${tabs[next].id}`)?.focus() }
          }}><Icon size={17} aria-hidden="true" />{label}</button>)}
      </nav>

      <div className="settings-content">
        <div className="settings-panel" role="tabpanel" id={`${dialogId}-panel-${tab}`} aria-labelledby={`${dialogId}-tab-${tab}`}>
          {tab === 'general' && <>
            <section className="settings-section">
              <div className="settings-section-heading"><h3>이 기기의 보관함</h3><span className="settings-status">로컬 저장</span></div>
              <p className="settings-help">작성한 내용은 이 기기에 먼저 저장됩니다.</p>
              <div className="settings-storage-grid">
                <div className="storage-stat"><strong>{stats ? stats.notes.toLocaleString() : '…'}</strong><span>메모</span></div>
                <div className="storage-stat"><strong>{stats ? stats.images.toLocaleString() : '…'}</strong><span>이미지</span></div>
                <div className="storage-stat"><strong>{stats ? formatBytes(stats.imageBytes) : '…'}</strong><span>이미지 용량</span></div>
              </div>
            </section>
            <section className="settings-section">
              <h3>백업과 가져오기</h3>
              <p className="settings-help">현재 계정과 로컬 전용 메모를 이미지와 함께 ZIP 파일로 보관하세요. 현재 백업 파일은 50MB까지 지원합니다.</p>
              <div className="settings-actions">
                <button type="button" className="button secondary" disabled={occupied} onClick={() => { void run('export', () => exportBackup(ownerId), '백업 파일을 내려받았습니다.') }}>
                  <Download size={16} />{busy === 'export' ? '백업 만드는 중…' : '백업 내보내기'}</button>
                <button type="button" className="button secondary" disabled={occupied} onClick={() => fileInput.current?.click()}>
                  <Upload size={16} />{busy === 'import' ? '가져오는 중…' : '백업 가져오기'}</button>
                <input ref={fileInput} type="file" accept=".zip,application/zip" hidden aria-label="백업 ZIP 파일" onChange={event => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void run('import', async () => {
                    const result = await importBackup(file)
                    notify(`메모 ${result.notes.toLocaleString()}개와 이미지 ${result.images.toLocaleString()}장을 이 기기에 가져왔습니다.`)
                  })
                }} />
              </div>
              <p className="settings-help">가져온 메모는 새 메모로 추가됩니다. 동기화 탭에서 이 기기의 메모를 계정에 연결할 수 있습니다.</p>
            </section>
            <section className="settings-section">
              <h3>안심하고 보관하기</h3>
              <p className="settings-help">브라우저가 저장공간을 정리할 때 메모를 보호하도록 요청할 수 있습니다. 중요한 기록은 백업도 함께 보관하세요.</p>
              <button type="button" className="button secondary" disabled={occupied || persistent} onClick={() => {
                void run('persist', async () => {
                  const allowed = await requestDurableStorage()
                  setPersistent(allowed)
                  notify(allowed ? '저장공간 보호가 허용되었습니다.' : '이 브라우저에서는 저장공간 보호를 보장할 수 없습니다. 백업을 함께 사용해 주세요.')
                })
              }}>{persistent ? <Check size={16} /> : <ShieldCheck size={16} />}{persistent ? '저장공간 보호 허용됨' : '저장공간 보호 요청'}</button>
            </section>
            <section className="settings-section">
              <h3>앱으로 설치하기</h3>
              <p className="settings-help">휴대폰에서는 브라우저 메뉴의 ‘홈 화면에 추가’를, PC에서는 주소창의 설치 버튼을 이용하세요. 설치 후에는 인터넷 연결이 없어도 메모할 수 있습니다.</p>
            </section>
          </>}

          {tab === 'sync' && <>
            <section className="settings-section">
              <div className="settings-section-heading"><h3>내 기기끼리 연결</h3><span className={`settings-status${authenticated ? ' connected' : ''}`}>{user ? authenticated ? '계정 연결됨' : '오프라인 보관함' : client ? '로그인 대기' : '로컬 전용'}</span></div>
              <p className="settings-help">같은 계정으로 로그인하면 휴대폰과 PC의 메모를 함께 사용할 수 있습니다.</p>
              {client && user ? <>
                <div className="settings-account"><Mail size={19} /><div><strong>{user.email || '로그인한 계정'}</strong><span>이 계정의 메모만 동기화합니다.</span></div></div>
                {!authenticated && <p className="settings-help">이 기기에 보관된 메모를 사용하고 있습니다. 인터넷에 연결해 로그인을 확인하면 동기화와 알림을 사용할 수 있습니다.</p>}
                <div className="settings-actions">
                  <button type="button" className="button primary" disabled={occupied || syncing || !authenticated} onClick={() => { void run('sync', onSync) }}>
                    <RefreshCw size={16} className={syncing ? 'spinning' : ''} />{syncing || busy === 'sync' ? '동기화 중…' : '지금 동기화'}</button>
                  <button type="button" className="button secondary" disabled={occupied || syncing || !authenticated} onClick={() => { void run('adopt', onAdopt) }}><Cloud size={16} />이 기기의 로컬 메모도 연결</button>
                </div>
                <p className="settings-help">로컬 전용 메모와 가져온 백업은 위 버튼을 눌러 계정에 연결하세요.</p>
                <button type="button" className="button ghost" disabled={occupied || syncing} onClick={() => { void run('logout', onSignOut, '이 기기에서 로그아웃했습니다.') }}><LogOut size={16} />로그아웃</button>
              </> : client ? <form className="settings-inline-form" onSubmit={event => {
                event.preventDefault()
                void run('login', async () => { await sendMagicLink(client, email); setMailSent(true) }, '로그인 링크를 보냈습니다. 메일을 확인해 주세요.')
              }}>
                <label className="settings-field"><span>이메일 주소</span><input type="email" autoComplete="email" value={email} required placeholder="you@example.com" disabled={occupied} onChange={event => { setEmail(event.target.value); setMailSent(false) }} /></label>
                <button type="submit" className="button primary" disabled={occupied}><Mail size={16} />{busy === 'login' ? '보내는 중…' : '로그인 링크 보내기'}</button>
                {mailSent && <p className="settings-callout" role="status">메일의 로그인 링크를 이 기기에서 열어 주세요.</p>}
              </form> : <div className="settings-callout">아래에서 연결 정보를 저장하면 이메일로 로그인할 수 있습니다.</div>}
            </section>
            <section className="settings-section">
              <h3>연결 설정</h3>
              <p className="settings-help">준비한 프로젝트의 공개 연결 정보를 입력하세요. 이 기기에 저장됩니다.</p>
              <form onSubmit={saveConfig}>
                <label className="settings-field"><span>프로젝트 주소</span><input type="url" autoComplete="off" spellCheck={false} value={draft.url} required placeholder="https://your-project.supabase.co" disabled={occupied || syncing} onChange={event => setDraft({ ...draft, url: event.target.value })} /></label>
                <label className="settings-field"><span>공개 연결 키</span><input type="password" autoComplete="off" spellCheck={false} value={draft.anonKey} required placeholder="프로젝트의 공개 키" disabled={occupied || syncing} onChange={event => setDraft({ ...draft, anonKey: event.target.value })} /></label>
                <div className="settings-actions">
                  <button type="submit" className="button primary" disabled={occupied || syncing}><Save size={16} />{busy === 'config' ? '저장 중…' : '연결 정보 저장'}</button>
                  {client && <button type="button" className="button ghost" disabled={occupied || syncing} onClick={() => { void run('disconnect', () => onSaveConfig(null), '연결을 해제했습니다. 메모는 이 기기에 보관됩니다.') }}>연결 해제</button>}
                </div>
              </form>
            </section>
          </>}

          {tab === 'notifications' && <>
            <section className="settings-section">
              <div className="settings-section-heading"><h3>다른 기기의 새 메모 알림</h3><span className={`settings-status${pushRegistered ? ' connected' : ''}`} role="status">{pushStatusLabel}</span></div>
              <p className="settings-help">다른 기기에서 새 메모를 만들면 이 기기로 알려드립니다.</p>
              <div className="settings-callout"><Bell size={18} /><span>{permissionLabel}</span></div>
              <p className="settings-help">{localPush ? '이 브라우저에 알림 구독이 있습니다.' : '이 브라우저에 알림 구독이 없습니다.'} 서버 등록이 완료되어야 새 메모 알림을 받을 수 있습니다.</p>
              {(!authenticated || !online) && <p className="settings-help">온라인에서 로그인을 확인한 뒤 서버 등록을 확인하고 알림을 켤 수 있습니다.</p>}
              {pushError && <p className="settings-callout" role="alert">{pushError}</p>}
              {pushStage && <p className="settings-help" role="status">{pushStageLabels[pushStage]}</p>}
              <div className="settings-actions">
                <button type="button" className="button primary" disabled={occupied || pushChecking || !client || !user || !authenticated || !online || !pushSupported || !preparedPush.current?.registration?.active || !config.vapidPublicKey.trim() || permission === 'denied' || pushRegistered}
                  onClick={() => changePush(true)}><Bell size={16} />{busy === 'push-enable' ? '알림 등록 중…' : localPush ? '서버에 다시 등록' : '이 기기에서 알림 켜기'}</button>
                <button type="button" className="button secondary" disabled={occupied || pushChecking || !client || !user || !authenticated || !online || !pushSupported || !localPush}
                  onClick={() => changePush(false)}>알림 끄기</button>
                <button type="button" className="button secondary" disabled={occupied || pushChecking || !client || !user || !authenticated || !online || !pushSupported}
                  onClick={() => { void refreshPush.current(true) }}><RefreshCw size={16} className={pushChecking ? 'spinning' : ''} />{pushChecking ? '등록 확인 중…' : '등록 다시 확인'}</button>
              </div>
              <p className="settings-help">iPhone·iPad에서는 홈 화면에 추가한 앱에서 알림을 켜 주세요. 차단된 알림 권한은 브라우저 설정에서 변경할 수 있습니다.</p>
            </section>
            <section className="settings-section">
              <details className="settings-advanced" open={!config.vapidPublicKey.trim()}>
                <summary>알림 연결 설정</summary>
                <p className="settings-help">알림 발송을 준비할 때 생성한 VAPID 공개 키를 입력하세요.</p>
                <form onSubmit={event => {
                  event.preventDefault()
                  void run('vapid', () => onSaveConfig({ ...config, vapidPublicKey: vapidKey }), '알림 연결 정보를 저장했습니다.')
                }}>
                  <label className="settings-field"><span>VAPID 공개 키</span><input type="text" autoComplete="off" spellCheck={false} value={vapidKey} disabled={occupied} onChange={event => setVapidKey(event.target.value)} /></label>
                  <button type="submit" className="button secondary" disabled={occupied || !client}><Save size={16} />공개 키 저장</button>
                </form>
              </details>
            </section>
          </>}
        </div>
      </div>
    </section>
  </div>
}
