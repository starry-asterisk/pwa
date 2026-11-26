export interface Attachment {
  id: string
  name: string
  size: number
  width: number
  height: number
  mime: 'image/webp' | 'video/mp4'
  createdAt: string
}
export interface NoteContent {
  title: string
  body: string
  tags: string[]
  pinned: boolean
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  attachments: Attachment[]
}
export interface Note extends NoteContent {
  id: string
  version: string
  baseVersion: string | null
  dirty: boolean
  originDeviceId: string
  cloudOwnerId: string | null
}
export interface StoredAttachment extends Attachment {
  blob: Blob
}
export interface StoredImage extends StoredAttachment {
  mime: 'image/webp'
}
export interface CloudConfig {
  url: string
  anonKey: string
  vapidPublicKey: string
}
export interface CloudNote {
  id: string
  owner_id: string
  data: NoteContent
  version: string
  updated_at: string
  origin_device_id: string
}
export interface SyncReport {
  uploaded: number
  downloaded: number
  conflicts: number
  pendingRecordings?: number
  pendingPurges?: number
}
export type NoteFilter = 'all' | 'pinned' | 'images' | 'trash'