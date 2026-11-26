import Dexie, { type Table } from 'dexie'
import type { Attachment, Note, NoteContent, StoredAttachment } from '../types'

export interface Setting { key: string; value: unknown }
interface NotePurge { id: string; ownerId: string }
interface PendingPurge extends NotePurge { attachmentNames: string[] }
type NotePurgeKey = [ownerId: string, id: string]
class MoaDatabase extends Dexie {
  notes!: Table<Note, string>
  images!: Table<StoredAttachment, string>
  settings!: Table<Setting, string>
  pendingPurges!: Table<PendingPurge, NotePurgeKey>
  tombstones!: Table<NotePurge, NotePurgeKey>
  constructor() {
    super('moa-notes')
    this.version(1).stores({ notes: 'id, updatedAt, *tags, cloudOwnerId', images: 'id', settings: 'key' })
    this.version(2).stores({ pendingPurges: '[ownerId+id], ownerId', tombstones: '[ownerId+id]' })
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
export async function createNote(ownerId: string | null = null, initial: Partial<NoteContent> = {}, noteId: string = crypto.randomUUID()): Promise<Note> {
  const now = new Date().toISOString()
  const note: Note = {
    id: noteId, title: '', body: '', tags: [], pinned: false,
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
export function attachmentMetadata(file: StoredAttachment): Attachment {
  const { blob: _blob, ...metadata } = file
  return metadata
}
export async function attachFiles(noteId: string, files: StoredAttachment[]): Promise<void> {
  const deviceId = await getDeviceId()
  await db.transaction('rw', db.notes, db.images, async () => {
    const note = await db.notes.get(noteId)
    if (!note) throw new Error('메모를 찾을 수 없습니다.')
    await db.images.bulkPut(files)
    await db.notes.put({ ...note, attachments: [...note.attachments, ...files.map(attachmentMetadata)],
      updatedAt: new Date().toISOString(), version: crypto.randomUUID(), originDeviceId: deviceId, dirty: true })
  })
}
export async function removeAttachment(noteId: string, imageId: string): Promise<void> {
  const note = await db.notes.get(noteId)
  if (note) await updateNote(noteId, { attachments: note.attachments.filter(image => image.id !== imageId) })
}
export async function trashNotes(ids: string[], ownerId: string | null): Promise<number> {
  const deviceId = await getDeviceId()
  const now = new Date().toISOString()
  return db.transaction('rw', db.notes, async () => {
    const notes = (await db.notes.bulkGet([...new Set(ids)])).filter((note): note is Note =>
      note !== undefined && (note.cloudOwnerId === null || note.cloudOwnerId === ownerId) && note.deletedAt === null)
    await db.notes.bulkPut(notes.map(note => ({
      ...note, deletedAt: now, pinned: false, updatedAt: now, version: crypto.randomUUID(), originDeviceId: deviceId, dirty: true,
    })))
    return notes.length
  })
}

export const imageMarker = (ownerId: string, id: string) => `uploaded-image:${ownerId}:${id}`

export function attachmentPath(ownerId: string, attachment: Attachment): string {
  const extension = attachment.mime === 'video/mp4' ? 'mp4' : 'webp'
  return `${ownerId}/${attachment.id}.${extension}`
}

export async function removeUnusedAttachments(candidates: Array<Pick<Note, 'attachments' | 'cloudOwnerId'>>): Promise<void> {
  const detached = new Set(candidates.flatMap(note => note.attachments.map(attachment => attachment.id)))
  if (!detached.size) return
  await db.notes.each(note => {
    for (const attachment of note.attachments) detached.delete(attachment.id)
  })
  await db.images.bulkDelete([...detached])
  const markers = candidates.flatMap(note => {
    const ownerId = note.cloudOwnerId
    return ownerId ? note.attachments.filter(attachment => detached.has(attachment.id))
      .map(attachment => imageMarker(ownerId, attachment.id)) : []
  })
  await db.settings.bulkDelete(markers)
}

async function removePurgedNotes(notes: Note[]): Promise<void> {
  if (!notes.length) return
  await db.notes.bulkDelete(notes.map(note => note.id))
  await removeUnusedAttachments(notes)
}

export async function purgeNotes(ids: string[], ownerId: string | null): Promise<number> {
  return db.transaction('rw', [db.notes, db.images, db.settings, db.tombstones, db.pendingPurges], async () => {
    const notes = (await db.notes.bulkGet([...new Set(ids)])).filter((note): note is Note =>
      note !== undefined && (note.cloudOwnerId === null || note.cloudOwnerId === ownerId) && note.deletedAt !== null)
    if (ownerId) {
      const cloudNotes = notes.filter(note => note.cloudOwnerId === ownerId)
      await db.pendingPurges.bulkPut(cloudNotes.map(note => ({
        id: note.id, ownerId, attachmentNames: note.attachments.map(attachment => attachmentPath(ownerId, attachment)),
      })))
      await db.tombstones.bulkPut(cloudNotes.map(note => ({ id: note.id, ownerId })))
    }
    await removePurgedNotes(notes)
    return notes.length
  })
}

/** Keep a local marker so an older in-flight download in another tab cannot restore a removed note. */
export async function applyCloudPurges(ownerId: string, ids: string[]): Promise<number> {
  return db.transaction('rw', [db.notes, db.images, db.settings, db.tombstones], async () => {
    const notes = (await db.notes.bulkGet(ids)).filter((note): note is Note =>
      note !== undefined && note.cloudOwnerId === ownerId)
    const keys: NotePurgeKey[] = ids.map(id => [ownerId, id])
    const existing = await db.tombstones.bulkGet(keys)
    await db.tombstones.bulkPut(ids.flatMap((id, index) => existing[index] ? [] : [{ ownerId, id }]))
    await removePurgedNotes(notes)
    return notes.length
  })
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
