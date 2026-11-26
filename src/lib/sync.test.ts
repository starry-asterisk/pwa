import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CloudNote, Note, NoteContent } from '../types'
import { validateCloudConfig } from './cloud'
import { createNote, db, purgeNotes, trashNotes, updateNote } from './db'
import { adoptLocalNotes, syncNotes } from './sync'

const ownerId = 'f485e060-eef0-4f14-9742-57d0891a7cab'
const otherOwner = '11e4d677-38de-4dfb-aad7-40ac6197980c'

function content(note: Note): NoteContent {
  return { title: note.title, body: note.body, tags: note.tags, pinned: note.pinned,
    createdAt: note.createdAt, updatedAt: note.updatedAt, deletedAt: note.deletedAt, attachments: note.attachments }
}

function cloudNote(note: Note, overrides: Partial<CloudNote> = {}): CloudNote {
  return { id: note.id, owner_id: ownerId, data: content(note), version: note.version,
    updated_at: note.updatedAt, origin_device_id: note.originDeviceId, ...overrides }
}

interface SaveParams {
  p_id: string
  p_data: NoteContent
  p_version: string
  p_expected_version: string | null
  p_origin_device_id: string
}
interface RpcResult {
  data: { status: 'saved' | 'conflict'; note: CloudNote } | { status: 'purged' }
    | { status: 'attachment_purged'; object_names: string[] }
    | Array<{ id: string; status: 'purged' }> | boolean | number | null
  error: { message: string; code?: string } | null
}

interface PurgeParams {
  p_ids: string[]
  p_attachment_names: string[]
  p_names: string[]
}

function fakeCloud(initial: CloudNote[] = []) {
  const state = { owner: ownerId, supportsRecordings: true, supportsPurges: true }
  const remote = new Map(initial.map(note => [note.id, structuredClone(note)]))
  const images = new Map<string, Blob>()
  const tombstones = new Map<string, { id: string; owner_id: string }>()
  const cleanup = new Map<string, { object_name: string; owner_id: string; cleaned_at: string | null }>()
  const calls: string[] = []
  const hooks: { beforeSave?: (params: SaveParams) => Promise<void>; afterSave?: () => Promise<void>; afterDownload?: () => Promise<void> } = {}
  const path = (attachment: NoteContent['attachments'][number]) =>
    `${state.owner}/${attachment.id}.${attachment.mime === 'video/mp4' ? 'mp4' : 'webp'}`
  const queueCleanup = (paths: string[]) => {
    const referenced = new Set([...remote.values()].filter(note => note.owner_id === state.owner)
      .flatMap(note => note.data.attachments.map(path)))
    for (const name of paths) if (images.has(name) && !referenced.has(name) && !cleanup.has(name)) {
      cleanup.set(name, { object_name: name, owner_id: state.owner, cleaned_at: null })
    }
  }
  const purgeRemote = (id: string) => {
    const names = remote.get(id)?.data.attachments.map(path) ?? []
    remote.delete(id)
    tombstones.set(id, { id, owner_id: state.owner })
    queueCleanup(names)
  }
  const rpc = vi.fn(async (name: string, params: SaveParams & PurgeParams): Promise<RpcResult> => {
    if (name === 'supports_recording_sync') {
      return state.supportsRecordings ? { data: true, error: null }
        : { data: null, error: { message: 'Unknown function', code: 'PGRST202' } }
    }
    if (name === 'purge_notes') {
      for (const id of params.p_ids) purgeRemote(id)
      queueCleanup(params.p_attachment_names)
      const data = params.p_ids.map(id => ({ id, status: 'purged' as const }))
      return { data, error: null }
    }
    if (name === 'ack_note_attachment_gc') {
      let count = 0
      for (const objectName of params.p_names) {
        const row = cleanup.get(objectName)
        if (row && !row.cleaned_at && !images.has(objectName)) {
          row.cleaned_at = new Date().toISOString()
          count++
        }
      }
      return { data: count, error: null }
    }
    calls.push('save')
    await hooks.beforeSave?.(params)
    if (tombstones.has(params.p_id)) {
      queueCleanup(params.p_data.attachments.map(path))
      return { data: { status: 'purged' }, error: null }
    }
    const retired = params.p_data.attachments.map(path).filter(name => cleanup.has(name))
    if (retired.length) return { data: { status: 'attachment_purged', object_names: retired }, error: null }
    const existing = remote.get(params.p_id)
    if (existing && existing.version !== params.p_version && existing.version !== params.p_expected_version) {
      return { data: { status: 'conflict', note: structuredClone(existing) }, error: null }
    }
    const saved: CloudNote = existing?.version === params.p_version ? existing : {
      id: params.p_id, owner_id: state.owner, data: structuredClone(params.p_data),
      version: params.p_version, updated_at: new Date().toISOString(), origin_device_id: params.p_origin_device_id,
    }
    remote.set(saved.id, saved)
    await hooks.afterSave?.()
    return { data: { status: 'saved', note: structuredClone(saved) }, error: null }
  })
  const from = vi.fn((table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = []
    let key = 'id'
    const query = {
      select: () => query,
      eq: (field: string, value: string) => {
        filters.push(row => row[field] === value)
        return query
      },
      order: (field: string) => { key = field; return query },
      gt: (field: string, cursor: string) => { filters.push(row => String(row[field]) > cursor); return query },
      is: (field: string, value: null) => { filters.push(row => row[field] === value); return query },
      range: async (first: number, last: number) => {
        if (table !== 'notes' && !state.supportsPurges) {
          return { data: null, error: { message: 'Unknown table', code: 'PGRST205' } }
        }
        const tableRows = table === 'notes' ? [...remote.values()] : table === 'note_tombstones'
          ? [...tombstones.values()] : [...cleanup.values()].filter(row => table !== 'pending_note_attachment_gc' || !row.cleaned_at)
        const rows = tableRows as unknown as Record<string, unknown>[]
        return { data: rows.filter(row => row.owner_id === state.owner && filters.every(filter => filter(row)))
          .sort((a, b) => String(a[key]).localeCompare(String(b[key]))).slice(first, last + 1).map(row => structuredClone(row)), error: null }
      },
    }
    return query
  })
  const upload = vi.fn(async (path: string, blob: Blob) => {
    calls.push('upload')
    if (cleanup.has(path)) return { data: null, error: { message: 'Retired object' } }
    images.set(path, blob)
    return { data: { path }, error: null }
  })
  const download = vi.fn(async (path: string) => {
    await hooks.afterDownload?.()
    return { data: images.get(path) ?? null, error: null }
  })
  const remove = vi.fn(async (names: string[]) => {
    for (const name of names) images.delete(name)
    return { data: [], error: null as { message: string } | null }
  })
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: state.owner } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { user: { id: state.owner } } }, error: null })),
    },
    from, rpc,
    storage: { from: vi.fn(() => ({ upload, download, remove })) },
  } as unknown as SupabaseClient
  return { client, state, remote, images, tombstones, cleanup, calls, hooks, rpc, upload, download, remove, purgeRemote }
}

beforeEach(async () => {
  await Promise.all(db.tables.map(table => table.clear()))
})

describe('local-first cloud synchronization', () => {
  it('uploads images before acknowledging a note, without sending another account’s notes', async () => {
    const attachment = { id: crypto.randomUUID(), name: '사진.webp', size: 4, width: 10, height: 10,
      mime: 'image/webp' as const, createdAt: new Date().toISOString() }
    const note = await createNote(ownerId, { title: '내 메모', attachments: [attachment] })
    const unrelated = await createNote(otherOwner, { body: '다른 계정의 메모' })
    await db.images.put({ ...attachment, blob: new Blob(['webp'], { type: 'image/webp' }) })
    const cloud = fakeCloud()
    const report = await syncNotes(cloud.client, ownerId)
    expect(cloud.calls).toEqual(['upload', 'save'])
    expect(cloud.remote.get(note.id)?.data.title).toBe('내 메모')
    expect(cloud.remote.has(unrelated.id)).toBe(false)
    expect(await db.notes.get(note.id)).toMatchObject({ dirty: false, baseVersion: note.version })
    expect((await db.notes.get(unrelated.id))?.dirty).toBe(true)
    expect(report.uploaded).toBe(1)
  })

  it('keeps recordings local on the old schema, then uploads and pulls the MP4 with its note', async () => {
    const media = { id: crypto.randomUUID(), name: 'recording.mp4', size: 16, width: 640, height: 360,
      mime: 'video/mp4' as const, createdAt: new Date().toISOString() }
    const recording = await createNote(ownerId, { title: '녹화 메모', attachments: [media] })
    const text = await createNote(ownerId, { body: '다른 메모' })
    await db.images.put({ ...media, blob: new Blob([new Uint8Array(media.size)], { type: 'video/mp4' }) })
    const cloud = fakeCloud()
    cloud.state.supportsRecordings = false
    const prior = await syncNotes(cloud.client, ownerId)
    expect(prior).toMatchObject({ uploaded: 1, pendingRecordings: 1 })
    expect(cloud.remote.has(text.id)).toBe(true)
    expect(cloud.remote.has(recording.id)).toBe(false)
    expect(cloud.upload).not.toHaveBeenCalled()
    expect((await db.notes.get(recording.id))?.dirty).toBe(true)

    cloud.state.supportsRecordings = true
    const upgraded = await syncNotes(cloud.client, ownerId)
    expect(upgraded).toMatchObject({ uploaded: 1 })
    expect(upgraded.pendingRecordings).toBeUndefined()
    const object = ownerId + '/' + media.id + '.mp4'
    expect(cloud.images.get(object)?.type).toBe('video/mp4')
    expect(cloud.remote.get(recording.id)?.data.attachments).toEqual([media])
    expect((await db.notes.get(recording.id))?.dirty).toBe(false)

    await db.notes.delete(recording.id)
    await db.images.delete(media.id)
    const pulled = await syncNotes(cloud.client, ownerId)
    expect(pulled.downloaded).toBe(1)
    expect(cloud.download).toHaveBeenCalledWith(object)
    expect((await db.images.get(media.id))?.blob.type).toBe('video/mp4')
    expect((await db.notes.get(recording.id))?.attachments).toEqual([media])
  })

  it('preserves both edits as a synchronized conflict copy instead of silently overwriting', async () => {
    const local = await createNote(ownerId, { title: '같은 메모', body: 'PC에서 수정' })
    const baseVersion = crypto.randomUUID()
    await db.notes.update(local.id, { baseVersion })
    const remote = cloudNote(local, { version: crypto.randomUUID(), data: { ...content(local), body: '휴대폰에서 수정' } })
    const cloud = fakeCloud([remote])
    const report = await syncNotes(cloud.client, ownerId)
    const notes = await db.notes.toArray()
    const copy = notes.find(note => note.id !== local.id)
    expect(await db.notes.get(local.id)).toMatchObject({ body: '휴대폰에서 수정', dirty: false, version: remote.version })
    expect(copy).toMatchObject({ title: '같은 메모 (충돌 사본)', body: 'PC에서 수정', dirty: false })
    expect(cloud.remote.get(copy!.id)?.data.body).toBe('PC에서 수정')
    expect(report.conflicts).toBe(1)
  })

  it('keeps a maximum-length title conflict copy within the cloud title limit', async () => {
    const title = '긴'.repeat(200)
    const local = await createNote(ownerId, { title, body: '로컬 편집 보존' })
    await db.notes.update(local.id, { baseVersion: crypto.randomUUID() })
    const remote = cloudNote(local, { version: crypto.randomUUID(), data: { ...content(local), body: '원격 편집' } })
    const cloud = fakeCloud([remote])
    const save = cloud.rpc.getMockImplementation()!
    cloud.rpc.mockImplementation((name, params) => params.p_data.title.length > 200
      ? Promise.resolve({ data: null, error: { message: '제목 길이를 초과했습니다.' } })
      : save(name, params))

    const report = await syncNotes(cloud.client, ownerId)
    const copy = (await db.notes.toArray()).find(note => note.id !== local.id)!
    expect(copy.title).toBe(`${title.slice(0, 190)} (충돌 사본)`)
    expect(copy.title.length).toBeLessThanOrEqual(200)
    expect(copy).toMatchObject({ body: '로컬 편집 보존', dirty: false })
    expect(cloud.remote.get(copy.id)?.data.title).toBe(copy.title)
    expect(await db.notes.get(local.id)).toMatchObject({ title, body: '원격 편집' })
    expect(report.conflicts).toBe(1)
  })

  it('keeps edits made while a save request is in flight dirty against the acknowledged version', async () => {
    const note = await createNote(ownerId, { body: '보낸 내용' })
    const cloud = fakeCloud()
    cloud.hooks.afterSave = async () => { await updateNote(note.id, { body: '응답 전에 새로 작성한 내용' }) }
    await syncNotes(cloud.client, ownerId)
    const current = await db.notes.get(note.id)
    expect(current).toMatchObject({ body: '응답 전에 새로 작성한 내용', dirty: true, baseVersion: note.version })
    expect(current?.version).not.toBe(note.version)
    expect(cloud.remote.get(note.id)?.data.body).toBe('보낸 내용')
  })

  it('does not overwrite a local edit made while remote images are downloading', async () => {
    const local = await createNote(ownerId, { body: '기존 내용' })
    await db.notes.update(local.id, { dirty: false, baseVersion: local.version })
    const attachment = { id: crypto.randomUUID(), name: '사진.webp', size: 4, width: 10, height: 10,
      mime: 'image/webp' as const, createdAt: new Date().toISOString() }
    const remote = cloudNote(local, { version: crypto.randomUUID(), data: { ...content(local), body: '원격 수정', attachments: [attachment] } })
    const cloud = fakeCloud([remote])
    cloud.images.set(`${ownerId}/${attachment.id}.webp`, new Blob(['webp'], { type: 'image/webp' }))
    cloud.hooks.afterDownload = async () => { await updateNote(local.id, { body: '내가 방금 쓴 내용' }) }
    const report = await syncNotes(cloud.client, ownerId)
    expect(await db.notes.get(local.id)).toMatchObject({ body: '내가 방금 쓴 내용', dirty: true, baseVersion: local.version })
    expect(report.downloaded).toBe(0)
  })

  it('retains an unacknowledged save and safely retries a response lost after server commit', async () => {
    const note = await createNote(ownerId, { body: '네트워크가 끊겨도 보존' })
    const cloud = fakeCloud()
    const firstSave = cloud.rpc.getMockImplementation()!
    cloud.rpc.mockImplementationOnce(async (name, params) => {
      await firstSave(name, params)
      return { data: null, error: { message: '연결이 끊겼습니다.' } }
    })
    await expect(syncNotes(cloud.client, ownerId)).rejects.toThrow('연결이 끊겼습니다.')
    expect(await db.notes.get(note.id)).toMatchObject({ dirty: true, body: note.body })
    await syncNotes(cloud.client, ownerId)
    expect(await db.notes.get(note.id)).toMatchObject({ dirty: false, baseVersion: note.version })
    expect(await db.notes.count()).toBe(1)
  })

  it('adopts only unassigned local notes after an explicit account connection', async () => {
    const local = await createNote(null, { body: '로컬 전용' })
    const unrelated = await createNote(otherOwner, { body: '다른 계정' })
    expect(await adoptLocalNotes(ownerId)).toBe(1)
    expect((await db.notes.get(local.id))?.cloudOwnerId).toBe(ownerId)
    expect((await db.notes.get(unrelated.id))?.cloudOwnerId).toBe(otherOwner)
  })

  it('does not acknowledge another account’s in-flight save after sign-in changes', async () => {
    const note = await createNote(ownerId, { body: '첫 계정의 메모' })
    const cloud = fakeCloud()
    cloud.hooks.afterSave = async () => { cloud.state.owner = otherOwner }
    await expect(syncNotes(cloud.client, ownerId)).rejects.toThrow('계정이 변경')
    expect(await db.notes.get(note.id)).toMatchObject({ dirty: true, cloudOwnerId: ownerId, baseVersion: null })
    cloud.rpc.mockClear()
    await syncNotes(cloud.client, otherOwner)
    expect(cloud.rpc).not.toHaveBeenCalled()
  })
})

describe('permanent deletion', () => {
  function photo() {
    return { id: crypto.randomUUID(), name: '메모사진.webp', size: 4, width: 10, height: 10,
      mime: 'image/webp' as const, createdAt: new Date().toISOString() }
  }

  it('moves selected local and own-account notes to the trash and purges only trashed notes', async () => {
    const attachment = photo()
    const local = await createNote(null, { attachments: [attachment] })
    const cloud = await createNote(ownerId, { attachments: [attachment], pinned: true })
    const unrelated = await createNote(otherOwner)
    await db.images.put({ ...attachment, blob: new Blob(['webp']) })
    expect(await purgeNotes([local.id], ownerId)).toBe(0)
    expect(await trashNotes([local.id, cloud.id, unrelated.id, cloud.id], ownerId)).toBe(2)
    expect((await db.notes.get(cloud.id))?.pinned).toBe(false)
    expect((await db.notes.get(unrelated.id))?.deletedAt).toBeNull()
    expect(await purgeNotes([local.id], ownerId)).toBe(1)
    expect(await db.images.get(attachment.id)).toBeDefined()
    expect(await db.pendingPurges.count()).toBe(0)
    expect(await purgeNotes([cloud.id, unrelated.id], ownerId)).toBe(1)
    expect(await db.images.get(attachment.id)).toBeUndefined()
    expect(await db.pendingPurges.toArray()).toEqual([{
      id: cloud.id, ownerId, attachmentNames: [`${ownerId}/${attachment.id}.webp`],
    }])
  })

  it('keeps a purge queued without the migration, then applies it to an active cloud snapshot', async () => {
    const shared = photo()
    const detached = photo()
    const orphan = photo()
    const note = await createNote(ownerId, { attachments: [shared, detached, orphan], body: '이 기기에서 지움' })
    const other = await createNote(ownerId, { attachments: [shared], body: '공유 첨부를 사용하는 메모' })
    const cloud = fakeCloud([
      cloudNote(note, { data: { ...content(note), attachments: [shared, detached] } }),
      cloudNote(other),
    ])
    for (const file of [shared, detached, orphan]) {
      const blob = new Blob(['webp'], { type: 'image/webp' })
      await db.images.put({ ...file, blob })
      cloud.images.set(`${ownerId}/${file.id}.webp`, blob)
    }
    await db.notes.update(other.id, { dirty: false, baseVersion: other.version })
    await trashNotes([note.id], ownerId)
    await purgeNotes([note.id], ownerId)
    cloud.state.supportsPurges = false

    expect(await syncNotes(cloud.client, ownerId)).toMatchObject({ pendingPurges: 1 })
    expect(cloud.remote.has(note.id)).toBe(true)
    expect(await db.notes.get(note.id)).toBeUndefined()
    expect(await db.pendingPurges.count()).toBe(1)

    cloud.state.supportsPurges = true
    expect((await syncNotes(cloud.client, ownerId)).pendingPurges).toBeUndefined()
    expect(cloud.remote.has(note.id)).toBe(false)
    expect(cloud.tombstones.has(note.id)).toBe(true)
    expect(await db.pendingPurges.count()).toBe(0)
    expect(cloud.images.has(`${ownerId}/${shared.id}.webp`)).toBe(true)
    expect(cloud.images.has(`${ownerId}/${detached.id}.webp`)).toBe(false)
    expect(cloud.images.has(`${ownerId}/${orphan.id}.webp`)).toBe(false)
    expect(await db.notes.get(other.id)).toBeDefined()
  })

  it('applies remote deletions to stale offline edits, without uploading or creating a conflict copy', async () => {
    const attachment = photo()
    const stale = await createNote(ownerId, { attachments: [attachment], body: '오프라인에서 편집' })
    const unrelated = await createNote(otherOwner)
    await db.images.put({ ...attachment, blob: new Blob(['webp']) })
    const cloud = fakeCloud([cloudNote(stale)])
    cloud.purgeRemote(stale.id)
    cloud.tombstones.set(unrelated.id, { id: unrelated.id, owner_id: otherOwner })

    expect(await syncNotes(cloud.client, ownerId)).toEqual({ uploaded: 0, downloaded: 0, conflicts: 0 })
    expect(cloud.upload).not.toHaveBeenCalled()
    expect(cloud.rpc).not.toHaveBeenCalled()
    expect(await db.notes.toArray()).toEqual([unrelated])
    expect(await db.images.get(attachment.id)).toBeUndefined()
  })

  it('honors a remote purge that arrives while a stale note upload is in flight', async () => {
    const attachment = photo()
    const stale = await createNote(ownerId, { attachments: [attachment], body: '응답을 기다리는 편집' })
    await db.images.put({ ...attachment, blob: new Blob(['webp']) })
    const cloud = fakeCloud([cloudNote(stale, { data: { ...content(stale), attachments: [] } })])
    cloud.hooks.beforeSave = async () => { cloud.purgeRemote(stale.id) }

    expect(await syncNotes(cloud.client, ownerId)).toEqual({ uploaded: 0, downloaded: 0, conflicts: 0 })
    expect(await db.notes.get(stale.id)).toBeUndefined()
    expect(cloud.remote.has(stale.id)).toBe(false)
    expect(cloud.images.size).toBe(0)
    expect(await db.images.get(attachment.id)).toBeUndefined()
  })

  it('keeps a concurrent local purge when an older attachment download completes', async () => {
    const old = await createNote(ownerId, { deletedAt: new Date().toISOString() })
    await db.notes.update(old.id, { dirty: false, baseVersion: old.version })
    const attachment = photo()
    const cloud = fakeCloud([cloudNote(old, {
      version: crypto.randomUUID(),
      data: { ...content(old), attachments: [attachment] },
    })])
    cloud.images.set(`${ownerId}/${attachment.id}.webp`, new Blob(['webp']))
    cloud.hooks.afterDownload = async () => { await purgeNotes([old.id], ownerId) }

    expect((await syncNotes(cloud.client, ownerId)).downloaded).toBe(0)
    expect(await db.notes.get(old.id)).toBeUndefined()
    expect(await db.images.get(attachment.id)).toBeUndefined()
    expect(await db.pendingPurges.count()).toBe(1)
    await syncNotes(cloud.client, ownerId)
    expect(cloud.remote.has(old.id)).toBe(false)
    expect(await db.pendingPurges.count()).toBe(0)
  })

  it('retries a Storage cleanup while keeping the note permanently removed', async () => {
    const attachment = photo()
    const note = await createNote(ownerId, { deletedAt: new Date().toISOString(), attachments: [attachment] })
    const cloud = fakeCloud([cloudNote(note)])
    const path = `${ownerId}/${attachment.id}.webp`
    cloud.images.set(path, new Blob(['webp']))
    await purgeNotes([note.id], ownerId)
    cloud.remove.mockResolvedValueOnce({ data: [], error: { message: '연결 끊김' } })
    const independent = await createNote(ownerId, { body: '별도 메모' })

    await expect(syncNotes(cloud.client, ownerId)).rejects.toThrow('연결 끊김')
    expect(cloud.remote.get(independent.id)?.data.body).toBe(independent.body)
    expect(await db.pendingPurges.count()).toBe(0)
    expect(cloud.remote.has(note.id)).toBe(false)
    expect(cloud.cleanup.get(path)?.cleaned_at).toBeNull()
    await syncNotes(cloud.client, ownerId)
    expect(cloud.images.has(path)).toBe(false)
    expect(cloud.cleanup.get(path)?.cleaned_at).toBeTruthy()
  })

  it('preserves the locally cached attachment of a surviving unsynced note when its old path is retired', async () => {
    const attachment = photo()
    const original = await createNote(ownerId, { attachments: [attachment] })
    const surviving = await createNote(ownerId, { title: '독립 메모', attachments: [attachment] })
    const cloud = fakeCloud([cloudNote(original)])
    const path = `${ownerId}/${attachment.id}.webp`
    const blob = new Blob(['webp'])
    cloud.images.set(path, blob)
    await db.images.put({ ...attachment, blob })
    cloud.purgeRemote(original.id)

    expect((await syncNotes(cloud.client, ownerId)).uploaded).toBe(1)
    const savedFile = cloud.remote.get(surviving.id)?.data.attachments[0]
    expect(savedFile?.name).toBe(attachment.name)
    expect(savedFile?.id).not.toBe(attachment.id)
    expect(cloud.images.has(`${ownerId}/${savedFile?.id}.webp`)).toBe(true)
    expect(cloud.images.has(path)).toBe(false)
    expect(await db.images.get(attachment.id)).toBeUndefined()
  })
})

describe('public cloud credentials', () => {
  it('rejects secret and legacy service-role keys before creating a client', () => {
    const config = { url: 'https://example.supabase.co', anonKey: 'sb_secret_private', vapidPublicKey: '' }
    expect(() => validateCloudConfig(config)).toThrow('Secret')
    const token = `header.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`
    expect(() => validateCloudConfig({ ...config, anonKey: token })).toThrow('service_role')
  })
})
