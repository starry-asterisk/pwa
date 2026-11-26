// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, createNote } from './lib/db'
import { readCapture, storeCapture } from './lib/share-inbox'
import { readCachedOwner, writeCachedOwner } from './lib/offline-owner'
import { getPushPreviewOwner } from './lib/push-preview-owner'
import App from './App'

const mocks = vi.hoisted(() => {
  const owner = { id: 'f485e060-eef0-4f14-9742-57d0891a7cab', email: 'owner@example.test' }
  type TestSession = { user: typeof owner; access_token?: string }
  const state = {
    owner,
    authListener: null as null | ((event: string, session: TestSession | null) => void),
    serviceWorkerListener: null as null | ((event: MessageEvent) => void),
  }
  const client = {
    auth: {
      getSession: vi.fn(async (): Promise<{ data: { session: TestSession }; error: null }> => ({ data: { session: { user: owner } }, error: null })),
      onAuthStateChange: vi.fn((listener) => {
        state.authListener = listener
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      }),
    },
  }
  return { state, client, sync: vi.fn(), push: { supported: false, prepare: vi.fn(), verify: vi.fn(), enable: vi.fn() } }
})

vi.mock('virtual:pwa-register', () => ({ registerSW: () => () => Promise.resolve() }))
vi.mock('./lib/cloud', () => ({
  createCloudClient: () => mocks.client,
  subscribeToNoteChanges: () => () => {},
  validateCloudConfig: (value: unknown) => value,
  sendMagicLink: vi.fn(), signOutCloud: vi.fn(async () => { mocks.state.authListener?.('SIGNED_OUT', null) }),
  savePushSubscription: vi.fn(), removePushSubscription: vi.fn(),
}))
vi.mock('./lib/sync', () => ({ syncNotes: mocks.sync, adoptLocalNotes: vi.fn() }))
vi.mock('./lib/notifications', () => ({
  supportsPush: () => mocks.push.supported,
  preparePush: mocks.push.prepare,
  verifyPushRegistration: mocks.push.verify,
  enablePush: mocks.push.enable,
  disablePush: vi.fn(),
}))

let root: Root
let container: HTMLDivElement
const report = { uploaded: 0, downloaded: 1, conflicts: 0 }
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await act(async () => { await new Promise(done => setTimeout(done, 10)) })
  }
  expect(check()).toBe(true)
}

async function mount() {
  await act(async () => { root.render(createElement(App)) })
  await until(() => container.querySelector('.account-button small')?.textContent === '동기화 계정')
}

async function click(selector: string) {
  await act(async () => { (container.querySelector(selector) as HTMLElement).click() })
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  mocks.client.auth.getSession.mockReset().mockResolvedValue({ data: { session: { user: mocks.state.owner } }, error: null })
  await Promise.all([db.notes.clear(), db.images.clear(), db.settings.clear()])
  await db.settings.put({ key: 'cloud-config', value: { url: 'https://test.supabase.co', anonKey: 'sb_publishable_test', vapidPublicKey: '' } })
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
    addEventListener: (name: string, listener: (event: MessageEvent) => void) => { if (name === 'message') mocks.state.serviceWorkerListener = listener },
    removeEventListener: () => {},
  } })
  mocks.sync.mockReset().mockResolvedValue(report)
  mocks.push.supported = false
  mocks.push.prepare.mockReset().mockResolvedValue({ registration: null, subscription: null })
  mocks.push.verify.mockReset().mockResolvedValue(false)
  mocks.push.enable.mockReset().mockResolvedValue(undefined)
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  history.replaceState(null, '', location.pathname)
  vi.unstubAllGlobals()
})

describe('login notification offer', () => {
  const firstLogin = 'ce395a9a-2872-4325-a757-197f4b0af1ae'
  const nextLogin = '35d53867-be9c-458c-af85-1c510839efa4'
  const session = (id: string, exp: number) => ({
    user: mocks.state.owner, access_token: `header.${btoa(JSON.stringify({ session_id: id, exp }))}.signature`,
  })
  const prompt = () => container.querySelector('.login-push-dialog')
  const enableOffer = async () => {
    mocks.push.supported = true
    vi.stubGlobal('Notification', { permission: 'granted' })
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', '') } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open') } },
    })
    await db.settings.put({ key: 'cloud-config', value: { url: 'https://test.supabase.co', anonKey: 'sb_publishable_test', vapidPublicKey: 'configured-key' } })
    mocks.client.auth.getSession.mockResolvedValue({ data: { session: session(firstLogin, 100) }, error: null })
  }

  it('offers once across token refresh and reload, and reports successful server registration on a new login', async () => {
    await enableOffer()
    await mount()
    await until(() => Boolean(prompt()))
    await click('.login-push-dialog button')
    await act(async () => { mocks.state.authListener?.('TOKEN_REFRESHED', session(firstLogin, 200)) })
    expect(prompt()).toBeNull()

    await act(async () => { root.unmount() })
    root = createRoot(container)
    await mount()
    expect(prompt()).toBeNull()

    await act(async () => { mocks.state.authListener?.('SIGNED_IN', session(nextLogin, 300)) })
    await until(() => Boolean(prompt()))
    const registration = deferred()
    mocks.push.enable.mockReturnValueOnce(registration.promise)
    await click('.login-push-dialog .button.primary')
    expect(prompt()?.textContent).not.toContain('서버 등록 완료')
    await act(async () => { registration.resolve() })
    expect(prompt()?.textContent).toContain('서버 등록 완료')
  })

  it('switches preview eligibility with auth changes and removes it on logout', async () => {
    const projectUrl = 'https://test.supabase.co'
    await mount()
    await vi.waitFor(async () => {
      expect(await getPushPreviewOwner()).toEqual({ projectUrl, ownerId: mocks.state.owner.id })
    })

    const other = { id: 'f485e060-eef0-4f14-9742-57d0891a7caf', email: 'other@example.test' }
    await act(async () => { mocks.state.authListener?.('SIGNED_IN', { user: other }) })
    await vi.waitFor(async () => {
      expect(await getPushPreviewOwner()).toEqual({ projectUrl, ownerId: other.id })
    })

    await click('[aria-label="설정 열기"]')
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === '동기화')!.click() })
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.settings-panel button')].find(button => button.textContent === '로그아웃')!.click() })
    await vi.waitFor(async () => { expect(await getPushPreviewOwner()).toBeNull() })
  })

  it('skips the offer when the browser subscription matches the server registration', async () => {
    await enableOffer()
    const subscription = { endpoint: 'https://push.example.test/current-device' }
    mocks.push.prepare.mockResolvedValue({ registration: null, subscription })
    mocks.push.verify.mockResolvedValue(true)
    await mount()
    await until(() => mocks.push.verify.mock.calls.length > 0)
    expect(mocks.push.verify).toHaveBeenCalledWith(mocks.client, subscription, mocks.state.owner.id)
    expect(prompt()).toBeNull()
  })
})

describe('editor and synchronization races', () => {
  it('waits for an active download and opens the current database revision', async () => {
    const note = await createNote(mocks.state.owner.id, { title: '동기화 중인 메모', body: '오래된 본문' })
    await createNote(mocks.state.owner.id, { title: '다른 메모', body: '예약한 편집기를 교체하면 안 됨' })
    await db.notes.update(note.id, { dirty: false, baseVersion: note.version })
    const download = deferred()
    mocks.sync.mockImplementation(async () => {
      await download.promise
      await db.notes.update(note.id, { body: '새 원격 본문', version: crypto.randomUUID(), dirty: false })
      return report
    })
    await mount()
    await click('.sync-status')
    await click('.note-card[aria-label^="동기화 중인 메모"]')
    await click('.note-card[aria-label^="다른 메모"]')
    expect(container.querySelector('[aria-label="메모 편집"]')).toBeNull()
    await act(async () => { download.resolve() })
    await until(() => Boolean(container.querySelector('[aria-label="메모 내용"]')))
    expect((container.querySelector('[aria-label="메모 내용"]') as HTMLTextAreaElement).value).toBe('새 원격 본문')
    expect((container.querySelector('[aria-label="메모 제목"]') as HTMLInputElement).value).toBe(note.title)
  })

  it('opens a pushed note after the focus-triggered download has finished', async () => {
    const note = await createNote(mocks.state.owner.id, { title: '알림으로 받은 메모', body: '다른 기기의 새 기록' })
    await db.notes.delete(note.id)
    const download = deferred()
    mocks.sync.mockImplementation(async () => {
      await download.promise
      await db.notes.put({ ...note, dirty: false, baseVersion: note.version })
      return report
    })
    await mount()
    await click('.sync-status')
    await act(async () => {
      mocks.state.serviceWorkerListener?.(new MessageEvent('message', { data: { type: 'OPEN_NOTE', noteId: note.id } }))
    })
    expect(container.querySelector('[aria-label="메모 편집"]')).toBeNull()
    await act(async () => { download.resolve() })
    await until(() => Boolean(container.querySelector('[aria-label="메모 내용"]')))
    expect((container.querySelector('[aria-label="메모 내용"]') as HTMLTextAreaElement).value).toBe(note.body)
  })

  it('flushes a pending draft and closes the old account editor on sign-out', async () => {
    const note = await createNote(mocks.state.owner.id, { title: '비공개 메모', body: '이전 본문' })
    await mount()
    await click('.note-card')
    await until(() => Boolean(container.querySelector('[aria-label="메모 내용"]')))
    await act(async () => {
      const textarea = container.querySelector('[aria-label="메모 내용"]') as HTMLTextAreaElement
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '로그아웃 직전의 마지막 입력')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { mocks.state.authListener?.('SIGNED_OUT', null) })
    expect(container.querySelector('[aria-label="메모 편집"]')).toBeNull()
    expect(container.querySelector('.note-card')).toBeNull()
    await act(async () => { await new Promise(done => setTimeout(done, 30)) })
    expect(await db.notes.get(note.id)).toMatchObject({ body: '로그아웃 직전의 마지막 입력', cloudOwnerId: mocks.state.owner.id })
  })

  it('waits for the account before saving and consuming a shared capture', async () => {
    const captureId = crypto.randomUUID()
    await storeCapture({ id: captureId, title: '공유한 메모', text: '공유한 내용 전체', files: [], createdAt: new Date().toISOString() })
    history.replaceState(null, '', `${location.pathname}?capture=${captureId}`)
    await mount()
    await until(() => Boolean(container.querySelector('[aria-label="메모 내용"]')))
    expect((container.querySelector('[aria-label="메모 내용"]') as HTMLTextAreaElement).value).toBe('공유한 내용 전체')
    expect((await db.notes.toArray())[0]).toMatchObject({ title: '공유한 메모', body: '공유한 내용 전체', cloudOwnerId: mocks.state.owner.id })
    expect(await readCapture(captureId)).toBeUndefined()
    expect(location.search).not.toContain('capture=')
  })

  it('opens and creates cached account notes offline without waiting for an expired session refresh', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    mocks.client.auth.getSession.mockImplementation(() => new Promise(() => {}))
    await writeCachedOwner('https://test.supabase.co', mocks.state.owner)
    await createNote(mocks.state.owner.id, { title: '오프라인 보관 메모', body: '내려받은 기록' })
    await act(async () => { root.render(createElement(App)) })
    await until(() => Boolean(container.querySelector('.note-card')))
    await click('.note-card')
    await until(() => Boolean(container.querySelector('[aria-label="메모 내용"]')))
    expect((container.querySelector('[aria-label="메모 내용"]') as HTMLTextAreaElement).value).toBe('내려받은 기록')
    await click('.editor-toolbar .button.primary')
    await until(() => !container.querySelector('[aria-label="메모 편집"]'))
    await click('.heading-new')
    await until(() => Boolean(container.querySelector('[aria-label="메모 제목"]')))
    expect((await db.notes.toArray()).filter(note => note.cloudOwnerId === mocks.state.owner.id)).toHaveLength(2)
    expect(mocks.sync).not.toHaveBeenCalled()
    await click('.editor-toolbar .button.primary')
    await until(() => !container.querySelector('[aria-label="메모 편집"]'))
    await click('[aria-label="설정 열기"]')
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === '동기화')!.click() })
    const syncButton = [...container.querySelectorAll<HTMLButtonElement>('.settings-panel button')].find(button => button.textContent === '지금 동기화')!
    expect(syncButton.disabled).toBe(true)
    expect(container.textContent).toContain('오프라인 보관함')
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('.settings-panel button')].find(button => button.textContent === '로그아웃')!.click() })
    await act(async () => { await new Promise(done => setTimeout(done, 30)) })
    expect(await readCachedOwner('https://test.supabase.co')).toBeNull()
    expect(container.querySelector('.note-card')).toBeNull()
  })

  it('keeps the offline owner on a null initial session and rechecks the SDK when connectivity returns', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    mocks.client.auth.getSession.mockResolvedValue({ data: { session: null }, error: null } as never)
    await writeCachedOwner('https://test.supabase.co', mocks.state.owner)
    await createNote(mocks.state.owner.id, { title: '세션 만료 중인 기기 메모' })
    await act(async () => { root.render(createElement(App)) })
    await until(() => Boolean(container.querySelector('.note-card')))
    await act(async () => { mocks.state.authListener?.('INITIAL_SESSION', null) })
    expect(container.querySelector('.note-card')).not.toBeNull()
    expect(await readCachedOwner('https://test.supabase.co')).toEqual(mocks.state.owner)
    expect(mocks.sync).not.toHaveBeenCalled()
    mocks.client.auth.getSession.mockResolvedValue({ data: { session: { user: mocks.state.owner } }, error: null })
    await act(async () => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
      window.dispatchEvent(new Event('online'))
    })
    await until(() => !container.querySelector('.sync-status')?.textContent?.includes('오프라인'))
    await click('.sync-status')
    await until(() => mocks.sync.mock.calls.length > 0)
  })
})
