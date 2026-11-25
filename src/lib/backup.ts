import { strFromU8, strToU8, unzipSync, zip, type AsyncZippable } from 'fflate'
import { attachmentMetadata, db, getDeviceId } from './db'
import { downloadBlob, MAX_IMAGE_BYTES, MAX_STORED_IMAGE_BYTES, readImageHeader } from './media'
import { isMp4, MAX_RECORDING_BYTES, validRecordingDimensions } from './recording'
import type { Attachment, Note, NoteContent, StoredAttachment } from '../types'

export const MAX_BACKUP_BYTES = 50 * 1024 * 1024
const MAX_UNPACKED_BYTES = 150 * 1024 * 1024
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024
const MAX_NOTES = 10_000
const MAX_ATTACHMENTS = 10_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type BackupNote = NoteContent & { id: string; version: string }
interface BackupManifest {
  format: 'moa-backup'
  schemaVersion: 1 | 2
  exportedAt: string
  notes: BackupNote[]
  images: Attachment[]
  videos?: Attachment[]
}
interface DecodedBackup {
  manifest: BackupManifest
  files: Record<string, Uint8Array>
}

function fail(message = '올바른 모아 백업 파일이 아닙니다.'): never { throw new Error(message) }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function validString(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max }
function validId(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }
function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}
function validateAttachment(value: unknown): Attachment {
  if (!record(value) || !validId(value.id) || !validString(value.name, 255) || (value.mime !== 'image/webp' && value.mime !== 'video/mp4')
    || !Number.isSafeInteger(value.size) || (value.size as number) < 1 || (value.size as number) > MAX_STORED_IMAGE_BYTES
    || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || (value.width as number) < 1 || (value.height as number) < 1
    || (value.width as number) > 16_383 || (value.height as number) > 16_383
    || (value.width as number) * (value.height as number) > 40_000_000 || !validDate(value.createdAt)) fail('백업의 이미지 정보가 올바르지 않습니다.')
  if (value.mime === 'video/mp4' && ((value.size as number) < 16
    || !validRecordingDimensions(value.width as number, value.height as number))) fail('백업의 녹화 정보가 올바르지 않습니다.')
  return {
    id: value.id, name: value.name, size: value.size as number,
    width: value.width as number, height: value.height as number,
    mime: value.mime, createdAt: value.createdAt,
  }
}
function attachmentPath(file: Attachment): string {
  return file.mime === 'video/mp4' ? `videos/${file.id}.mp4` : `images/${file.id}.webp`
}
function sameAttachment(a: Attachment, b: Attachment): boolean {
  return a.id === b.id && a.mime === b.mime && a.size === b.size && a.width === b.width && a.height === b.height && a.name === b.name && a.createdAt === b.createdAt
}
function validateNote(value: unknown): BackupNote {
  if (!record(value) || !validId(value.id) || !validId(value.version)
    || !validString(value.title, 200) || !validString(value.body, 500_000)
    || typeof value.pinned !== 'boolean' || !validDate(value.createdAt) || !validDate(value.updatedAt)
    || (value.deletedAt !== null && !validDate(value.deletedAt)) || !Array.isArray(value.tags)
    || value.tags.length > 20 || !value.tags.every((tag) => validString(tag, 40))
    || !Array.isArray(value.attachments) || value.attachments.length > 100) fail('백업의 메모 정보가 올바르지 않습니다.')
  const attachments = value.attachments.map(validateAttachment)
  if (new Set(attachments.map((image) => image.id)).size !== attachments.length) fail('백업에 중복된 첨부 정보가 있습니다.')
  return {
    id: value.id, version: value.version, title: value.title, body: value.body,
    pinned: value.pinned, createdAt: value.createdAt, updatedAt: value.updatedAt,
    deletedAt: value.deletedAt as string | null, tags: [...value.tags] as string[], attachments,
  }
}
function portableNote(note: Note): BackupNote {
  return {
    id: note.id, version: note.version, title: note.title, body: note.body,
    tags: [...note.tags], pinned: note.pinned, createdAt: note.createdAt,
    updatedAt: note.updatedAt, deletedAt: note.deletedAt,
    attachments: note.attachments.map((image) => ({ ...image })),
  }
}
/** Validates all entries before the caller writes anything to IndexedDB. */
export function decodeBackup(bytes: Uint8Array): DecodedBackup {
  if (bytes.byteLength > MAX_BACKUP_BYTES) fail('백업 파일은 50MB 이하만 가져올 수 있습니다.')
  const seen = new Set<string>()
  let total = 0
  let count = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (entry) => {
        count += 1
        if (count > MAX_ATTACHMENTS + 1 || seen.has(entry.name)) fail('백업 파일의 항목 수 또는 이름이 올바르지 않습니다.')
        seen.add(entry.name)
        const validPath = entry.name === 'manifest.json' || /^images\/[0-9a-f-]{36}\.webp$/i.test(entry.name)
        const videoPath = /^videos\/[0-9a-f-]{36}\.mp4$/i.test(entry.name)
        if (!validPath && !videoPath) fail('백업에 허용되지 않은 파일 경로가 있습니다.')
        const limit = entry.name === 'manifest.json' ? MAX_MANIFEST_BYTES : videoPath ? MAX_RECORDING_BYTES : MAX_IMAGE_BYTES
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > limit) fail('백업 안의 파일이 너무 큽니다.')
        total += entry.originalSize
        if (total > MAX_UNPACKED_BYTES) fail('백업의 압축 해제 크기가 150MB를 초과합니다.')
        return true
      },
    })
  } catch (error) {
    if (error instanceof Error && /백업/.test(error.message)) throw error
    fail('ZIP 백업을 읽을 수 없습니다. 파일이 손상되지 않았는지 확인해 주세요.')
  }
  const manifestFile = files['manifest.json']
  if (!manifestFile || manifestFile.byteLength > MAX_MANIFEST_BYTES) fail('백업의 메모 목록을 찾을 수 없습니다.')
  let raw: unknown
  try { raw = JSON.parse(strFromU8(manifestFile)) } catch { fail('백업의 메모 목록을 읽을 수 없습니다.') }
  if (!record(raw) || raw.format !== 'moa-backup' || (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) || !validDate(raw.exportedAt)
    || !Array.isArray(raw.notes) || raw.notes.length > MAX_NOTES
    || !Array.isArray(raw.images) || raw.images.length > MAX_ATTACHMENTS
    || (raw.schemaVersion === 1 ? raw.videos !== undefined
      : !Array.isArray(raw.videos) || raw.videos.length + raw.images.length > MAX_ATTACHMENTS)) fail()
  const notes = raw.notes.map(validateNote)
  const images = raw.images.map(validateAttachment)
  const videos = Array.isArray(raw.videos) ? raw.videos.map(validateAttachment) : []
  if (images.some(file => file.mime !== 'image/webp') || videos.some(file => file.mime !== 'video/mp4')) fail('백업의 첨부 파일 형식이 올바르지 않습니다.')
  const attachments = [...images, ...videos]
  const attachmentMap = new Map(attachments.map(file => [file.id, file]))
  if (new Set(notes.map(note => note.id)).size !== notes.length || attachmentMap.size !== attachments.length) {
    fail('백업에 중복된 메모 또는 첨부 파일이 있습니다.')
  }
  const referenced = new Set<string>()
  for (const note of notes) for (const attachment of note.attachments) {
    const expected = attachmentMap.get(attachment.id)
    if (!expected || !sameAttachment(attachment, expected)) fail('메모의 첨부 정보가 파일과 일치하지 않습니다.')
    referenced.add(attachment.id)
  }
  if (referenced.size !== attachments.length || Object.keys(files).length !== attachments.length + 1) fail('백업의 첨부 파일 목록이 일치하지 않습니다.')
  for (const attachment of attachments) {
    const file = files[attachmentPath(attachment)]
    if (!file || file.byteLength !== attachment.size) fail('백업에 첨부 파일이 없거나 크기가 올바르지 않습니다.')
    if (attachment.mime === 'video/mp4') {
      if (!isMp4(file)) fail('백업 녹화의 파일 형식이 올바르지 않습니다.')
    } else {
      const header = readImageHeader(file)
      if (header.format !== 'webp' || header.width !== attachment.width || header.height !== attachment.height) fail('백업 이미지의 형식 또는 해상도가 일치하지 않습니다.')
    }
  }
  return {
    manifest: { format: 'moa-backup', schemaVersion: raw.schemaVersion, exportedAt: raw.exportedAt, notes, images,
      ...(raw.schemaVersion === 2 ? { videos } : {}) },
    files,
  }
}

export async function createBackupBlob(ownerId: string | null = null): Promise<Blob> {
  const snapshot = await db.transaction('r', db.notes, db.images, async () => {
    const notes = await db.notes.filter(note => note.cloudOwnerId === null
      || ownerId !== null && note.cloudOwnerId === ownerId).toArray()
    if (notes.length > MAX_NOTES) fail('현재 백업은 메모 10,000개까지 지원합니다.')
    const ids = [...new Set(notes.flatMap((note) => note.attachments.map((image) => image.id)))]
    if (ids.length > MAX_ATTACHMENTS) fail('현재 백업은 첨부 파일 10,000개까지 지원합니다.')
    const attachments = await db.images.bulkGet(ids)
    if (attachments.some(file => !file)) fail('아직 내려받지 않은 첨부 파일이 있습니다. 동기화한 뒤 다시 백업해 주세요.')
    return { notes, attachments: attachments as StoredAttachment[] }
  })
  const attachments = snapshot.attachments.map(file => validateAttachment(attachmentMetadata(file)))
  const images = attachments.filter(file => file.mime === 'image/webp')
  const videos = attachments.filter(file => file.mime === 'video/mp4')
  const manifest: BackupManifest = {
    format: 'moa-backup', schemaVersion: videos.length ? 2 : 1, exportedAt: new Date().toISOString(),
    notes: snapshot.notes.map(note => validateNote(portableNote(note))), images, ...(videos.length ? { videos } : {}),
  }
  const manifestBytes = strToU8(JSON.stringify(manifest))
  const payloadSize = manifestBytes.byteLength + snapshot.attachments.reduce((sum, file) => sum + file.size, 0)
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES || payloadSize > MAX_BACKUP_BYTES - 1024 * 1024) {
    fail('현재 기기 백업은 약 50MB까지 지원합니다. 첨부 파일이 많은 경우 클라우드 동기화를 함께 사용해 주세요.')
  }
  const archive: AsyncZippable = { 'manifest.json': [manifestBytes, { level: 6 }] }
  for (const file of snapshot.attachments) archive[attachmentPath(file)] = [new Uint8Array(await file.blob.arrayBuffer()), { level: 0 }]
  const bytes = await new Promise<Uint8Array>((resolve, reject) => zip(archive, (error, result) => error ? reject(error) : resolve(result)))
  if (bytes.byteLength > MAX_BACKUP_BYTES) fail('백업 파일이 50MB를 초과합니다.')
  return new Blob([new Uint8Array(bytes)], { type: 'application/zip' })
}

export async function exportBackup(ownerId: string | null = null): Promise<void> {
  const blob = await createBackupBlob(ownerId)
  downloadBlob(blob, `moa-backup-${new Date().toISOString().slice(0, 10)}.zip`)
}

export async function importBackup(file: File): Promise<{ notes: number; images: number; recordings?: number }> {
  if (file.size > MAX_BACKUP_BYTES) fail('백업 파일은 50MB 이하만 가져올 수 있습니다.')
  const { manifest, files } = decodeBackup(new Uint8Array(await file.arrayBuffer()))
  const deviceId = await getDeviceId()
  const attachments = [...manifest.images, ...(manifest.videos ?? [])]
  const attachmentIds = new Map(attachments.map(file => [file.id, crypto.randomUUID()]))
  const stored = attachments.map(file => ({
    ...file, id: attachmentIds.get(file.id)!,
    blob: new Blob([new Uint8Array(files[attachmentPath(file)])], { type: file.mime }),
  }))
  const notes: Note[] = manifest.notes.map((note) => ({
    ...note,
    id: crypto.randomUUID(), version: crypto.randomUUID(), baseVersion: null,
    dirty: true, cloudOwnerId: null, originDeviceId: deviceId,
    attachments: note.attachments.map((image) => ({ ...image, id: attachmentIds.get(image.id)! })),
  }))
  // New IDs preserve all existing notes. No cloud identity or credentials are restored.
  await db.transaction('rw', db.notes, db.images, async () => {
    await db.images.bulkAdd(stored)
    await db.notes.bulkAdd(notes)
  })
  return { notes: notes.length, images: manifest.images.length, ...(manifest.videos?.length ? { recordings: manifest.videos.length } : {}) }
}
