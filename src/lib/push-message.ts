const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const generic = {
  title: '새 메모가 도착했습니다',
  body: '다른 기기에 저장한 메모를 확인하세요.',
}

export interface PushPreviewOwner {
  ownerId: string
  projectUrl: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function readPushPreviewOwner(value: unknown): PushPreviewOwner | null {
  const data = record(value)
  if (typeof data?.ownerId !== 'string' || !uuid.test(data.ownerId) || typeof data.projectUrl !== 'string') return null
  try {
    const url = new URL(data.projectUrl)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) return null
    return { ownerId: data.ownerId.toLowerCase(), projectUrl: url.origin }
  } catch {
    return null
  }
}

function previewText(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim()
  if (!text) return fallback
  const characters = Array.from(text)
  return characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : text
}

export function describeNotePush(value: unknown, activeOwner: PushPreviewOwner | null) {
  const data = record(value)
  const noteId = typeof data?.noteId === 'string' && uuid.test(data.noteId) ? data.noteId : undefined
  if (!data || !noteId) return { ...generic, noteId: undefined }
  if (!('ownerId' in data) && !('projectUrl' in data)) return { ...generic, noteId }

  const recipient = readPushPreviewOwner(data)
  if (!recipient || !activeOwner || recipient.ownerId !== activeOwner.ownerId || recipient.projectUrl !== activeOwner.projectUrl) {
    return { ...generic, noteId: undefined }
  }
  return {
    title: previewText(data.title, 96, generic.title),
    body: previewText(data.body, 192, generic.body),
    noteId,
  }
}
