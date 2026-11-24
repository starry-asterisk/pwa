import { beforeEach, describe, expect, it } from 'vitest'
import { db } from './db'
import { cachedOwnerKey, clearCachedOwner, readCachedOwner, writeCachedOwner } from './offline-owner'

const owner = { id: 'aeb29c47-589c-47d5-aa2b-f32c30fd83b1', email: 'owner@example.com' }
const projectA = 'https://project-a.supabase.co'
const projectB = 'https://project-b.supabase.co'

beforeEach(async () => { await db.settings.clear() })

describe('offline owner identity', () => {
  it('uses a stable origin key while keeping projects isolated', async () => {
    expect(cachedOwnerKey(`${projectA}/`)).toBe(cachedOwnerKey(`${projectA}:443/other-path`))
    await writeCachedOwner(projectA, owner)
    expect(await readCachedOwner(`${projectA}/`)).toEqual(owner)
    expect(await readCachedOwner(projectB)).toBeNull()
  })

  it('stores only id and email even when a full user or session-shaped object is passed', async () => {
    const full = { ...owner, access_token: 'never-store', refresh_token: 'never-store-either',
      session: { token: 'nested-private' }, user_metadata: { name: 'not-needed' } }
    await writeCachedOwner(projectA, full)
    expect((await db.settings.get(cachedOwnerKey(projectA)))?.value).toEqual(owner)
    expect(await readCachedOwner(projectA)).toEqual(owner)
  })

  it('accepts owners without email and clears the selected project on logout', async () => {
    await writeCachedOwner(projectA, { id: owner.id })
    await writeCachedOwner(projectB, owner)
    expect(await readCachedOwner(projectA)).toEqual({ id: owner.id })
    await clearCachedOwner(projectA)
    expect(await readCachedOwner(projectA)).toBeNull()
    expect(await readCachedOwner(projectB)).toEqual(owner)
    await writeCachedOwner(projectB, null)
    expect(await readCachedOwner(projectB)).toBeNull()
  })

  it('rejects invalid ids or emails without replacing an existing valid identity', async () => {
    await writeCachedOwner(projectA, owner)
    for (const invalid of [
      { id: 'not-a-uuid' }, { ...owner, id: `${owner.id}&owner_id=not.null` },
      { ...owner, email: 'not-an-email' }, { ...owner, email: `${'a'.repeat(321)}@example.com` },
    ]) await expect(writeCachedOwner(projectA, invalid)).rejects.toThrow('계정 정보')
    expect(await readCachedOwner(projectA)).toEqual(owner)
  })

  it('treats malformed stored data as absent and strips unrelated fields on read', async () => {
    for (const value of [null, [], 'text', { id: 'invalid' }, { ...owner, email: null }]) {
      await db.settings.put({ key: cachedOwnerKey(projectA), value })
      expect(await readCachedOwner(projectA)).toBeNull()
    }
    await db.settings.put({ key: cachedOwnerKey(projectA), value: { ...owner, access_token: 'private' } })
    expect(await readCachedOwner(projectA)).toEqual(owner)
  })

  it('rejects ambiguous or unsafe project origins', async () => {
    for (const url of ['', 'not a URL', 'http://public.example.com', 'https://user:password@example.com', 'file:///private']) {
      expect(() => cachedOwnerKey(url)).toThrow('프로젝트 주소')
    }
    expect(cachedOwnerKey('http://127.0.0.1:54321/')).toBe('offline-owner:http://127.0.0.1:54321')
  })
})
