import { beforeEach, describe, expect, it } from 'vitest'
import { db, setSetting } from './db'
import { describeNotePush, readPushPreviewOwner } from './push-message'
import { clearPushPreviewOwner, getPushPreviewOwner, updatePushPreviewOwner } from './push-preview-owner'

const ownerId = '10000000-0000-4000-8000-000000000001'
const anotherOwner = '10000000-0000-4000-8000-000000000002'
const noteId = '20000000-0000-4000-8000-000000000001'
const config = { url: 'https://active.supabase.co', anonKey: 'sb_publishable_active', vapidPublicKey: '' }
const otherConfig = { url: 'https://other.supabase.co', anonKey: 'sb_publishable_other', vapidPublicKey: '' }
const identity = { ownerId, projectUrl: config.url }
const generic = { title: '새 메모가 도착했습니다', body: '다른 기기에 저장한 메모를 확인하세요.' }
const payload = { ...identity, noteId, title: '모아 알림', body: '남긴 내용 · 사진 2장' }

describe('note push previews', () => {
  it('shows plain text and attachment counts for the active account and project', () => {
    expect(describeNotePush({ ...payload, title: '  모아\n알림  ' }, identity))
      .toEqual({ title: '모아 알림', body: payload.body, noteId })
    expect(readPushPreviewOwner({ ...identity, projectUrl: config.url + '/' })).toEqual(identity)
  })

  it('retains safe legacy links and uses generic text for malformed payloads', () => {
    expect(describeNotePush({ noteId, title: '검증되지 않은 제목' }, null)).toEqual({ ...generic, noteId })
    expect(describeNotePush(null, identity)).toEqual({ ...generic, noteId: undefined })
    expect(describeNotePush({ ...payload, noteId: '../not-a-note' }, identity)).toEqual({ ...generic, noteId: undefined })
    expect(describeNotePush({ ...payload, title: {}, body: ' \n ' }, identity)).toEqual({ ...generic, noteId })
  })

  it('hides both previews and note links for unrelated projects and accounts', () => {
    for (const activeOwner of [null, { ...identity, ownerId: anotherOwner }, { ...identity, projectUrl: otherConfig.url }]) {
      expect(describeNotePush(payload, activeOwner)).toEqual({ ...generic, noteId: undefined })
    }
    expect(describeNotePush({ ...payload, projectUrl: 'file:///private' }, identity)).toEqual({ ...generic, noteId: undefined })
  })

  it('bounds text without breaking Unicode code points', () => {
    const result = describeNotePush({ ...payload, title: '📸'.repeat(100), body: '한'.repeat(200) }, identity)
    expect(result.title).toBe('📸'.repeat(95) + '…')
    expect(result.body).toBe('한'.repeat(191) + '…')
  })
})

describe('push preview account storage', () => {
  beforeEach(async () => { await db.settings.clear() })

  it('uses the default or saved project and scopes writes and clears to the current connection', async () => {
    await updatePushPreviewOwner(config, config, ownerId)
    expect(await getPushPreviewOwner()).toEqual(identity)
    await db.transaction('rw', db.settings, async () => {
      await clearPushPreviewOwner()
      await setSetting('cloud-config', otherConfig)
    })
    await updatePushPreviewOwner(config, config, ownerId)
    expect(await getPushPreviewOwner()).toBeNull()
    await updatePushPreviewOwner(otherConfig, config, anotherOwner)
    await updatePushPreviewOwner(config, config, null)
    expect(await getPushPreviewOwner()).toEqual({ ownerId: anotherOwner, projectUrl: otherConfig.url })
    await updatePushPreviewOwner(otherConfig, config, null)
    expect(await getPushPreviewOwner()).toBeNull()
  })
})
