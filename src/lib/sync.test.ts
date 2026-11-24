import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CloudNote, Note, NoteContent } from '../types'
import { validateCloudConfig } from './cloud'
import { createNote, db, updateNote } from './db'
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
  data: { status: 'saved' | 'conflict'; note: CloudNote } | null
  error: { message: string } | null
}

function fakeCloud(initial: CloudNote[] = []) {
  const state = { owner: ownerId }
  const remote = new Map(initial.map(note => [note.id, structuredClone(note)]))
  const images = new Map<string, Blob>()
  const calls: string[] = []
  const hooks: { afterSave?: () => Promise<void>; afterDownload?: () => Promise<void> } = {}
  const rpc = vi.fn(async (_name: string, params: SaveParams): Promise<RpcResult> => {
    calls.push('save')
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
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    range: vi.fn(async (from: number, to: number) => ({
      data: [...remote.values()].filter(note => note.owner_id === state.owner)
        .sort((a, b) => a.id.localeCompare(b.id)).slice(from, to + 1).map(note => structuredClone(note)),
      error: null,
    })),
  }
  const upload = vi.fn(async (path: string, blob: Blob) => {
    calls.push('upload')
    images.set(path, blob)
    return { data: { path }, error: null }
  })
  const download = vi.fn(async (path: string) => {
    await hooks.afterDownload?.()
    return { data: images.get(path) ?? null, error: null }
  })
  const client = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: state.owner } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { user: { id: state.owner } } }, error: null })),
    },
    from: vi.fn(() => query), rpc,
    storage: { from: vi.fn(() => ({ upload, download })) },
  } as unknown as SupabaseClient
  return { client, state, remote, images, calls, hooks, rpc, upload, download }
}

beforeEach(async () => {
  await Promise.all([db.notes.clear(), db.images.clear(), db.settings.clear()])
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

describe('public cloud credentials', () => {
  it('rejects secret and legacy service-role keys before creating a client', () => {
    const config = { url: 'https://example.supabase.co', anonKey: 'sb_secret_private', vapidPublicKey: '' }
    expect(() => validateCloudConfig(config)).toThrow('Secret')
    const token = `header.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`
    expect(() => validateCloudConfig({ ...config, anonKey: token })).toThrow('service_role')
  })
})
