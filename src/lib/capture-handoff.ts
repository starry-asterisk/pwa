import { unzipSync } from 'fflate'
import { readImageHeader } from './media'
import type { SharedCapture } from './share-inbox'

export const CAPTURE_MIME = 'application/vnd.moa.capture+zip'
export const CAPTURE_EXTENSION = '.moacapture'
export const MAX_CAPTURE_FILE_BYTES = 27 * 1024 * 1024
// Even six-byte JSON escaping stays comfortably below the note JSON quota.
export const MAX_CAPTURE_TEXT_CHARACTERS = 100_000
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_CAPTURE_IMAGE_BYTES = 25 * 1024 * 1024
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/

function fail(message = '올바른 모아 캡처 파일이 아닙니다.'): never { throw new Error(message) }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

export function isCaptureFile(file: Pick<File, 'name' | 'type'>): boolean {
  return file.name.toLowerCase().endsWith(CAPTURE_EXTENSION) || file.type === CAPTURE_MIME
}

function decodeCaptureBytes(bytes: Uint8Array): SharedCapture {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CAPTURE_FILE_BYTES) fail('모아 캡처 파일은 27MB 이하만 열 수 있습니다.')
  const seen = new Set<string>()
  let total = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter(entry) {
      if (!['manifest.json', 'image.png'].includes(entry.name) || seen.has(entry.name)) fail('캡처 파일에 허용되지 않거나 중복된 항목이 있습니다.')
      seen.add(entry.name)
      const limit = entry.name === 'manifest.json' ? MAX_MANIFEST_BYTES : MAX_CAPTURE_IMAGE_BYTES
      if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize <= 0 || entry.originalSize > limit) fail('캡처 파일 안의 데이터가 너무 큽니다.')
      total += entry.originalSize
      if (total > MAX_CAPTURE_FILE_BYTES) fail('캡처 파일의 전체 크기가 너무 큽니다.')
      return true
    } })
  } catch (error) {
    if (error instanceof Error && /캡처/.test(error.message)) throw error
    fail('모아 캡처 파일을 읽을 수 없습니다. 파일이 손상되지 않았는지 확인해 주세요.')
  }
  const manifest = files['manifest.json']
  const png = files['image.png']
  if (Object.keys(files).length !== 2 || !manifest || !png || manifest.length > MAX_MANIFEST_BYTES || png.length > MAX_CAPTURE_IMAGE_BYTES) fail('캡처 파일의 메모 또는 이미지가 없습니다.')
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest)) } catch { fail('캡처 파일의 메모 정보를 읽을 수 없습니다.') }
  if (!record(raw) || !exactKeys(raw, ['format', 'schemaVersion', 'id', 'createdAt', 'title', 'text', 'image'])
    || raw.format !== 'moa-capture' || raw.schemaVersion !== 1 || typeof raw.id !== 'string' || !UUID_V4.test(raw.id)
    || typeof raw.createdAt !== 'string' || !ISO_DATE.test(raw.createdAt) || !Number.isFinite(Date.parse(raw.createdAt))
    || typeof raw.title !== 'string' || raw.title.length > 200 || typeof raw.text !== 'string' || raw.text.length > MAX_CAPTURE_TEXT_CHARACTERS
    || !record(raw.image) || !exactKeys(raw.image, ['path', 'name', 'mime', 'size', 'width', 'height'])) fail('캡처 파일의 형식이나 메모 정보가 올바르지 않습니다.')
  const image = raw.image
  if (image.path !== 'image.png' || image.name !== 'capture.png' || image.mime !== 'image/png'
    || !Number.isSafeInteger(image.size) || image.size !== png.length
    || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)) fail('캡처 이미지의 정보가 올바르지 않습니다.')
  const header = readImageHeader(png)
  if (header.format !== 'png' || header.width !== image.width || header.height !== image.height) fail('캡처 이미지의 형식이나 해상도가 일치하지 않습니다.')
  return {
    id: raw.id.toLowerCase(), title: raw.title, text: raw.text, createdAt: raw.createdAt,
    files: [new File([new Uint8Array(png)], 'capture.png', { type: 'image/png', lastModified: Date.parse(raw.createdAt) })],
  }
}

async function captureBytes(file: File): Promise<Uint8Array> {
  if (!isCaptureFile(file)) fail('모아에서 만든 .moacapture 파일을 선택해 주세요.')
  if (file.size === 0 || file.size > MAX_CAPTURE_FILE_BYTES) fail('모아 캡처 파일은 27MB 이하만 열 수 있습니다.')
  return new Uint8Array(await file.arrayBuffer())
}

export async function decodeCaptureFile(file: File): Promise<SharedCapture> {
  return decodeCaptureBytes(await captureBytes(file))
}

/**
 * Stages into the same inbox used by the OS share target. Native capture IDs are
 * immutable: an atomic add/check prevents another window replacing a pending
 * capture with a different package using the same UUID.
 */
async function stageCapture(capture: SharedCapture, digest: string): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('moa-share-inbox', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('captures', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let conflict = false
      const transaction = database.transaction('captures', 'readwrite')
      const store = transaction.objectStore('captures')
      const existing = store.get(capture.id)
      existing.onsuccess = () => {
        if (existing.result) {
          if (existing.result.nativeDigest !== digest) { conflict = true; transaction.abort() }
        } else store.add({ ...capture, nativeDigest: digest })
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('캡처를 이 기기에 보관하지 못했습니다.'))
      transaction.onabort = () => reject(conflict ? new Error('같은 식별자를 가진 다른 캡처가 있습니다. 원래 캡처 파일을 다시 선택해 주세요.')
        : transaction.error || new Error('캡처를 이 기기에 보관하지 못했습니다.'))
    })
  } finally { database.close() }
}

/** Validates everything before writing. App owns account checks and atomic note creation. */
export async function receiveCaptureFile(file: File): Promise<SharedCapture> {
  const bytes = await captureBytes(file)
  const capture = decodeCaptureBytes(bytes)
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map(value => value.toString(16).padStart(2, '0')).join('')
  await stageCapture(capture, digest)
  return capture
}

export interface CaptureLaunchQueue {
  setConsumer: (consumer: (parameters: { files?: readonly { getFile: () => Promise<File> }[] }) => void) => void
}
export interface CaptureFileListener {
  onCapture: (capture: SharedCapture) => void
  onError: (error: Error) => void
}
type LaunchEvent = { capture: SharedCapture } | { error: Error }
const dispatchers = new WeakMap<CaptureLaunchQueue, { listeners: Set<CaptureFileListener>; pending: LaunchEvent[] }>()

/** Subscribing never opens files or requests extra filesystem/network permissions. */
export function listenForCaptureFiles(listener: CaptureFileListener, suppliedQueue?: CaptureLaunchQueue): () => void {
  const queue = suppliedQueue ?? (typeof window === 'undefined' ? undefined
    : (window as unknown as { launchQueue?: CaptureLaunchQueue }).launchQueue)
  if (!queue) return () => {}
  let dispatcher = dispatchers.get(queue)
  if (!dispatcher) {
    dispatcher = { listeners: new Set(), pending: [] }
    dispatchers.set(queue, dispatcher)
    const state = dispatcher
    let work = Promise.resolve()
    const emit = (event: LaunchEvent) => {
      if (!state.listeners.size) { state.pending.push(event); return }
      for (const subscriber of state.listeners) {
        try { if ('capture' in event) subscriber.onCapture(event.capture); else subscriber.onError(event.error) } catch { /* A remount can retry the durable inbox item. */ }
      }
    }
    queue.setConsumer(parameters => {
      work = work.catch(() => {}).then(async () => {
        const handles = parameters.files ?? []
        if (!handles.length) return
        if (handles.length > 10) { emit({ error: new Error('모아 캡처 파일은 한 번에 10개까지 열 수 있습니다.') }); return }
        for (const handle of handles) {
          try {
            if (!handle || typeof handle.getFile !== 'function') fail('열 수 없는 캡처 파일입니다.')
            emit({ capture: await receiveCaptureFile(await handle.getFile()) })
          } catch (error) {
            emit({ error: error instanceof Error ? error : new Error('모아 캡처 파일을 열지 못했습니다.') })
          }
        }
      })
    })
  }
  dispatcher.listeners.add(listener)
  for (const event of dispatcher.pending.splice(0)) {
    if ('capture' in event) listener.onCapture(event.capture)
    else listener.onError(event.error)
  }
  return () => { dispatcher.listeners.delete(listener) }
}
