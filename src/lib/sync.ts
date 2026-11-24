import type { SupabaseClient } from '@supabase/supabase-js'
import type { Attachment, CloudNote, Note, NoteContent, SyncReport } from '../types'
import { db, getDeviceId } from './db'

const pageSize = 200
const bucket = 'note-images'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const activeSyncs = new WeakMap<SupabaseClient, { ownerId: string; promise: Promise<SyncReport> }>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isAttachment(value: unknown): value is Attachment {
  return isRecord(value) && typeof value.id === 'string' && uuidPattern.test(value.id)
    && typeof value.name === 'string' && typeof value.size === 'number' && value.size >= 0
    && typeof value.width === 'number' && value.width > 0 && typeof value.height === 'number' && value.height > 0
    && value.mime === 'image/webp' && typeof value.createdAt === 'string'
}

function readCloudNote(value: unknown, ownerId: string): CloudNote {
  if (!isRecord(value) || value.owner_id !== ownerId || typeof value.id !== 'string' || !uuidPattern.test(value.id)
    || typeof value.version !== 'string' || !uuidPattern.test(value.version)
    || typeof value.origin_device_id !== 'string' || !uuidPattern.test(value.origin_device_id)
    || typeof value.updated_at !== 'string' || !isRecord(value.data)) {
    throw new Error('클라우드 메모의 형식 또는 계정 정보가 올바르지 않습니다.')
  }
  const content = value.data
  if (typeof content.title !== 'string' || typeof content.body !== 'string' || !Array.isArray(content.tags)
    || !content.tags.every(tag => typeof tag === 'string') || typeof content.pinned !== 'boolean'
    || typeof content.createdAt !== 'string' || typeof content.updatedAt !== 'string'
    || (content.deletedAt !== null && typeof content.deletedAt !== 'string')
    || !Array.isArray(content.attachments) || !content.attachments.every(isAttachment)) {
    throw new Error('클라우드 메모의 내용 형식이 올바르지 않습니다.')
  }
  return value as unknown as CloudNote
}

function noteContent(note: Note): NoteContent {
  return {
    title: note.title, body: note.body, tags: [...note.tags], pinned: note.pinned,
    createdAt: note.createdAt, updatedAt: note.updatedAt, deletedAt: note.deletedAt,
    attachments: note.attachments.map(attachment => ({ ...attachment })),
  }
}

function localNote(remote: CloudNote): Note {
  return {
    ...remote.data, id: remote.id, version: remote.version, baseVersion: remote.version,
    dirty: false, originDeviceId: remote.origin_device_id, cloudOwnerId: remote.owner_id,
  }
}

async function assertSession(client: SupabaseClient, ownerId: string): Promise<void> {
  const { data, error } = await client.auth.getSession()
  if (error || data.session?.user.id !== ownerId) {
    throw new Error('동기화 도중 로그인 계정이 변경되었습니다. 현재 계정으로 다시 시도해 주세요.')
  }
}

const imageMarker = (ownerId: string, id: string) => `uploaded-image:${ownerId}:${id}`

async function uploadImages(client: SupabaseClient, ownerId: string, attachments: Attachment[]): Promise<void> {
  for (const attachment of attachments) {
    if (!uuidPattern.test(attachment.id)) throw new Error('이미지 식별자가 올바르지 않습니다.')
    if ((await db.settings.get(imageMarker(ownerId, attachment.id)))?.value === true) continue
    const image = await db.images.get(attachment.id)
    if (!image) throw new Error(`이미지 원본을 찾을 수 없습니다: ${attachment.name}`)
    await assertSession(client, ownerId)
    const { error } = await client.storage.from(bucket).upload(`${ownerId}/${attachment.id}.webp`, image.blob, {
      contentType: 'image/webp', cacheControl: '31536000', upsert: false,
    })
    if (error) {
      const storageError = error as { statusCode?: string; status?: number; message: string }
      const status = String(storageError.statusCode ?? storageError.status ?? '')
      // IDs are immutable. A previous interrupted sync may already have uploaded this object.
      if (status !== '409' && !(status === '400' && /already exists|duplicate/i.test(storageError.message))) {
        throw new Error(`이미지를 업로드하지 못했습니다: ${error.message}`)
      }
    }
    await db.settings.put({ key: imageMarker(ownerId, attachment.id), value: true })
  }
}

async function downloadImages(client: SupabaseClient, ownerId: string, attachments: Attachment[]): Promise<void> {
  for (const attachment of attachments) {
    if (await db.images.get(attachment.id)) continue
    await assertSession(client, ownerId)
    const { data, error } = await client.storage.from(bucket).download(`${ownerId}/${attachment.id}.webp`)
    if (error || !data) throw new Error(`이미지를 내려받지 못했습니다: ${attachment.name}${error ? ` (${error.message})` : ''}`)
    await assertSession(client, ownerId)
    await db.images.put({ ...attachment, blob: data })
    await db.settings.put({ key: imageMarker(ownerId, attachment.id), value: true })
  }
}

/** Called only after the user explicitly connects existing local notes to this account. */
export async function adoptLocalNotes(ownerId: string): Promise<number> {
  if (!uuidPattern.test(ownerId)) throw new Error('계정 식별자가 올바르지 않습니다.')
  return db.transaction('rw', db.notes, async () => {
    const notes = await db.notes.filter(note => note.cloudOwnerId === null).toArray()
    for (const note of notes) {
      await db.notes.put({ ...note, cloudOwnerId: ownerId, baseVersion: null, dirty: true })
    }
    return notes.length
  })
}

async function runSync(client: SupabaseClient, ownerId: string): Promise<SyncReport> {
  const user = await client.auth.getUser()
  if (user.error || user.data.user?.id !== ownerId) throw new Error('로그인 계정을 확인한 뒤 다시 동기화해 주세요.')
  await assertSession(client, ownerId)
  const deviceId = await getDeviceId()
  const report: SyncReport = { uploaded: 0, downloaded: 0, conflicts: 0 }

  async function preserveConflict(snapshot: Note, remote: CloudNote): Promise<Note | null> {
    await downloadImages(client, ownerId, remote.data.attachments)
    await assertSession(client, ownerId)
    const now = new Date().toISOString()
    const copyId = crypto.randomUUID()
    const copyVersion = crypto.randomUUID()
    return db.transaction('rw', db.notes, async () => {
      const current = await db.notes.get(snapshot.id)
      // A newer keystroke must survive an in-flight request. Retry on the next sync instead.
      if (!current || current.cloudOwnerId !== ownerId || !current.dirty
        || current.version !== snapshot.version || current.baseVersion !== snapshot.baseVersion) return null
      const copy: Note = {
        ...current, id: copyId, version: copyVersion, baseVersion: null,
        title: `${(current.title || '제목 없는 메모').slice(0, 190)} (충돌 사본)`,
        createdAt: now, updatedAt: now, deletedAt: null, dirty: true, originDeviceId: deviceId,
      }
      await db.notes.put(copy)
      await db.notes.put(localNote(remote))
      return copy
    })
  }

  async function uploadNote(id: string, allowConflict = true): Promise<void> {
    const snapshot = await db.notes.get(id)
    if (!snapshot?.dirty || snapshot.cloudOwnerId !== ownerId) return
    await uploadImages(client, ownerId, snapshot.attachments)
    await assertSession(client, ownerId)
    const { data, error } = await client.rpc('save_note', {
      p_id: snapshot.id, p_data: noteContent(snapshot), p_version: snapshot.version,
      p_expected_version: snapshot.baseVersion, p_origin_device_id: snapshot.originDeviceId,
    })
    if (error) throw new Error(`메모를 동기화하지 못했습니다: ${error.message}`)
    if (!isRecord(data) || (data.status !== 'saved' && data.status !== 'conflict')) {
      throw new Error('클라우드 저장 응답을 확인하지 못했습니다.')
    }
    const remote = readCloudNote(data.note, ownerId)
    if (remote.id !== snapshot.id) throw new Error('클라우드 저장 응답의 메모가 일치하지 않습니다.')
    await assertSession(client, ownerId)
    if (data.status === 'conflict') {
      if (!allowConflict) throw new Error('충돌 사본을 저장하지 못했습니다. 다음 동기화에서 다시 시도합니다.')
      const copy = await preserveConflict(snapshot, remote)
      if (copy) {
        report.conflicts++
        report.downloaded++
        await uploadNote(copy.id, false)
      }
      return
    }
    if (remote.version !== snapshot.version) throw new Error('클라우드 저장 버전이 일치하지 않습니다.')
    await db.transaction('rw', db.notes, async () => {
      const current = await db.notes.get(id)
      if (!current || current.cloudOwnerId !== ownerId) return
      // Acknowledge the sent version without marking newer local edits as synchronized.
      await db.notes.put({ ...current, baseVersion: remote.version, dirty: current.version !== snapshot.version })
    })
    report.uploaded++
  }

  const pending = await db.notes.filter(note => note.dirty && note.cloudOwnerId === ownerId).toArray()
  for (const note of pending) await uploadNote(note.id)

  // UUID ordering stays stable when other devices edit timestamps during pagination.
  for (let offset = 0; ; offset += pageSize) {
    await assertSession(client, ownerId)
    const { data, error } = await client.from('notes').select('*').eq('owner_id', ownerId)
      .order('id', { ascending: true }).range(offset, offset + pageSize - 1)
    if (error) throw new Error(`메모를 내려받지 못했습니다: ${error.message}`)
    if (!Array.isArray(data)) throw new Error('클라우드 메모 목록을 확인하지 못했습니다.')
    for (const value of data) {
      const remote = readCloudNote(value, ownerId)
      const snapshot = await db.notes.get(remote.id)
      if (snapshot && snapshot.cloudOwnerId !== ownerId) {
        throw new Error('다른 계정의 로컬 메모와 식별자가 겹칩니다. 데이터를 내보낸 뒤 계정을 확인해 주세요.')
      }
      if (snapshot?.dirty) {
        if (snapshot.version === remote.version) {
          await assertSession(client, ownerId)
          await db.transaction('rw', db.notes, async () => {
            const current = await db.notes.get(snapshot.id)
            if (current?.cloudOwnerId === ownerId && current.version === snapshot.version) {
              await db.notes.put({ ...current, baseVersion: remote.version, dirty: false })
            }
          })
        } else if (snapshot.baseVersion !== remote.version) {
          const copy = await preserveConflict(snapshot, remote)
          if (copy) {
            report.conflicts++
            report.downloaded++
            await uploadNote(copy.id, false)
          }
        }
        continue
      }
      if (snapshot?.version === remote.version) continue
      await downloadImages(client, ownerId, remote.data.attachments)
      await assertSession(client, ownerId)
      const applied = await db.transaction('rw', db.notes, async () => {
        const current = await db.notes.get(remote.id)
        if (current && (current.cloudOwnerId !== ownerId || current.dirty || current.version !== snapshot?.version)) return false
        await db.notes.put(localNote(remote))
        return true
      })
      if (applied) report.downloaded++
    }
    if (data.length < pageSize) break
  }
  return report
}

/** Offline edits remain dirty in IndexedDB until the cloud acknowledges their exact version. */
export async function syncNotes(client: SupabaseClient, ownerId: string): Promise<SyncReport> {
  if (!uuidPattern.test(ownerId)) throw new Error('계정 식별자가 올바르지 않습니다.')
  const active = activeSyncs.get(client)
  if (active) {
    if (active.ownerId !== ownerId) throw new Error('이전 계정의 동기화가 끝난 뒤 다시 시도해 주세요.')
    return active.promise
  }
  const promise = runSync(client, ownerId)
  activeSyncs.set(client, { ownerId, promise })
  try {
    return await promise
  } finally {
    if (activeSyncs.get(client)?.promise === promise) activeSyncs.delete(client)
  }
}
