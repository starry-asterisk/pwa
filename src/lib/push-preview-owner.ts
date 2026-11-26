import { db, getSetting, setSetting } from './db'
import { readPushPreviewOwner } from './push-message'
import type { CloudConfig } from '../types'

const ownerKey = 'notification-preview-owner'

export async function getPushPreviewOwner() {
  return readPushPreviewOwner(await getSetting<unknown>(ownerKey, null))
}

export async function clearPushPreviewOwner(): Promise<void> {
  await db.settings.delete(ownerKey)
}

export async function updatePushPreviewOwner(config: CloudConfig, defaultConfig: CloudConfig, ownerId: string | null): Promise<void> {
  const owner = readPushPreviewOwner({ ownerId, projectUrl: config.url })
  await db.transaction('rw', db.settings, async () => {
    const stored = await getSetting('cloud-config', defaultConfig)
    // A tab using an old connection must not restore eligibility after a project switch.
    if (stored.url !== config.url || stored.anonKey !== config.anonKey) return
    if (owner) await setSetting(ownerKey, owner)
    else await clearPushPreviewOwner()
  })
}
