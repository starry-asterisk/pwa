import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { CAPTURE_MIME, decodeCaptureFile, isCaptureFile, listenForCaptureFiles, MAX_CAPTURE_FILE_BYTES, receiveCaptureFile, type CaptureLaunchQueue } from './capture-handoff'
import { deleteCapture, readCapture, storeCapture } from './share-inbox'
import { db } from './db'

const captureId = '30000000-0000-4000-8000-000000000001'
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=='), value => value.charCodeAt(0))
function manifest(overrides: Record<string, unknown> = {}) {
  return { format: 'moa-capture', schemaVersion: 1, id: captureId,
    createdAt: '2026-11-25T01:02:03.1234567+00:00', title: '화면에서 담은 기록', text: '선택한 원문\n과 캡처를 함께 담습니다.',
    image: { path: 'image.png', name: 'capture.png', mime: 'image/png', size: png.length, width: 1, height: 1 }, ...overrides }
}
function captureFile(value = manifest(), extras: Zippable = {}, filename = 'screen.moacapture') {
  const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(value)), 'image.png': png, ...extras }, { level: 0 })
  return new File([new Uint8Array(bytes)], filename, { type: CAPTURE_MIME })
}

beforeEach(async () => { await deleteCapture(captureId); await db.notes.clear(); await db.images.clear(); await db.settings.clear() })

describe('Windows capture file handoff', () => {
  it('returns a strict capture UUID and preserves the complete text and original PNG', async () => {
    const capture = await decodeCaptureFile(captureFile())
    expect(capture).toMatchObject({ id: captureId, title: '화면에서 담은 기록', text: '선택한 원문\n과 캡처를 함께 담습니다.' })
    expect(capture.files).toHaveLength(1)
    expect(capture.files[0].type).toBe('image/png')
    expect(capture.files[0].name).toBe('capture.png')
    expect(new Uint8Array(await capture.files[0].arrayBuffer())).toEqual(png)
    expect(await readCapture(captureId)).toBeUndefined()
    expect(isCaptureFile({ name: 'CAPTURE.MOACAPTURE', type: '' })).toBe(true)
    expect(isCaptureFile({ name: 'backup.zip', type: 'application/zip' })).toBe(false)
  })

  it('stages a validated capture without creating notes, signing in, or putting content in a URL', async () => {
    const capture = await receiveCaptureFile(captureFile())
    const staged = await readCapture(capture.id)
    expect(staged).toMatchObject({ id: captureId, title: capture.title, text: capture.text })
    expect(staged?.files).toHaveLength(1)
    expect(await db.notes.count()).toBe(0)
    expect(await db.settings.count()).toBe(0)
  })

  it('accepts an identical retry but never replaces a pending capture with different content under the same ID', async () => {
    const file = captureFile()
    await receiveCaptureFile(file)
    await receiveCaptureFile(file)
    await expect(receiveCaptureFile(captureFile(manifest({ text: '다른 내용' })))).rejects.toThrow('같은 식별자')
    expect((await readCapture(captureId))?.text).toBe(manifest().text)
  })

  it('atomically permits only one of two simultaneous packages using the same capture ID', async () => {
    const results = await Promise.allSettled([
      receiveCaptureFile(captureFile(manifest({ text: '첫 캡처' }))),
      receiveCaptureFile(captureFile(manifest({ text: '서로 다른 캡처' }))),
    ])
    const saved = results.find(result => result.status === 'fulfilled')
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await readCapture(captureId))?.text).toBe(saved?.status === 'fulfilled' ? saved.value.text : undefined)
  })

  it('does not overwrite a regular OS share that happens to use the same ID', async () => {
    await storeCapture({ id: captureId, title: '기존 공유', text: '보존할 원문', files: [], createdAt: new Date().toISOString() })
    await expect(receiveCaptureFile(captureFile())).rejects.toThrow('같은 식별자')
    expect((await readCapture(captureId))?.text).toBe('보존할 원문')
  })

  it('rejects malformed identifiers, unexpected fields, image mismatches and unsupported versions before persistence', async () => {
    const valid = manifest()
    for (const value of [
      manifest({ id: 'not-a-uuid' }), manifest({ id: '30000000-0000-0000-0000-000000000001' }),
      manifest({ schemaVersion: 2 }), manifest({ createdAt: 'not a date' }),
      manifest({ title: '가'.repeat(201) }), manifest({ text: '가'.repeat(100_001) }),
      manifest({ owner_id: 'must-not-choose-an-account' }),
      manifest({ image: { ...valid.image, path: '../private.png' } }),
      manifest({ image: { ...valid.image, size: png.length + 1 } }),
      manifest({ image: { ...valid.image, width: 2 } }),
      manifest({ image: { ...valid.image, mime: 'image/jpeg' } }),
    ]) await expect(receiveCaptureFile(captureFile(value))).rejects.toThrow()
    expect(await readCapture(captureId)).toBeUndefined()
    expect(await db.notes.count()).toBe(0)
  })

  it('rejects unknown ZIP paths, missing files, oversized archives and compressed manifest bombs', async () => {
    await expect(decodeCaptureFile(captureFile(manifest(), { '../outside.txt': strToU8('not allowed') }))).rejects.toThrow('허용되지')
    const missing = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest())) })
    await expect(decodeCaptureFile(new File([new Uint8Array(missing)], 'missing.moacapture'))).rejects.toThrow('이미지가 없습니다')
    await expect(decodeCaptureFile(new File([new Uint8Array(MAX_CAPTURE_FILE_BYTES + 1)], 'large.moacapture'))).rejects.toThrow('27MB')
    const bomb = zipSync({ 'manifest.json': new Uint8Array(2 * 1024 * 1024 + 1), 'image.png': png }, { level: 9 })
    await expect(decodeCaptureFile(new File([new Uint8Array(bomb)], 'bomb.moacapture'))).rejects.toThrow('데이터가 너무 큽니다')
    await expect(decodeCaptureFile(new File(['not a zip'], 'invalid.moacapture'))).rejects.toThrow('읽을 수 없습니다')
  })
})

describe('installed PWA file launches', () => {
  it('keeps one launch consumer across StrictMode remounts and delivers after durable staging', async () => {
    let consumer!: Parameters<CaptureLaunchQueue['setConsumer']>[0]
    const queue: CaptureLaunchQueue = { setConsumer: vi.fn(value => { consumer = value }) }
    const first = { onCapture: vi.fn(), onError: vi.fn() }
    const stop = listenForCaptureFiles(first, queue)
    stop()
    consumer({ files: [{ getFile: async () => captureFile() }] })
    await vi.waitFor(async () => { expect(await readCapture(captureId)).toBeDefined() })
    const next = { onCapture: vi.fn(), onError: vi.fn() }
    const unsubscribe = listenForCaptureFiles(next, queue)
    await vi.waitFor(() => { expect(next.onCapture).toHaveBeenCalledTimes(1) })
    expect(first.onCapture).not.toHaveBeenCalled()
    expect(next.onCapture.mock.calls[0][0].id).toBe(captureId)
    expect(queue.setConsumer).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('reports a malformed launch as an error and preserves valid later files', async () => {
    let consumer!: Parameters<CaptureLaunchQueue['setConsumer']>[0]
    const queue: CaptureLaunchQueue = { setConsumer: value => { consumer = value } }
    const listener = { onCapture: vi.fn(), onError: vi.fn() }
    const stop = listenForCaptureFiles(listener, queue)
    consumer({ files: [
      { getFile: async () => new File(['invalid'], 'bad.moacapture') },
      { getFile: async () => captureFile() },
    ] })
    await vi.waitFor(() => { expect(listener.onCapture).toHaveBeenCalledTimes(1) })
    expect(listener.onError).toHaveBeenCalledTimes(1)
    expect(await db.notes.count()).toBe(0)
    stop()
  })
})
