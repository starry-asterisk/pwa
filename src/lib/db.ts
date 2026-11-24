import Dexie, { type Table } from 'dexie'
import type { Attachment, Note, NoteContent, StoredImage } from '../types'

export interface Setting { key: string; value: unknown }
class MoaDatabase extends Dexie {
  notes!: Table<Note, string>
  images!: Table<StoredImage, string>
  settings!: Table<Setting, string>
  constructor() {
    super('moa-notes')
    this.version(1).stores({ notes: 'id, updatedAt, *tags, cloudOwnerId', images: 'id', settings: 'key' })
  }
}
export const db = new MoaDatabase()
export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key)
  return row ? row.value as T : fallback
}
export async function setSetting<T>(key: string, value: T): Promise<void> {
  await db.settings.put({ key, value })
}
export async function getDeviceId(): Promise<string> {
  return db.transaction('rw', db.settings, async () => {
    const current = await db.settings.get('device-id')
    if (typeof current?.value === 'string') return current.value
    const id = crypto.randomUUID()
    await db.settings.put({ key: 'device-id', value: id })
    return id
  })
}
export async function createNote(ownerId: string | null = null, initial: Partial<NoteContent> = {}): Promise<Note> {
  const now = new Date().toISOString()
  const note: Note = {
    id: crypto.randomUUID(), title: '', body: '', tags: [], pinned: false,
    createdAt: now, updatedAt: now, deletedAt: null, attachments: [], ...initial,
    version: crypto.randomUUID(), baseVersion: null, dirty: true,
    originDeviceId: await getDeviceId(), cloudOwnerId: ownerId,
  }
  await db.notes.add(note)
  return note
}
export async function updateNote(id: string, patch: Partial<NoteContent>): Promise<void> {
  const deviceId = await getDeviceId()
  await db.transaction('rw', db.notes, async () => {
    const current = await db.notes.get(id)
    if (!current) throw new Error('메모를 찾을 수 없습니다.')
    await db.notes.put({ ...current, ...patch, updatedAt: new Date().toISOString(),
      version: crypto.randomUUID(), originDeviceId: deviceId, dirty: true })
  })
}
export function imageMetadata(image: StoredImage): Attachment {
  const { blob: _blob, ...metadata } = image
  return metadata
}
export async function attachImages(noteId: string, images: StoredImage[]): Promise<void> {
  const deviceId = await getDeviceId()
  await db.transaction('rw', db.notes, db.images, async () => {
    const note = await db.notes.get(noteId)
    if (!note) throw new Error('메모를 찾을 수 없습니다.')
    await db.images.bulkPut(images)
    await db.notes.put({ ...note, attachments: [...note.attachments, ...images.map(imageMetadata)],
      updatedAt: new Date().toISOString(), version: crypto.randomUUID(), originDeviceId: deviceId, dirty: true })
  })
}
export async function removeAttachment(noteId: string, imageId: string): Promise<void> {
  const note = await db.notes.get(noteId)
  if (note) await updateNote(noteId, { attachments: note.attachments.filter(image => image.id !== imageId) })
}
export async function requestDurableStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  return navigator.storage.persist()
}
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(0)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}