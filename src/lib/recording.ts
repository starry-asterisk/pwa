import type { StoredAttachment } from '../types'

export const MAX_RECORDING_BYTES = 20 * 1024 * 1024

export function validRecordingDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && width <= 1920 && height > 0 && height <= 1080
}

export function isMp4(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16 || bytes.byteLength > MAX_RECORDING_BYTES) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLength = view.getUint32(0)
  if (headerLength < 16 || headerLength > bytes.byteLength || view.getUint32(4) !== 0x66747970) return false
  let hasMovie = false
  let hasMedia = false
  for (let offset = headerLength; offset < bytes.byteLength;) {
    const remaining = bytes.byteLength - offset
    if (remaining < 8) return false
    const size32 = view.getUint32(offset)
    const headerSize = size32 === 1 ? 16 : 8
    if (remaining < headerSize) return false
    const size = size32 === 0 ? remaining : size32 === 1 ? Number(view.getBigUint64(offset + 8)) : size32
    if (size < headerSize || size > remaining) return false
    const type = view.getUint32(offset + 4)
    if (type === 0x6d6f6f76) hasMovie = size > headerSize
    if (type === 0x6d646174) hasMedia = size > headerSize
    offset += size
  }
  return hasMovie && hasMedia
}

export function storeRecording(file: File, dimensions: { width: number; height: number }, createdAt: string): StoredAttachment {
  return {
    id: crypto.randomUUID(), name: file.name, size: file.size, mime: 'video/mp4',
    createdAt, ...dimensions, blob: file,
  }
}
