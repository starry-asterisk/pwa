import type { User } from '@supabase/supabase-js'
import { db } from './db'

export type LocalOwner = Pick<User, 'id' | 'email'>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function cachedOwnerKey(projectUrl: string): string {
  let url: URL
  try { url = new URL(projectUrl.trim()) } catch { throw new Error('프로젝트 주소가 올바르지 않습니다.') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('프로젝트 주소가 올바르지 않습니다.')
  }
  return `offline-owner:${url.origin}`
}

function ownerOnly(value: unknown): LocalOwner | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const owner = value as Record<string, unknown>
  if (typeof owner.id !== 'string' || !UUID.test(owner.id)) return null
  if (owner.email === undefined) return { id: owner.id }
  if (typeof owner.email !== 'string' || owner.email.length > 320) return null
  const email = owner.email.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null
  return { id: owner.id, email }
}

/** Local display identity only. This never grants cloud access or stores tokens. */
export async function readCachedOwner(projectUrl: string): Promise<LocalOwner | null> {
  const row = await db.settings.get(cachedOwnerKey(projectUrl))
  return ownerOnly(row?.value)
}

export async function writeCachedOwner(projectUrl: string, owner: LocalOwner | null): Promise<void> {
  const key = cachedOwnerKey(projectUrl)
  if (owner === null) { await db.settings.delete(key); return }
  const value = ownerOnly(owner)
  if (!value) throw new Error('이 기기의 계정 정보가 올바르지 않습니다.')
  // A full Supabase User/session may be supplied at runtime. Pick fields rather
  // than spreading it, so credentials and unrelated metadata cannot persist.
  await db.settings.put({ key, value })
}

export async function clearCachedOwner(projectUrl: string): Promise<void> {
  await db.settings.delete(cachedOwnerKey(projectUrl))
}
