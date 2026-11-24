import { downloadBlob } from './media'

export interface SharePlatform {
  share?: (data: ShareData) => Promise<void>
  canShare?: (data: ShareData) => boolean
  clipboard?: { writeText: (text: string) => Promise<void> }
}
export type ShareResult = 'shared' | 'cancelled' | 'unsupported'

export function sharedNoteText(title: string, body: string): string {
  return [title.trim(), body.trim() ? body.trimEnd() : ''].filter(Boolean).join('\n\n')
}
export function safeFileStem(value: string, fallback = 'moa-note'): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 150).trim() || fallback
}
export function pngFilename(original: string): string { return `${safeFileStem(original.replace(/\.[^.]+$/, ''), 'moa-image')}.png` }

export function supportsTextSharing(platform: SharePlatform = navigator): boolean {
  if (typeof platform.share !== 'function') return false
  try { return !platform.canShare || platform.canShare({ text: '모아 메모' }) } catch { return false }
}
export function supportsFileSharing(files: File[], platform: SharePlatform = navigator): boolean {
  if (!files.length || typeof platform.share !== 'function' || typeof platform.canShare !== 'function') return false
  // Test files explicitly: checking text support does not imply file support.
  try { return platform.canShare({ files }) } catch { return false }
}
async function share(data: ShareData, platform: SharePlatform): Promise<ShareResult> {
  try {
    // Invoke directly from the button handler, before any asynchronous preparation.
    await platform.share!(data)
    return 'shared'
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') return 'cancelled'
    throw new Error('공유 메뉴를 열지 못했습니다. 복사 또는 다운로드를 이용해 주세요.')
  }
}
export function shareNoteText(title: string, body: string, platform: SharePlatform = navigator): Promise<ShareResult> {
  const text = sharedNoteText(title, body)
  if (!text) return Promise.reject(new Error('공유할 텍스트를 먼저 적어 주세요.'))
  if (!supportsTextSharing(platform)) return Promise.resolve('unsupported')
  const data = { title: title.trim() || '모아 메모', text }
  try { if (platform.canShare && !platform.canShare(data)) return Promise.resolve('unsupported') } catch { return Promise.resolve('unsupported') }
  return share(data, platform)
}
export function sharePngImage(file: File, title: string, platform: SharePlatform = navigator): Promise<ShareResult> {
  if (file.type !== 'image/png') return Promise.reject(new Error('PNG 이미지가 준비되지 않았습니다.'))
  if (!supportsFileSharing([file], platform)) return Promise.resolve('unsupported')
  return share({ files: [file], title: title.trim() || file.name }, platform)
}
export async function copyNoteText(title: string, body: string, platform: SharePlatform = navigator): Promise<void> {
  const text = sharedNoteText(title, body)
  if (!text) throw new Error('복사할 텍스트를 먼저 적어 주세요.')
  if (!platform.clipboard?.writeText) throw new Error('이 브라우저에서 복사를 지원하지 않습니다. 텍스트 파일로 저장해 주세요.')
  try { await platform.clipboard.writeText(text) }
  catch { throw new Error('클립보드에 복사하지 못했습니다. 텍스트 파일로 저장해 주세요.') }
}
export function downloadNoteText(title: string, body: string): void {
  const text = sharedNoteText(title, body)
  if (!text) throw new Error('저장할 텍스트를 먼저 적어 주세요.')
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${safeFileStem(title)}.txt`)
}