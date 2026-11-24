// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import SettingsDialog from './SettingsDialog'
import { disablePush, enablePush, preparePush, verifyPushRegistration } from '../lib/notifications'

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => undefined }))
vi.mock('../lib/notifications', () => ({
  supportsPush: () => true, preparePush: vi.fn(), verifyPushRegistration: vi.fn(), enablePush: vi.fn(), disablePush: vi.fn(),
}))

const owner = { id: 'aeb29c47-589c-47d5-aa2b-f32c30fd83b1', email: 'owner@example.com' }
const otherOwner = { id: '192f9f29-1d3d-4ac8-a4f1-d649b0b8b22a' }
let root: Root
let container: HTMLDivElement
let workers: EventTarget
let props: ComponentProps<typeof SettingsDialog>
let registration: ServiceWorkerRegistration
let subscription: PushSubscription
let online: boolean

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('Notification', { permission: 'granted' })
  online = true
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  workers = new EventTarget()
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: workers })
  subscription = { endpoint: 'https://push.example.test/current-device' } as PushSubscription
  registration = { active: {} } as ServiceWorkerRegistration
  vi.mocked(preparePush).mockResolvedValue({ registration, subscription })
  vi.mocked(verifyPushRegistration).mockResolvedValue(false)
  vi.mocked(enablePush).mockResolvedValue()
  vi.mocked(disablePush).mockResolvedValue()
  const client = { auth: { onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }) } } as unknown as SupabaseClient
  props = { config: { url: 'https://project.example.test', anonKey: 'sb_publishable_test', vapidPublicKey: 'public-test-key' },
    client, user: owner, authenticated: true, onSignOut: vi.fn(), onSaveConfig: vi.fn(), onClose: vi.fn(),
    notify: vi.fn(), onSync: vi.fn(), onAdopt: vi.fn(), syncing: false }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

async function render(update: Partial<typeof props> = {}) {
  props = { ...props, ...update }
  await act(async () => { root.render(createElement(SettingsDialog, props)) })
}
function button(text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === text)
  if (!element) throw new Error(`Missing button: ${text}`)
  return element
}
async function notificationsTab() { await act(async () => { button('알림').click() }) }

describe('Settings push registration status', () => {
  it('does not mistake a local browser subscription and granted permission for server enrollment', async () => {
    await render()
    await notificationsTab()
    expect(container.textContent).toContain('이 브라우저에 알림 구독이 있습니다.')
    expect(container.textContent).toContain('서버 미등록')
    expect(container.textContent).not.toContain('서버 등록 완료')
    expect(button('서버에 다시 등록').disabled).toBe(false)
  })

  it('shows registered only after checking the current owner/device subscription on the server', async () => {
    vi.mocked(verifyPushRegistration).mockResolvedValue(true)
    await render()
    await notificationsTab()
    expect(verifyPushRegistration).toHaveBeenCalledWith(props.client, subscription, owner.id)
    expect(container.textContent).toContain('서버 등록 완료')
    expect(button('서버에 다시 등록').disabled).toBe(true)
    expect(button('알림 끄기').disabled).toBe(false)
  })

  it('reports a failed lookup as unknown and keeps enrollment failure visible until explicit recovery', async () => {
    vi.mocked(verifyPushRegistration).mockRejectedValueOnce(new Error('서버 확인 실패. 다시 확인해 주세요.'))
    await render()
    await notificationsTab()
    expect(container.textContent).toContain('서버 확인 필요')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('서버 확인 실패')
    vi.mocked(enablePush).mockRejectedValueOnce(new Error('서버에 이 기기를 등록하지 못했습니다.'))
    await act(async () => { button('서버에 다시 등록').click() })
    expect(enablePush).toHaveBeenCalledWith(props.client, props.config.vapidPublicKey, expect.objectContaining({
      prepared: { registration, subscription }, expectedOwnerId: owner.id, onStage: expect.any(Function),
    }))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('서버에 이 기기를 등록하지 못했습니다.')
    expect(container.textContent).toContain('서버 미등록')
    vi.mocked(verifyPushRegistration).mockResolvedValue(true)
    await act(async () => { button('등록 다시 확인').click() })
    expect(container.textContent).toContain('서버 등록 완료')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('discards a late successful lookup from the previous account', async () => {
    let finishPrevious!: (registered: boolean) => void
    vi.mocked(verifyPushRegistration).mockReturnValueOnce(new Promise(resolve => { finishPrevious = resolve }))
    await render()
    await notificationsTab()
    await render({ user: otherOwner })
    expect(verifyPushRegistration).toHaveBeenLastCalledWith(props.client, subscription, otherOwner.id)
    await act(async () => { finishPrevious(true) })
    expect(container.textContent).toContain('서버 미등록')
    expect(container.textContent).not.toContain('서버 등록 완료')
  })

  it('clears a worker preparation error when the worker becomes active, including a fresh browser subscription', async () => {
    vi.mocked(preparePush).mockRejectedValueOnce(new Error('앱의 알림 준비가 아직 완료되지 않았습니다.'))
    await render()
    await notificationsTab()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('준비가 아직 완료되지')
    vi.mocked(preparePush).mockResolvedValue({ registration, subscription: null })
    await act(async () => { workers.dispatchEvent(new Event('controllerchange')) })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('서버 미등록')
    expect(button('이 기기에서 알림 켜기').disabled).toBe(false)
  })

  it('keeps offline or unverified accounts from changing server registration', async () => {
    online = false
    await render()
    await notificationsTab()
    expect(verifyPushRegistration).not.toHaveBeenCalled()
    expect(button('서버에 다시 등록').disabled).toBe(true)
    expect(button('알림 끄기').disabled).toBe(true)
    expect(button('등록 다시 확인').disabled).toBe(true)
    expect(container.textContent).toContain('온라인에서 로그인을 확인한 뒤')
    expect(container.textContent).not.toContain('서버 등록 완료')
  })

  it('passes the displayed owner to disabling and ignores refocus while a mutation is pending', async () => {
    let finishDisable!: () => void
    vi.mocked(disablePush).mockReturnValueOnce(new Promise(resolve => { finishDisable = resolve }))
    await render()
    await notificationsTab()
    await act(async () => { button('알림 끄기').click() })
    expect(disablePush).toHaveBeenCalledWith(props.client, owner.id)
    const previousChecks = vi.mocked(verifyPushRegistration).mock.calls.length
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(vi.mocked(verifyPushRegistration).mock.calls.length).toBe(previousChecks)
    await act(async () => { finishDisable() })
  })
})
