/// <reference lib="WebWorker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { clientsClaim } from 'workbox-core'
import { storeCapture } from './lib/share-inbox'
import { ShareValidationError, validateSharedForm } from './lib/share-validation'
import { describeNotePush, readPushPreviewOwner } from './lib/push-message'
import { getPushPreviewOwner } from './lib/push-preview-owner'

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{url: string; revision: string | null}> }
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
clientsClaim()
registerRoute(new NavigationRoute(createHandlerBoundToURL(`${import.meta.env.BASE_URL}index.html`)))
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== `${import.meta.env.BASE_URL}share`) return
  event.respondWith((async () => {
    const form = await event.request.formData()
    const { files, text, title } = validateSharedForm(form)
    const id = crypto.randomUUID()
    await storeCapture({ id, title, text, files, createdAt: new Date().toISOString() })
    return Response.redirect(new URL(`${import.meta.env.BASE_URL}?capture=${id}`, self.location.origin).href, 303)
  })().catch(error => error instanceof ShareValidationError
    ? new Response(error.message, { status: error.status })
    : new Response('공유한 내용을 저장하지 못했습니다. 앱을 열어 다시 시도하세요.', { status: 500 })))
})
self.addEventListener('push', event => {
  let data: unknown
  try { data = event.data?.json() } catch { /* A generic notification is still useful. */ }
  event.waitUntil((async () => {
    const owner = readPushPreviewOwner(data) ? await getPushPreviewOwner().catch(() => null) : null
    const { noteId, title, body } = describeNotePush(data, owner)
    await self.registration.showNotification(title, {
      body,
      icon: `${import.meta.env.BASE_URL}icon-192.png`,
      badge: `${import.meta.env.BASE_URL}icon-192.png`,
      tag: noteId ? `note-${noteId}` : 'moa-new-note',
      data: { noteId },
    })
  })())
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const url = new URL(self.registration.scope)
    if (event.notification.data?.noteId) url.searchParams.set('note', event.notification.data.noteId)
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const existing = windows.find(client => new URL(client.url).pathname.startsWith(new URL(self.registration.scope).pathname))
    if (existing) {
      await existing.focus()
      existing.postMessage({ type: 'OPEN_NOTE', noteId: event.notification.data?.noteId })
    } else await self.clients.openWindow(url.href)
  })())
})
