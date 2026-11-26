import type { SupabaseClient } from '@supabase/supabase-js'
import { applyCloudPurges, db } from './db'

const pageSize = 200
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readTombstones(data: unknown, ownerId: string): string[] {
  if (!Array.isArray(data)) throw new Error('영구 삭제된 메모 목록을 확인하지 못했습니다.')
  return data.map(row => {
    if (!isRecord(row) || row.owner_id !== ownerId || typeof row.id !== 'string' || !uuidPattern.test(row.id)) {
      throw new Error('영구 삭제된 메모의 계정 또는 식별자가 올바르지 않습니다.')
    }
    return row.id
  })
}

export function isAttachmentPath(name: unknown, ownerId: string): name is string {
  return typeof name === 'string' && name.startsWith(ownerId + '/')
    && /\.(webp|mp4)$/.test(name) && uuidPattern.test(name.slice(ownerId.length + 1, name.lastIndexOf('.')))
}

export function createPurgeSync(client: SupabaseClient, ownerId: string, assertSession: () => Promise<void>) {
  let supported = false

  async function pull(): Promise<void> {
    let cursor: string | undefined
    for (;;) {
      await assertSession()
      const query = client.from('note_tombstones').select('id,owner_id').eq('owner_id', ownerId).order('id')
      const { data, error } = await (cursor ? query.gt('id', cursor) : query).range(0, pageSize - 1)
      await assertSession()
      if (error) {
        if (!cursor && (error.code === 'PGRST205' || error.code === '42P01')) return
        throw new Error(`영구 삭제된 메모를 확인하지 못했습니다: ${error.message}`)
      }
      supported = true
      const ids = readTombstones(data, ownerId)
      if (ids.length) await applyCloudPurges(ownerId, ids)
      if (ids.length < pageSize) return
      cursor = ids.at(-1)
    }
  }

  async function has(id: string): Promise<boolean> {
    if (await db.tombstones.get([ownerId, id])) return true
    if (!supported) return false
    await assertSession()
    const { data, error } = await client.from('note_tombstones').select('id,owner_id')
      .eq('owner_id', ownerId).eq('id', id).range(0, 0)
    await assertSession()
    if (error) throw new Error(`메모의 영구 삭제 여부를 확인하지 못했습니다: ${error.message}`)
    const ids = readTombstones(data, ownerId)
    if (!ids.length) return false
    if (ids.length !== 1 || ids[0] !== id) throw new Error('영구 삭제된 메모의 식별자가 일치하지 않습니다.')
    await applyCloudPurges(ownerId, ids)
    return true
  }

  async function retiredAttachment(objectName: string): Promise<boolean> {
    if (!supported) return false
    await assertSession()
    const { data, error } = await client.from('note_attachment_gc').select('object_name')
      .eq('owner_id', ownerId).eq('object_name', objectName).range(0, 0)
    await assertSession()
    if (error) throw new Error(`첨부 파일의 삭제 여부를 확인하지 못했습니다: ${error.message}`)
    return data?.[0]?.object_name === objectName
  }

  async function send(ids: string[], names: string[]): Promise<void> {
    await assertSession()
    const { data, error } = await client.rpc('purge_notes', { p_ids: ids, p_attachment_names: names })
    await assertSession()
    if (error) throw new Error(`영구 삭제를 동기화하지 못했습니다: ${error.message}`)
    const confirmed = new Set(Array.isArray(data) ? data.flatMap(row =>
      isRecord(row) && row.status === 'purged' && typeof row.id === 'string' ? [row.id] : []) : [])
    if (confirmed.size !== ids.length || !ids.every(id => confirmed.has(id))) {
      throw new Error('클라우드 영구 삭제 응답을 확인하지 못했습니다.')
    }
  }

  async function push(): Promise<number> {
    const purges = await db.pendingPurges.where('ownerId').equals(ownerId).toArray()
    if (!supported) return purges.length

    let ids: string[] = []
    let names: string[] = []
    async function flush() {
      if (!ids.length) return
      await send(ids, [...new Set(names)])
      await db.pendingPurges.bulkDelete(ids.map(id => [ownerId, id]))
      ids = []
      names = []
    }

    for (const purge of purges) {
      if (ids.length >= pageSize || names.length + purge.attachmentNames.length > pageSize) await flush()
      if (purge.attachmentNames.length > pageSize) {
        // The editor limits attachments, but an older local entry can exceed the RPC limit.
        for (let offset = 0; offset < purge.attachmentNames.length; offset += pageSize) {
          await send([purge.id], [...new Set(purge.attachmentNames.slice(offset, offset + pageSize))])
        }
        await db.pendingPurges.delete([ownerId, purge.id])
        continue
      }
      ids.push(purge.id)
      names.push(...purge.attachmentNames)
    }
    await flush()
    return 0
  }

  async function cleanAttachments(): Promise<void> {
    if (!supported) return
    let cursor: string | undefined
    for (;;) {
      await assertSession()
      const query = client.from('pending_note_attachment_gc').select('object_name')
        .eq('owner_id', ownerId).order('object_name')
      const { data, error } = await (cursor ? query.gt('object_name', cursor) : query).range(0, pageSize - 1)
      await assertSession()
      if (error) throw new Error(`삭제할 첨부 파일을 확인하지 못했습니다: ${error.message}`)
      if (!Array.isArray(data) || !data.every(row => isAttachmentPath(row?.object_name, ownerId))) {
        throw new Error('삭제할 첨부 파일의 경로가 올바르지 않습니다.')
      }
      const names: string[] = data.map(row => row.object_name)
      if (!names.length) return
      const removed = await client.storage.from('note-images').remove(names)
      await assertSession()
      if (removed.error) throw new Error(`첨부 파일을 영구 삭제하지 못했습니다: ${removed.error.message}`)
      const ack = await client.rpc('ack_note_attachment_gc', { p_names: names })
      await assertSession()
      if (ack.error) throw new Error(`첨부 파일 삭제를 확인하지 못했습니다: ${ack.error.message}`)
      if (names.length < pageSize) return
      cursor = names.at(-1)
    }
  }

  return { pull, push, has, retiredAttachment, cleanAttachments }
}
