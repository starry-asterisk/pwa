import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { registerSW } from 'virtual:pwa-register'
import type { Session, SupabaseClient, User } from '@supabase/supabase-js'
import { Check, CheckCheck, Cloud, CloudOff, Download, FileText, FolderHeart, Hash, Image as ImageIcon, LayoutGrid, ListChecks, LoaderCircle, Menu, Pin, Plus, Search, Settings2, Sparkles, Trash2, Video, WifiOff, X } from 'lucide-react'
import { attachFiles, createNote, db, formatBytes, getSetting, purgeNotes, setSetting, trashNotes, updateNote } from './lib/db'
import { createCloudClient, signOutCloud, subscribeToNoteChanges, validateCloudConfig } from './lib/cloud'
import { clearCachedOwner, readCachedOwner, writeCachedOwner, type LocalOwner } from './lib/offline-owner'
import { adoptLocalNotes, syncNotes } from './lib/sync'
import { optimizeImage } from './lib/media'
import { storeRecording } from './lib/recording'
import { deleteCapture, readCapture, type SharedCapture } from './lib/share-inbox'
import { CaptureFileOpenError, listenForCaptureFiles, receiveCaptureFile } from './lib/capture-handoff'
import { loginSessionId } from './lib/login-session'
import { clearPushPreviewOwner, updatePushPreviewOwner } from './lib/push-preview-owner'
import { useNoteBackNavigation } from './lib/useNoteBackNavigation'
import { useNoteLongPress } from './lib/useNoteLongPress'
import type { CloudConfig, Note, NoteFilter, StoredAttachment, StoredImage } from './types'
import NoteEditor, { type NoteEditorHandle } from './components/NoteEditor'
import SettingsDialog from './components/SettingsDialog'
import ImageView from './components/ImageView'
import LoginPushPrompt from './components/LoginPushPrompt'
import PurgeDialog from './components/PurgeDialog'

const emptyConfig: CloudConfig = { url: '', anonKey: '', vapidPublicKey: '' }
const defaultConfig: CloudConfig = {
  url: import.meta.env.VITE_SUPABASE_URL || '', anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  vapidPublicKey: import.meta.env.VITE_VAPID_PUBLIC_KEY || '',
}
const navigation = [
  { id: 'all', name: '모든 메모', icon: LayoutGrid },
  { id: 'pinned', name: '고정한 메모', icon: Pin },
  { id: 'images', name: '이미지 모아보기', icon: ImageIcon },
  { id: 'trash', name: '휴지통', icon: Trash2 },
] as const
function hasImage(note: Note) { return note.attachments.some(attachment => attachment.mime === 'image/webp') }
function noteTitle(note: Note) { return note.title.trim() || note.body.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || '제목 없는 메모' }
function excerpt(body: string) { return body.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[#>*-]+\s*/gm, '').replace(/[`*_~]/g, '').trim() }
function dateLabel(value: string) {
  const date = new Date(value)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat('ko', { hour: 'numeric', minute: '2-digit' }).format(date)
  return new Intl.DateTimeFormat('ko', { month: 'long', day: 'numeric' }).format(date)
}
interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
interface EditorOperation {
  ownerId: string | null
  isCurrent: () => boolean
}
interface NoteSelection {
  scope: string
  ids: Set<string>
}
interface PurgeRequest {
  ids: string[]
  ownerId: string | null
  editorId: string | null
  cloud: boolean
}

export default function App() {
  const allNotes = useLiveQuery(() => db.notes.orderBy('updatedAt').reverse().toArray(), [], [])
  const images = useLiveQuery(() => db.images.toArray(), [], [])
  const [filter, setFilter] = useState<NoteFilter>('all')
  const [search, setSearch] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [editorNote, setEditorNote] = useState<Note | null>(null)
  const editorId = editorNote?.id ?? null
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [config, setConfig] = useState<CloudConfig>(defaultConfig)
  const [configReady, setConfigReady] = useState(false)
  const [authReady, setAuthReady] = useState(false)
  const [user, setUser] = useState<LocalOwner | null>(null)
  const ownerId = user?.id ?? null
  const [noteSelection, setNoteSelection] = useState<NoteSelection | null>(null)
  const [purging, setPurging] = useState<PurgeRequest | null>(null)
  const [purgeError, setPurgeError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const deletingRef = useRef(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [pushLogin, setPushLogin] = useState<{ client: SupabaseClient; ownerId: string; id: string } | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [lastSynced, setLastSynced] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null)
  const [updateReady, setUpdateReady] = useState(false)
  const [pwaReady, setPwaReady] = useState(false)
  const [sort, setSort] = useState<'updated' | 'created' | 'title'>('updated')
  const [gridView, setGridView] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const activeSync = useRef<{ promise: Promise<void>; client: SupabaseClient; ownerId: string } | null>(null)
  const editingRef = useRef<symbol | null>(null)
  const noteEditor = useRef<NoteEditorHandle>(null)
  const userRef = useRef<LocalOwner | null>(null)
  const verifiedUserRef = useRef<User | null>(null)
  const signingOutRef = useRef(false)
  const revalidateAuth = useRef<(() => Promise<void>) | null>(null)
  const authReadyRef = useRef(false)
  const processingCapture = useRef(false)
  const [captureRetry, setCaptureRetry] = useState(0)
  const [windowsCaptureIds, setWindowsCaptureIds] = useState<string[]>([])
  const [windowsCaptureOpenError, setWindowsCaptureOpenError] = useState('')
  const recoveryCaptureInput = useRef<HTMLInputElement>(null)
  const updateWorker = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null)
  const notify = useCallback((message: string) => {
    clearTimeout(toastTimer.current)
    setToast(message)
    toastTimer.current = setTimeout(() => setToast(''), 5000)
  }, [])
  const queueWindowsCapture = useCallback(({ id }: SharedCapture) => {
    setWindowsCaptureIds(ids => ids.includes(id) ? ids : [...ids, id])
  }, [])
  const reportWindowsCaptureError = useCallback((error: Error) => {
    if (error instanceof CaptureFileOpenError) setWindowsCaptureOpenError(error.message)
    else notify(error.message)
  }, [notify])
  const importWindowsCapture = useCallback((file: File) => {
    void receiveCaptureFile(file).then(capture => {
      setWindowsCaptureOpenError('')
      setSettingsOpen(false)
      queueWindowsCapture(capture)
    }).catch((error: unknown) => reportWindowsCaptureError(error instanceof Error ? error : new Error('캡처 파일을 열지 못했습니다.')))
  }, [queueWindowsCapture, reportWindowsCaptureError])
  useEffect(() => listenForCaptureFiles({ onCapture: queueWindowsCapture, onError: reportWindowsCaptureError }), [queueWindowsCapture, reportWindowsCaptureError])
  const client = useMemo(() => {
    if (!config.url || !config.anonKey) return null
    try { return createCloudClient(config) } catch { return null }
  }, [config.url, config.anonKey])
  const clientRef = useRef(client)
  clientRef.current = client
  const closeEditor = useCallback(() => {
    editingRef.current = null
    setEditorNote(null)
    setPurging(previous => previous?.editorId ? null : previous)
  }, [])
  const requestEditorClose = useCallback(() => {
    if (deletingRef.current) return
    if (purging) setPurging(null)
    else return noteEditor.current?.requestClose()
  }, [purging])
  useNoteBackNavigation(editorId, requestEditorClose)
  const applyUser = useCallback((next: LocalOwner | null) => {
    if ((userRef.current?.id ?? null) !== (next?.id ?? null)) {
      closeEditor()
      setNoteSelection(null)
      setPurging(null)
    }
    userRef.current = next
    setUser(next)
  }, [closeEditor])
  useEffect(() => {
    void getSetting<CloudConfig>('cloud-config', defaultConfig).then(setConfig)
      .catch(() => notify('기기 저장소를 열지 못했습니다. 브라우저 저장공간을 확인해 주세요.'))
      .finally(() => setConfigReady(true))
    void getSetting<string | null>('last-synced', null).then(setLastSynced)
    const handleOnline = () => {
      setOnline(navigator.onLine)
      verifiedUserRef.current = null
      setAuthenticated(false)
      if (navigator.onLine) void revalidateAuth.current?.()
    }
    const handleInstall = (event: Event) => { event.preventDefault(); setInstallEvent(event as InstallEvent) }
    window.addEventListener('online', handleOnline); window.addEventListener('offline', handleOnline)
    window.addEventListener('beforeinstallprompt', handleInstall)
    updateWorker.current = registerSW({ onNeedRefresh() { setUpdateReady(true) }, onOfflineReady() { setPwaReady(true) }, onRegisteredSW() { void navigator.serviceWorker.ready.then(() => setPwaReady(true)) }, onRegisterError() { notify('오프라인 준비에 실패했습니다. 온라인 상태에서 새로고침해 주세요.') } })
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOnline); window.removeEventListener('beforeinstallprompt', handleInstall); clearTimeout(toastTimer.current) }
  }, [notify])
  useEffect(() => {
    applyUser(null)
    verifiedUserRef.current = null
    setAuthenticated(false)
    setPushLogin(null)
    authReadyRef.current = false
    setAuthReady(false)
    if (!configReady) return
    if (!client) {
      authReadyRef.current = configReady
      setAuthReady(configReady)
      return
    }
    let active = true
    let authVersion = 0
    let explicitlySignedOut = false
    let cachedOwner: LocalOwner | null = null
    const rememberPushPreviewOwner = (ownerId: string | null) => {
      void updatePushPreviewOwner(config, defaultConfig, ownerId).catch(() => {})
    }
    const presentSession = (session: Session | null, signedOut = false) => {
      if (!active) return
      authReadyRef.current = true; setAuthReady(true)
      if (signedOut) {
        explicitlySignedOut = true
        cachedOwner = null
        verifiedUserRef.current = null
        setAuthenticated(false)
        setPushLogin(null)
        applyUser(null)
        void clearCachedOwner(config.url).catch(() => {})
        rememberPushPreviewOwner(null)
        return
      }
      if (signingOutRef.current) return
      const actualUser = session?.user ?? null
      verifiedUserRef.current = actualUser
      setAuthenticated(Boolean(actualUser && navigator.onLine))
      if (actualUser) {
        const sessionId = loginSessionId(session?.access_token)
        const nextId = sessionId ?? crypto.randomUUID()
        setPushLogin(previous => previous?.client === client && previous.ownerId === actualUser.id && (!sessionId || previous.id === sessionId)
          ? previous : { client, ownerId: actualUser.id, id: nextId })
        cachedOwner = { id: actualUser.id, ...(actualUser.email ? { email: actualUser.email } : {}) }
        applyUser(cachedOwner)
        void writeCachedOwner(config.url, cachedOwner).catch(() => {})
        rememberPushPreviewOwner(actualUser.id)
      } else {
        setPushLogin(null)
        applyUser(!navigator.onLine ? cachedOwner : null)
        if (navigator.onLine) rememberPushPreviewOwner(null)
      }
    }
    const checkSession = async () => {
      const version = authVersion
      try {
        const { data, error } = await client.auth.getSession()
        if (active && version === authVersion) {
          presentSession(data.session)
          if (error && navigator.onLine) notify('로그인을 확인하지 못했습니다. 다시 로그인해 주세요.')
        }
      } catch {
        if (active && version === authVersion) {
          presentSession(null)
          if (navigator.onLine) notify('로그인을 확인하지 못했습니다. 다시 로그인해 주세요.')
        }
      }
    }
    revalidateAuth.current = checkSession
    // Local editing never waits for an expired token's network refresh. This
    // token-free owner is only a device view; cloud calls use verifiedUserRef.
    void readCachedOwner(config.url).then(cached => {
      if (!active) return
      if (!verifiedUserRef.current && !signingOutRef.current && !explicitlySignedOut) {
        cachedOwner = cached
        if (!navigator.onLine) applyUser(cached)
      }
    }).catch(() => {}).finally(() => {
      if (active) { authReadyRef.current = configReady; setAuthReady(configReady) }
    })
    void checkSession()
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return
      authVersion++
      presentSession(session, event === 'SIGNED_OUT')
    })
    return () => {
      active = false
      if (revalidateAuth.current === checkSession) revalidateAuth.current = null
      data.subscription.unsubscribe()
    }
  }, [client, config.url, configReady, applyUser, notify])
  const currentNotes = allNotes.filter(note => note.cloudOwnerId === null || note.cloudOwnerId === user?.id)
  const activeNotes = currentNotes.filter(note => !note.deletedAt)
  const tags = [...new Set(activeNotes.flatMap(note => note.tags))].sort((a, b) => a.localeCompare(b, 'ko'))
  const currentImageIds = new Set(currentNotes.flatMap(note => note.attachments.map(image => image.id)))
  const totalImageBytes = images.filter(image => currentImageIds.has(image.id)).reduce((sum, image) => sum + image.size, 0)
  const localCount = currentNotes.filter(note => note.cloudOwnerId === null).length
  const pendingCount = currentNotes.filter(note => note.dirty && note.cloudOwnerId === user?.id).length
  const purgeQueue = useLiveQuery(async () => ({
    ownerId,
    count: ownerId ? await db.pendingPurges.where('ownerId').equals(ownerId).count() : 0,
  }), [ownerId])
  const pendingPurgeCount = purgeQueue && purgeQueue.ownerId === ownerId ? purgeQueue.count : 0
  const selectedNote = editorNote && (editorNote.cloudOwnerId === null || editorNote.cloudOwnerId === user?.id) ? editorNote : null
  const visibleNotes = currentNotes.filter(note => {
    if (filter === 'trash' ? !note.deletedAt : Boolean(note.deletedAt)) return false
    if (filter === 'pinned' && !note.pinned) return false
    if (filter === 'images' && !hasImage(note)) return false
    if (tag && !note.tags.includes(tag)) return false
    const query = search.trim().toLocaleLowerCase()
    return !query || `${note.title}\n${note.body}\n${note.tags.join(' ')}`.toLocaleLowerCase().includes(query)
  }).sort((a, b) => {
    if (sort === 'title') return noteTitle(a).localeCompare(noteTitle(b), 'ko')
    if (sort === 'created') return b.createdAt.localeCompare(a.createdAt)
    return Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)
  })
  const selectionScope = JSON.stringify([ownerId, filter, search, tag])
  const selecting = noteSelection?.scope === selectionScope && visibleNotes.length > 0
  const selectedNotes = selecting ? visibleNotes.filter(note => noteSelection.ids.has(note.id)) : []
  const toggleSelectedNote = (id: string, forceSelected = false) => {
    if (deletingRef.current) return
    setNoteSelection(previous => {
      const ids = new Set(previous?.scope === selectionScope ? previous.ids : [])
      if (ids.has(id) && !forceSelected) ids.delete(id)
      else ids.add(id)
      return { scope: selectionScope, ids }
    })
  }
  const longPress = useNoteLongPress(selectionScope, id => toggleSelectedNote(id, true))
  useEffect(() => {
    setNoteSelection(null)
  }, [selectionScope, editorId, settingsOpen])
  const performSync = useCallback((manual = false, editorToken?: symbol): Promise<void> => {
    if (deletingRef.current) return Promise.resolve()
    const currentClient = clientRef.current
    const ownerId = verifiedUserRef.current?.id
    const running = activeSync.current
    if (running) {
      if (running.client === currentClient && running.ownerId === ownerId) return running.promise
      return running.promise.then(() => performSync(manual, editorToken))
    }
    if (!currentClient || !ownerId || ownerId !== userRef.current?.id || !authReadyRef.current) return Promise.resolve()
    if (!navigator.onLine) { if (manual) notify('오프라인이에요. 연결되면 다시 동기화할게요.'); return Promise.resolve() }
    if (editingRef.current && editingRef.current !== editorToken) { if (manual) notify('메모의 완료 버튼을 누르면 동기화됩니다.'); return Promise.resolve() }
    setSyncing(true); setSyncError('')
    const work = (async () => {
      try {
        const report = await syncNotes(currentClient, ownerId)
        if (userRef.current?.id !== ownerId || clientRef.current !== currentClient) return
        const now = new Date().toISOString()
        setLastSynced(now); await setSetting('last-synced', now)
        if (report.conflicts) notify(`서로 다른 수정 내용을 ${report.conflicts}개의 충돌 사본으로 보관했어요.`)
        if (report.pendingPurges) {
          const message = 'Supabase 영구 삭제 설정을 완료하면 대기 중인 삭제 내역이 다른 기기에 반영돼요.'
          setSyncError(message)
          if (manual) notify(message)
        } else if (report.pendingRecordings) {
          const message = '녹화 메모는 이 기기에 저장했어요. 기기 간 녹화 동기화 설정을 확인해 주세요.'
          setSyncError(message)
          if (manual) notify(message)
        } else if (manual && !report.conflicts) notify('내 기기들의 메모를 최신 상태로 맞췄어요.')
      } catch (error) {
        if (userRef.current?.id !== ownerId || clientRef.current !== currentClient) return
        const message = error instanceof Error ? error.message : '동기화하지 못했습니다.'
        setSyncError(message)
        if (manual) notify(message)
      }
    })()
    const task = work.finally(() => {
      if (activeSync.current?.promise === task) activeSync.current = null
      setSyncing(false)
    })
    activeSync.current = { promise: task, client: currentClient, ownerId }
    return task
  }, [notify])
  const runEditorOperation = useCallback(async (load: (context: EditorOperation) => Promise<Note | null | undefined>, syncFirst = false) => {
    if (!authReadyRef.current) { notify('연결 상태를 확인하고 있어요. 잠시 뒤 다시 열어 주세요.'); return false }
    if (editingRef.current) { notify('편집 중인 메모를 마친 뒤 열어 주세요.'); return false }
    if (deletingRef.current) { notify('메모가 삭제되면 다시 열어 주세요.'); return false }
    const token = Symbol('editor')
    editingRef.current = token
    const ownerId = userRef.current?.id ?? null
    const isCurrent = () => editingRef.current === token && (userRef.current?.id ?? null) === ownerId
    let opened = false
    try {
      // Taking the editor lock before awaiting prevents another sync from
      // starting between the completed download and the editor snapshot.
      await activeSync.current?.promise
      if (!isCurrent()) return false
      if (syncFirst) await performSync(false, token)
      if (!isCurrent()) return false
      const note = await load({ ownerId, isCurrent })
      if (!note || !isCurrent()) return false
      const latest = await db.notes.get(note.id)
      if (!latest || !isCurrent()) return false
      if (latest.cloudOwnerId !== null && latest.cloudOwnerId !== ownerId) {
        notify('현재 계정의 메모만 열 수 있어요.'); return false
      }
      setEditorNote(latest)
      setSidebarOpen(false)
      opened = true
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : '메모를 열지 못했습니다.')
      return false
    } finally {
      if (!opened && editingRef.current === token) editingRef.current = null
    }
  }, [notify, performSync])
  const openNote = useCallback((noteId: string) => runEditorOperation(() => db.notes.get(noteId)), [runEditorOperation])
  useEffect(() => {
    if (!client || !user || !authenticated || !online || editorId) return
    const initial = setTimeout(() => { void performSync() }, 600)
    const interval = setInterval(() => { void performSync() }, 60_000)
    const unsubscribe = subscribeToNoteChanges(client, user.id, () => { void performSync() })
    const onFocus = () => { void performSync() }
    window.addEventListener('focus', onFocus)
    return () => { clearTimeout(initial); clearInterval(interval); unsubscribe(); window.removeEventListener('focus', onFocus) }
  }, [client, user, authenticated, online, editorId, performSync])
  useEffect(() => {
    if (!authenticated || (!pendingCount && !pendingPurgeCount) || syncing || !online || editorId || syncError || deleting) return
    const timer = setTimeout(() => { void performSync() }, 1000)
    return () => clearTimeout(timer)
  }, [authenticated, pendingCount, pendingPurgeCount, syncing, online, editorId, syncError, deleting, performSync])
  function requestPurge(notes: Note[], fromEditor = false) {
    if (!notes.length || deletingRef.current) return
    setPurgeError('')
    setPurging({
      ids: notes.map(note => note.id),
      ownerId,
      editorId: fromEditor ? notes[0].id : null,
      cloud: notes.some(note => note.cloudOwnerId !== null),
    })
  }
  async function deleteNotes(ids: string[], request?: PurgeRequest) {
    if (!ids.length || deletingRef.current) return
    const deletionOwnerId = request ? request.ownerId : ownerId
    deletingRef.current = true
    setDeleting(true)
    setPurgeError('')
    try {
      await activeSync.current?.promise
      if ((userRef.current?.id ?? null) !== deletionOwnerId) return
      const count = await (request ? purgeNotes(ids, deletionOwnerId) : trashNotes(ids, deletionOwnerId))
      if (request) {
        setPurging(null)
        if (request.editorId) closeEditor()
      }
      setNoteSelection(null)
      if (!count) notify('선택한 메모가 이미 이동되었거나 삭제됐어요.')
      else if (request?.cloud) notify(`이 기기에서 메모 ${count}개를 영구 삭제했어요. 다른 기기에도 동기화할게요.`)
      else if (request) notify(`메모 ${count}개를 영구 삭제했어요.`)
      else notify(`메모 ${count}개를 휴지통으로 옮겼어요.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '메모를 삭제하지 못했습니다.'
      if (request) setPurgeError(message)
      else notify(message)
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }
  async function newNote() {
    await runEditorOperation(({ ownerId }) => createNote(ownerId))
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea, [contenteditable]') || target.closest('dialog[open]') || event.defaultPrevented || purging || editorId || settingsOpen) return
      if (event.key === 'Escape' && selecting) { setNoteSelection(null); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' || event.key === '/') { event.preventDefault(); searchRef.current?.focus() }
      if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); void newNote() }
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [editorId, settingsOpen, user, purging, selecting])
  const openPushedNote = useCallback(async (noteId: string | undefined) => {
    if (!noteId || !/^[0-9a-f-]{36}$/i.test(noteId)) return
    if (editingRef.current) { notify('편집을 마친 뒤 새 메모를 열어 주세요.'); return }
    // Reserve the editor while waiting for any focus-triggered sync, then
    // download the current account's data before taking the editor snapshot.
    await runEditorOperation(async ({ isCurrent }) => {
      if (!isCurrent()) return null
      const note = await db.notes.get(noteId)
      if (!note) notify('계정에 로그인하고 동기화하면 새 메모를 볼 수 있어요.')
      return note
    }, true)
  }, [runEditorOperation, notify])
  useEffect(() => {
    const listener = (event: MessageEvent) => { if (event.data?.type === 'OPEN_NOTE') void openPushedNote(event.data.noteId) }
    navigator.serviceWorker?.addEventListener('message', listener)
    return () => navigator.serviceWorker?.removeEventListener('message', listener)
  }, [openPushedNote])
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const windowsCaptureId = windowsCaptureIds[0]
    const captureId = windowsCaptureId ?? params.get('capture')
    if (!captureId || !configReady || !authReady || deleting || purging || processingCapture.current || editingRef.current || (windowsCaptureId && settingsOpen)) return
    processingCapture.current = true
    const initialOwner = userRef.current?.id ?? null
    void runEditorOperation(async ({ ownerId, isCurrent }) => {
      const existing = async () => {
        const prior = await db.notes.get(captureId)
        if (prior && prior.cloudOwnerId !== null && prior.cloudOwnerId !== ownerId) {
          throw new Error('이 캡처는 이미 다른 계정의 메모에 저장돼 있습니다.')
        }
        return prior
      }
      let note = windowsCaptureId ? await existing() : undefined
      if (!note) {
        const capture = await readCapture(captureId)
        if (!capture) throw new Error('공유한 내용을 찾을 수 없습니다.')
        const attachments: StoredAttachment[] = []
        if (capture.recording) attachments.push(storeRecording(capture.files[0], capture.recording, capture.createdAt))
        else for (const file of capture.files) attachments.push(await optimizeImage(file))
        if (!isCurrent()) return null
        note = await db.transaction('rw', db.notes, db.images, db.settings, async () => {
          if (!isCurrent()) throw new Error('계정이 바뀌었습니다. 공유한 내용을 다시 열어 주세요.')
          const previous = windowsCaptureId ? await existing() : undefined
          if (previous) return previous
          const created = await createNote(ownerId, { title: capture.title.slice(0, 200), body: capture.text }, windowsCaptureId)
          if (attachments.length) await attachFiles(created.id, attachments)
          if (!isCurrent()) throw new Error('계정이 바뀌었습니다. 공유한 내용을 다시 열어 주세요.')
          return await db.notes.get(created.id) ?? created
        })
      }
      if (!isCurrent()) return null
      await deleteCapture(captureId).catch(() => {})
      if (!windowsCaptureId) {
        const url = new URL(location.href)
        if (url.searchParams.get('capture') === captureId) {
          url.searchParams.delete('capture')
          history.replaceState(history.state, '', url.href)
        }
      }
      if (!windowsCaptureId) notify('공유한 내용을 메모에 담았어요.')
      else if (note.attachments.some(attachment => attachment.mime === 'video/mp4')) notify('화면 녹화를 메모에 저장했어요.')
      else if (note.body.trim()) notify('캡처 이미지와 텍스트를 메모에 저장했어요.')
      else notify('캡처 이미지를 메모에 저장했어요. 읽어낸 텍스트는 없어요.')
      return note
    }).finally(() => {
      processingCapture.current = false
      if (windowsCaptureId) setWindowsCaptureIds(ids => ids.filter(id => id !== windowsCaptureId))
      else if ((userRef.current?.id ?? null) !== initialOwner) setCaptureRetry(value => value + 1)
    })
  }, [configReady, authReady, user?.id, editorId, settingsOpen, deleting, purging, windowsCaptureIds, captureRetry, runEditorOperation, notify])
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const noteId = params.get('note')
    if (!noteId || !user) return
    params.delete('note'); history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`)
    void openPushedNote(noteId)
  }, [user, openPushedNote])
  async function saveConfig(next: CloudConfig | null) {
    const validated = next ? validateCloudConfig(next) : emptyConfig
    await db.transaction('rw', db.settings, async () => {
      const previous = await getSetting('cloud-config', defaultConfig)
      if (previous.url !== validated.url || previous.anonKey !== validated.anonKey) await clearPushPreviewOwner()
      await setSetting('cloud-config', validated)
    })
    setConfig(validated)
    setSyncError('')
    notify(next ? '연결 설정을 저장했어요.' : '로컬 전용 모드로 전환했어요.')
  }
  async function adopt() {
    const actualUser = verifiedUserRef.current
    if (!actualUser || actualUser.id !== userRef.current?.id || !navigator.onLine) {
      notify('온라인에서 로그인을 확인한 뒤 메모를 연결해 주세요.'); return
    }
    const count = await adoptLocalNotes(actualUser.id)
    notify(`${count}개의 로컬 메모를 계정에 연결했어요.`)
    await performSync(true)
  }
  async function logout() {
    signingOutRef.current = true
    verifiedUserRef.current = null
    setAuthenticated(false)
    applyUser(null)
    try {
      await Promise.all([clearCachedOwner(config.url), updatePushPreviewOwner(config, defaultConfig, null)])
      if (client) await signOutCloud(client)
    } finally { signingOutRef.current = false }
  }
  async function install() {
    if (!installEvent) { notify('iPhone: 공유 메뉴에서 홈 화면에 추가 · PC: 브라우저 주소창의 설치 아이콘을 눌러 주세요.'); return }
    await installEvent.prompt()
    await installEvent.userChoice
    setInstallEvent(null)
  }
  async function importImages(files: File[]) {
    if (!files.length) return
    await runEditorOperation(async ({ ownerId, isCurrent }) => {
      if (files.length > 10) throw new Error('한 번에 10장까지 추가할 수 있어요.')
      notify('이미지를 가볍게 만드는 중이에요…')
      const processed: StoredImage[] = []
      for (const file of files) processed.push(await optimizeImage(file))
      if (!isCurrent()) return null
      return db.transaction('rw', db.notes, db.images, db.settings, async () => {
        if (!isCurrent()) throw new Error('계정이 바뀌었습니다. 이미지를 다시 추가해 주세요.')
        const note = await createNote(ownerId)
        await attachFiles(note.id, processed)
        if (!isCurrent()) throw new Error('계정이 바뀌었습니다. 이미지를 다시 추가해 주세요.')
        return note
      })
    })
  }
  const pageTitle = tag ? `#${tag}` : navigation.find(item => item.id === filter)!.name
  const syncLabel = !online ? (pendingPurgeCount ? '오프라인 · 영구 삭제 동기화 대기' : '오프라인 · 기기에 저장')
    : syncing ? '기기 간 동기화 중'
    : syncError ? '동기화 확인 필요'
    : !user ? '이 기기에 저장 중'
    : !authenticated ? '로그인 확인 중 · 기기에 저장'
    : pendingPurgeCount ? `${pendingPurgeCount}개 영구 삭제 전송 대기`
    : pendingCount ? `${pendingCount}개 메모 전송 대기`
    : '내 기기와 연결됨'
  return <div className="app-shell">
    {sidebarOpen && <div className="sidebar-shade" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="brand"><div className="brand-mark"><span /><span /></div><div><strong>모아<span>moa</span></strong><small>나의 작은 기록함</small></div><button className="icon-button sidebar-close" aria-label="메뉴 닫기" onClick={() => setSidebarOpen(false)}><X size={20} /></button></div>
      <button className="button primary new-note" onClick={() => void newNote()}><Plus size={19} />새 메모<span className="shortcut">N</span></button>
      <nav className="main-nav" aria-label="메모 분류">{navigation.map(item => <button key={item.id} className={`nav-item ${filter === item.id && !tag ? 'active' : ''}`} onClick={() => { setFilter(item.id); setTag(null); setSidebarOpen(false) }}><item.icon size={18} /><span>{item.name}</span><small>{currentNotes.filter(note => item.id === 'trash' ? Boolean(note.deletedAt) : !note.deletedAt && (item.id === 'all' || item.id === 'pinned' && note.pinned || item.id === 'images' && hasImage(note))).length}</small></button>)}</nav>
      <div className="tag-section"><div className="section-label">나의 태그 <Hash size={14} /></div>{tags.length ? tags.map(value => <button className={`tag-nav ${tag === value ? 'active' : ''}`} key={value} onClick={() => { setTag(tag === value ? null : value); setFilter('all'); setSidebarOpen(false) }}><span className="tag-dot" />{value}<small>{activeNotes.filter(note => note.tags.includes(value)).length}</small></button>) : <p className="tag-empty">메모에 태그를 달면<br />이곳에 모아드릴게요.</p>}</div>
      <div className="sidebar-bottom">
        <div className="storage-card"><div><span>첨부 파일 보관함</span><span>{formatBytes(totalImageBytes)}</span></div><div className="storage-track"><span style={{ width: `${Math.max(totalImageBytes ? 2 : 0, Math.min(100, totalImageBytes / 1_000_000_000 * 100))}%` }} /></div><small>이 기기에 보관한 이미지와 영상</small></div>
        <button className="account-button" onClick={() => setSettingsOpen(true)}><div className="avatar">{user?.email?.slice(0, 1).toUpperCase() || <FolderHeart size={19} />}</div><span><strong>{user?.email?.split('@')[0] || '나만의 공간'}</strong><small>{user ? '동기화 계정' : '로컬 전용 모드'}</small></span><Settings2 size={18} /></button>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="메뉴 열기" onClick={() => setSidebarOpen(true)}><Menu size={22} /></button><div className="breadcrumb">나의 공간<span>/</span><strong>{pageTitle}</strong></div><div className="topbar-actions"><button className={`sync-status ${syncError ? 'warning' : ''}`} aria-label={syncLabel} title={syncError || (lastSynced ? `마지막 동기화: ${new Date(lastSynced).toLocaleString('ko')}` : '동기화 설정')} onClick={() => user ? void performSync(true) : setSettingsOpen(true)}>{!online ? <WifiOff size={16} /> : syncing ? <LoaderCircle size={16} className="spin" /> : user ? <Cloud size={16} /> : <CloudOff size={16} />}<span>{syncLabel}</span></button><button className="icon-button" aria-label="설정 열기" title="설정" onClick={() => setSettingsOpen(true)}><Settings2 size={20} /></button></div></header>
      <div className="workspace" onDragOver={event => { if (!editorId) event.preventDefault() }} onDrop={event => { if (!editorId) { event.preventDefault(); void importImages(Array.from(event.dataTransfer.files)) } }}>
        <section className="page-heading"><div><div className="eyebrow"><span />KEEP YOUR LITTLE THINGS</div><h1>{pageTitle}<span>{visibleNotes.length}</span></h1><p>{filter === 'trash' ? '휴지통의 메모를 복원하거나 영구 삭제할 수 있어요.' : filter === 'images' ? '눈에 담았던 순간을, 한곳에 모아두세요.' : filter === 'pinned' ? '자주 꺼내 보고 싶은 생각들을 모았어요.' : '스치는 생각부터 소중한 순간까지, 가볍게 담아두세요.'}</p></div><button className="button primary heading-new" onClick={() => void newNote()}><Plus size={18} />새 메모</button></section>
        {!user && <div className="local-banner"><div className="banner-icon"><CheckCheck size={19} /></div><p><strong>지금은 이 기기에 안전하게 담고 있어요.</strong><span>인터넷 없이도 기록하고, 준비되면 내 기기들을 연결하세요.</span></p><button onClick={() => setSettingsOpen(true)}>기기 연결</button></div>}
        {user && localCount > 0 && <div className="local-banner"><div className="banner-icon"><Cloud size={19} /></div><p><strong>이 기기에만 있는 메모가 {localCount}개 있어요.</strong><span>계정에 연결하면 다른 기기에서도 볼 수 있습니다.</span></p><button onClick={() => void adopt().catch(error => notify(error.message))}>함께 동기화</button></div>}
        {windowsCaptureOpenError && <div className="local-banner">
          <div className="banner-icon"><FileText size={19} aria-hidden="true" /></div>
          <p role="alert"><strong>{windowsCaptureOpenError}</strong><span>보조 앱의 ‘캡처 파일 위치’에서 .moacapture 파일을 확인한 뒤 직접 선택하세요.</span></p>
          <button type="button" onClick={() => recoveryCaptureInput.current?.click()}>캡처 파일 선택</button>
          <button type="button" aria-label="캡처 안내 닫기" onClick={() => setWindowsCaptureOpenError('')}><X size={16} aria-hidden="true" /></button>
          <input ref={recoveryCaptureInput} type="file" accept=".moacapture" hidden aria-label="복구할 캡처 파일" onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) importWindowsCapture(file)
          }} />
        </div>}
        <div className="collection-toolbar"><label className="search-box"><Search size={18} /><input ref={searchRef} type="search" placeholder="제목, 내용, 태그로 찾아보세요" aria-label="메모 검색" value={search} onChange={event => setSearch(event.target.value)} /><kbd>/</kbd></label><div className="view-controls"><select aria-label="메모 정렬" value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="updated">최근 수정순</option><option value="created">최근 작성순</option><option value="title">제목순</option></select><span /><button className={`icon-button ${gridView ? 'selected' : ''}`} aria-label="격자로 보기" aria-pressed={gridView} onClick={() => setGridView(true)}><LayoutGrid size={18} /></button><button className={`icon-button ${!gridView ? 'selected' : ''}`} aria-label="목록으로 보기" aria-pressed={!gridView} onClick={() => setGridView(false)}><FileText size={18} /></button>
          {visibleNotes.length > 0 && <button
            type="button"
            className={`button small selection-toggle ${selecting ? 'selection-active' : 'secondary'}`}
            aria-pressed={selecting}
            disabled={deleting}
            onClick={() => setNoteSelection(selecting ? null : { scope: selectionScope, ids: new Set() })}
          >{selecting ? <X size={16} aria-hidden="true" /> : <ListChecks size={16} aria-hidden="true" />}{selecting ? '선택 해제' : '선택'}</button>}
        </div></div>
        {tag && <div className="active-filter"><span>#{tag}<button aria-label="태그 필터 해제" onClick={() => setTag(null)}><X size={13} /></button></span></div>}
        {selecting && <div className="selection-actions" role="group" aria-label="선택한 메모 관리">
          <span role="status">{selectedNotes.length}개 선택</span>
          <button
            type="button"
            className={`button small ${filter === 'trash' ? 'danger-solid' : 'secondary'}`}
            disabled={!selectedNotes.length || deleting}
            onClick={() => {
              if (filter === 'trash') requestPurge(selectedNotes)
              else void deleteNotes(selectedNotes.map(note => note.id))
            }}
          ><Trash2 size={16} aria-hidden="true" />{filter === 'trash' ? '영구 삭제' : '휴지통으로 이동'}</button>
        </div>}
        {visibleNotes.length ? <div className={`notes-grid ${gridView ? '' : 'list-view'}`}>{visibleNotes.map(note => {
          const checked = selecting && noteSelection.ids.has(note.id)
          const activate = () => {
            if (selecting) toggleSelectedNote(note.id)
            else void openNote(note.id)
          }
          return <article
            className={`note-card ${note.attachments.length ? 'has-image' : ''} ${note.pinned ? 'is-pinned' : ''} ${checked ? 'card-selected' : ''}`}
            key={note.id}
            tabIndex={0}
            role="button"
            aria-label={`${noteTitle(note)} ${selecting ? '선택' : '메모 열기'}`}
            aria-pressed={selecting ? checked : undefined}
            onPointerDown={event => longPress.start(event, note.id)}
            onPointerMove={longPress.move}
            onPointerUp={longPress.end}
            onPointerCancel={longPress.end}
            onPointerLeave={longPress.end}
            onContextMenu={longPress.contextMenu}
            onDragStart={event => { if (event.target instanceof HTMLImageElement) event.preventDefault() }}
            onClick={event => { if (!longPress.consumeClick(event, note.id)) activate() }}
            onKeyDown={event => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault()
                if (!event.repeat) activate()
              }
            }}
          >
          {note.attachments[0] && <div className="note-card-image">{note.attachments[0].mime === 'video/mp4' ? <div className="video-card-preview" aria-hidden="true"><Video size={30} /></div> : <ImageView image={note.attachments[0]} />}{note.attachments.length > 1 && <span className="image-count"><ImageIcon size={13} />{note.attachments.length}</span>}</div>}
          <div className="note-card-content"><div className="note-card-top"><span className={`note-kind ${note.attachments.length ? 'image-kind' : ''}`}>{note.attachments.some(attachment => attachment.mime === 'video/mp4') ? <><Video size={13} />녹화 메모</> : hasImage(note) ? <><ImageIcon size={13} />이미지 메모</> : <><FileText size={13} />텍스트 메모</>}</span>{selecting ? <span className="card-selection-check" aria-hidden="true">{checked && <Check size={15} />}</span> : !note.deletedAt && <button className={`card-pin ${note.pinned ? 'pinned' : ''}`} aria-label={note.pinned ? '고정 해제' : '메모 고정'} title={note.pinned ? '고정 해제' : '메모 고정'} onClick={event => { event.stopPropagation(); void updateNote(note.id, { pinned: !note.pinned }).catch(error => notify(error.message)) }}><Pin size={15} /></button>}</div><h2>{noteTitle(note)}</h2>{note.body && <p className="note-excerpt">{excerpt(note.body)}</p>}{note.tags.length > 0 && <div className="note-tags">{note.tags.slice(0, 3).map(value => selecting ? <span className="selection-tag" key={value}>#{value}</span> : <button key={value} onClick={event => { event.stopPropagation(); setTag(value); setFilter('all') }}>#{value}</button>)}{note.tags.length > 3 && <span>+{note.tags.length - 3}</span>}</div>}<div className="note-card-footer"><time dateTime={note.updatedAt}>{dateLabel(note.updatedAt)}</time><span title={note.cloudOwnerId ? note.dirty ? '동기화 대기' : '동기화됨' : '이 기기에 저장됨'}>{note.cloudOwnerId ? note.dirty ? <Cloud size={14} /> : <CheckCheck size={14} /> : <Check size={14} />}</span></div></div>
          </article>
        })}</div> : <section className="empty-state"><div className="empty-art"><div className="art-paper back" /><div className="art-paper front"><span /><span /><span /><div className="art-dot"><Sparkles size={21} /></div></div><div className="art-spark one" /><div className="art-spark two" /></div><h2>{search || tag ? '아직 일치하는 메모가 없어요' : filter === 'trash' ? '휴지통이 비어 있어요' : filter === 'pinned' ? '오래 간직할 생각을 고정해 보세요' : filter === 'images' ? '첫 번째 이미지를 모아보세요' : '작은 기록이 모이는 곳'}</h2><p>{search || tag ? '다른 단어나 태그로 다시 찾아보세요.' : filter === 'trash' ? '휴지통으로 옮긴 메모는 이곳에서 복원할 수 있어요.' : filter === 'pinned' ? '메모의 핀 아이콘을 누르면 이곳에 모입니다.' : '오늘의 생각 한 줄, 좋아하는 사진 한 장.\n무엇이든 담아두면 필요할 때 다시 만날 수 있어요.'}</p>{!search && !tag && filter !== 'trash' && filter !== 'pinned' && <button className="button primary" onClick={() => void newNote()}><Plus size={18} />첫 메모 남기기</button>}<div className="empty-features"><span><FileText size={15} />텍스트와 Markdown</span><span><ImageIcon size={15} />가벼운 WebP 이미지</span><span><WifiOff size={15} />오프라인에서도</span></div></section>}
        <footer className="workspace-footer"><span>나만의 속도로, 차곡차곡.</span><span>{activeNotes.length}개의 기록<span className="footer-divider">·</span>{pwaReady ? '오프라인 준비됨' : '오프라인 준비 중'}</span></footer>
      </div>
      <button className="mobile-fab" aria-label="새 메모" onClick={() => void newNote()}><Plus size={26} /></button>
    </main>
    {selectedNote && <NoteEditor key={selectedNote.id} ref={noteEditor} note={selectedNote} onClose={closeEditor} onPurge={note => requestPurge([note], true)} purgeDialogOpen={purging?.editorId === selectedNote.id} notify={notify} />}
    {purging && <PurgeDialog count={purging.ids.length} cloud={purging.cloud} busy={deleting} error={purgeError} onCancel={() => setPurging(null)} onConfirm={() => void deleteNotes(purging.ids, purging)} />}
    {settingsOpen && <SettingsDialog config={config} client={client} user={user} authenticated={authenticated && online} onSignOut={logout} onSaveConfig={saveConfig} onClose={() => setSettingsOpen(false)} notify={notify} onSync={() => performSync(true)} onAdopt={adopt} onWindowsCapture={importWindowsCapture} syncing={syncing} />}
    {!editorId && !settingsOpen && !purging && !windowsCaptureIds.length && online && authenticated && client && pushLogin?.client === client && pushLogin.ownerId === user?.id &&
      <LoginPushPrompt key={pushLogin.id} client={client} projectUrl={config.url} ownerId={pushLogin.ownerId} sessionId={pushLogin.id} publicKey={config.vapidPublicKey} workerReady={pwaReady} />}
    {toast && <div className="toast" role="status"><Check size={17} /><span>{toast}</span><button className="icon-button" aria-label="알림 닫기" onClick={() => setToast('')}><X size={15} /></button></div>}
    {updateReady && <div className="update-toast" role="status"><span>새 버전이 준비됐어요.</span><button disabled={Boolean(editorId)} onClick={() => void updateWorker.current?.(true)}>{editorId ? '메모를 마치면 업데이트' : '업데이트'}</button></div>}
    {!settingsOpen && installEvent && <button className="install-chip" onClick={() => void install()}><Download size={15} />앱으로 설치</button>}
  </div>
}
