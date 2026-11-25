import { beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { db, createNote } from './db'
import { createBackupBlob, decodeBackup, importBackup } from './backup'

const now = '2026-11-24T00:00:00.000Z'
function manifest(notes: unknown[] = [], images: unknown[] = []) {
  return { format: 'moa-backup', schemaVersion: 1, exportedAt: now, notes, images }
}
function note() {
  return {
    id: crypto.randomUUID(), version: crypto.randomUUID(), title: '나의 기록', body: '메모 내용',
    tags: ['일상'], pinned: true, createdAt: now, updatedAt: now, deletedAt: null, attachments: [],
  }
}
function backupFile(data: Uint8Array): File {
  return new File([new Uint8Array(data)], 'backup.zip', { type: 'application/zip' })
}

beforeEach(async () => {
  await db.notes.clear()
  await db.images.clear()
  await db.settings.clear()
})

describe('portable backups', () => {
  it('exports note contents without device credentials or cloud ownership', async () => {
    const source = await createNote(crypto.randomUUID(), { title: '백업할 메모', body: '안전한 본문' })
    await db.settings.put({ key: 'cloud-config', value: { anonKey: 'do-not-export-this', url: 'https://secret.invalid' } })
    const blob = await createBackupBlob(source.cloudOwnerId)
    const decoded = decodeBackup(new Uint8Array(await blob.arrayBuffer()))
    expect(decoded.manifest.notes[0].title).toBe(source.title)
    expect(decoded.manifest.notes[0]).not.toHaveProperty('cloudOwnerId')
    expect(decoded.manifest.notes[0]).not.toHaveProperty('originDeviceId')
    expect(JSON.stringify(decoded.manifest)).not.toContain('do-not-export-this')
  })
  it('exports only local notes and the selected owner’s notes with their referenced images', async () => {
    const ownerId = crypto.randomUUID()
    const otherOwnerId = crypto.randomUUID()
    async function addImage(name: string) {
      const bytes = new Uint8Array(30)
      const view = new DataView(bytes.buffer)
      bytes.set(new TextEncoder().encode('RIFF'), 0)
      view.setUint32(4, 22, true)
      bytes.set(new TextEncoder().encode('WEBPVP8X'), 8)
      view.setUint32(16, 10, true)
      const attachment = { id: crypto.randomUUID(), name, size: bytes.length,
        width: 1, height: 1, mime: 'image/webp' as const, createdAt: now }
      await db.images.put({ ...attachment, blob: new Blob([bytes], { type: 'image/webp' }) })
      return attachment
    }
    const localImage = await addImage('로컬.webp')
    const ownImage = await addImage('현재 계정.webp')
    const hiddenImage = await addImage('숨긴 다른 계정.webp')
    const orphanImage = await addImage('메모에서 참조하지 않는 이미지.webp')
    const local = await createNote(null, { title: '로컬 메모', attachments: [localImage] })
    const own = await createNote(ownerId, { title: '현재 계정 메모', attachments: [ownImage] })
    const hidden = await createNote(otherOwnerId, { title: '숨긴 다른 계정 메모', attachments: [hiddenImage] })

    const loggedIn = decodeBackup(new Uint8Array(await (await createBackupBlob(ownerId)).arrayBuffer()))
    expect(loggedIn.manifest.notes.map(note => note.id).sort()).toEqual([local.id, own.id].sort())
    expect(loggedIn.manifest.images.map(image => image.id).sort()).toEqual([localImage.id, ownImage.id].sort())
    expect(loggedIn.files[`images/${hiddenImage.id}.webp`]).toBeUndefined()
    expect(loggedIn.files[`images/${orphanImage.id}.webp`]).toBeUndefined()
    expect(JSON.stringify(loggedIn.manifest)).not.toContain(hidden.title)

    const loggedOut = decodeBackup(new Uint8Array(await (await createBackupBlob()).arrayBuffer()))
    expect(loggedOut.manifest.notes.map(note => note.id)).toEqual([local.id])
    expect(loggedOut.manifest.images.map(image => image.id)).toEqual([localImage.id])
    expect(loggedOut.files[`images/${ownImage.id}.webp`]).toBeUndefined()
    expect(await db.notes.count()).toBe(3)
  })
  it('imports with new IDs and preserves an existing note with the same source ID', async () => {
    const existing = await createNote(null, { title: '기존 메모', body: '덮어쓰면 안 되는 내용' })
    const imported = { ...note(), id: existing.id }
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest([imported]))) })
    const result = await importBackup(backupFile(bytes))
    expect(result).toEqual({ notes: 1, images: 0 })
    expect((await db.notes.get(existing.id))?.body).toBe('덮어쓰면 안 되는 내용')
    const copy = (await db.notes.toArray()).find((entry) => entry.id !== existing.id)!
    expect(copy.title).toBe(imported.title)
    expect(copy.dirty).toBe(true)
    expect(copy.baseVersion).toBeNull()
    expect(copy.cloudOwnerId).toBeNull()
  })
  it('round-trips a recording backup with a new attachment ID', async () => {
    const bytes = new Uint8Array(34)
    const view = new DataView(bytes.buffer)
    view.setUint32(0, 16)
    view.setUint32(4, 0x66747970)
    view.setUint32(16, 9)
    view.setUint32(20, 0x6d6f6f76)
    view.setUint32(25, 9)
    view.setUint32(29, 0x6d646174)
    const original = { id: crypto.randomUUID(), name: 'recording.mp4', size: bytes.length,
      width: 640, height: 360, mime: 'video/mp4' as const, createdAt: now }
    await db.images.put({ ...original, blob: new Blob([bytes], { type: original.mime }) })
    const source = await createNote(null, { title: '녹화 메모', attachments: [original] })

    const backup = await createBackupBlob()
    const result = await importBackup(backupFile(new Uint8Array(await backup.arrayBuffer())))
    expect(result).toEqual({ notes: 1, images: 0, recordings: 1 })
    const copy = (await db.notes.toArray()).find(note => note.id !== source.id)
    expect(copy?.attachments[0]).toMatchObject({ name: original.name, mime: original.mime })
    expect(copy?.attachments[0].id).not.toBe(original.id)
    const recovered = await db.images.get(copy!.attachments[0].id)
    expect(new Uint8Array(await recovered!.blob.arrayBuffer())).toEqual(bytes)
  })

  it('validates the entire archive before importing any note', async () => {
    await createNote(null, { title: '유지되는 메모' })
    const invalid = { ...note(), attachments: [{ id: crypto.randomUUID() }] }
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest([note(), invalid]))) })
    await expect(importBackup(backupFile(bytes))).rejects.toThrow('이미지 정보')
    expect(await db.notes.count()).toBe(1)
    expect(await db.images.count()).toBe(0)
  })
  it('rejects unexpected paths in an archive', () => {
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest())), '../settings.json': strToU8('{}') })
    expect(() => decodeBackup(bytes)).toThrow('허용되지 않은 파일 경로')
  })
  it('rejects a forged expansion size before attempting decompression', () => {
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest())) })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let found = false
    for (let offset = 0; offset < bytes.length - 28; offset += 1) {
      if (view.getUint32(offset, true) === 0x02014b50) {
        view.setUint32(offset + 24, 151 * 1024 * 1024, true)
        found = true
        break
      }
    }
    expect(found).toBe(true)
    expect(() => decodeBackup(bytes)).toThrow('너무 큽니다')
  })
})
