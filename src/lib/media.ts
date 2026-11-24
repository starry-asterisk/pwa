import webpWasmUrl from '@jsquash/webp/codec/enc/webp_enc.wasm?url'
import webpSimdWasmUrl from '@jsquash/webp/codec/enc/webp_enc_simd.wasm?url'
import type { StoredImage } from '../types'

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 40_000_000
export const MAX_STORED_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_WEBP_DIMENSION = 16_383

export interface ImageOptions {
  lossless?: boolean
  /** Omit to preserve the source resolution. */
  maxDimension?: number
}
export interface ImageHeader {
  format: 'png' | 'jpeg' | 'webp'
  width: number
  height: number
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}
function checkDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('이미지의 해상도를 확인할 수 없습니다.')
  }
  if (width > MAX_WEBP_DIMENSION || height > MAX_WEBP_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('이미지가 너무 큽니다. 4,000만 화소 이하, 한 변 16,383px 이하의 이미지를 선택해 주세요.')
  }
}

/** Reads dimensions before decoding so oversized inputs do not allocate a canvas. */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let result: ImageHeader | undefined
  if (bytes.length >= 33 && bytes[0] === 137 && text(bytes, 1, 3) === 'PNG' && text(bytes, 12, 4) === 'IHDR') {
    if (bytes[4] !== 13 || bytes[5] !== 10 || bytes[6] !== 26 || bytes[7] !== 10) throw new Error('올바른 PNG 파일이 아닙니다.')
    result = { format: 'png', width: view.getUint32(16), height: view.getUint32(20) }
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset)
      const chunk = text(bytes, offset + 4, 4)
      if (chunk === 'acTL') throw new Error('움직이는 이미지는 아직 지원하지 않습니다. 정지 이미지를 선택해 주세요.')
      if (length > bytes.length - offset - 12) throw new Error('손상된 PNG 파일입니다.')
      offset += length + 12
      if (chunk === 'IEND') break
    }
  } else if (bytes.length >= 16 && text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP') {
    if (view.getUint32(4, true) + 8 !== bytes.length) throw new Error('손상된 WebP 파일입니다.')
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const chunk = text(bytes, offset, 4)
      const length = view.getUint32(offset + 4, true)
      const start = offset + 8
      if (length > bytes.length - start) throw new Error('손상된 WebP 파일입니다.')
      if (chunk === 'ANIM' || chunk === 'ANMF' || (chunk === 'VP8X' && length >= 10 && (bytes[start] & 2) !== 0)) {
        throw new Error('움직이는 이미지는 아직 지원하지 않습니다. 정지 이미지를 선택해 주세요.')
      }
      if (chunk === 'VP8X' && length >= 10) {
        result = {
          format: 'webp',
          width: 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16),
          height: 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16),
        }
      } else if (chunk === 'VP8L' && length >= 5 && bytes[start] === 0x2f && !result) {
        const bits = view.getUint32(start + 1, true)
        result = { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
      } else if (chunk === 'VP8 ' && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a && !result) {
        result = { format: 'webp', width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff }
      }
      offset = start + length + (length & 1)
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error('손상된 JPEG 파일입니다.')
      while (bytes[offset] === 0xff) offset += 1
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || length > bytes.length - offset) throw new Error('손상된 JPEG 파일입니다.')
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        result = { format: 'jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) }
        break
      }
      offset += length
    }
  } else if (text(bytes, 0, 3) === 'GIF') {
    throw new Error('GIF는 아직 지원하지 않습니다. PNG, JPEG 또는 정지 WebP 이미지를 선택해 주세요.')
  }
  if (!result) throw new Error('PNG, JPEG 또는 정지 WebP 이미지만 저장할 수 있습니다.')
  checkDimensions(result.width, result.height)
  return result
}

let encoderReady: Promise<typeof import('@jsquash/webp/encode')> | undefined
async function getEncoder() {
  if (!encoderReady) {
    encoderReady = (async () => {
      const encoder = await import('@jsquash/webp/encode')
      await encoder.init({ locateFile: (path: string) => path.includes('simd') ? webpSimdWasmUrl : webpWasmUrl })
      return encoder
    })().catch((error) => { encoderReady = undefined; throw error })
  }
  return encoderReady
}

async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('이미지를 읽을 수 없습니다. 파일이 손상되었거나 이 기기에서 지원하지 않는 형식입니다.')
  }
}

export async function optimizeImage(file: File, options: ImageOptions = {}): Promise<StoredImage> {
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) throw new Error('이미지는 파일당 25MB 이하로 선택해 주세요.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const header = readImageHeader(bytes)
  const bitmap = await decodeImage(file)
  let canvas: HTMLCanvasElement | undefined
  try {
    checkDimensions(bitmap.width, bitmap.height)
    const max = options.maxDimension
    if (max !== undefined && (!Number.isFinite(max) || max < 256 || max > 8192)) {
      throw new Error('축소 크기는 256~8,192px 사이여야 합니다.')
    }
    const scale = max ? Math.min(1, max / Math.max(bitmap.width, bitmap.height)) : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    let blob: Blob
    // Avoid recompressing an existing WebP and introducing another lossy generation.
    if (header.format === 'webp' && scale === 1 && bitmap.width === header.width && bitmap.height === header.height) {
      blob = new Blob([bytes], { type: 'image/webp' })
    } else {
      canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('이 브라우저에서 이미지 변환을 지원하지 않습니다.')
      context.drawImage(bitmap, 0, 0, width, height)
      const pixels = context.getImageData(0, 0, width, height)
      const encoder = await getEncoder()
      const lossless = header.format === 'png' || options.lossless === true
      const encoded = await encoder.default(pixels, { lossless: lossless ? 1 : 0, quality: lossless ? 100 : 82, exact: 1, method: 4 })
      blob = new Blob([encoded], { type: 'image/webp' })
    }
    if (blob.size > MAX_STORED_IMAGE_BYTES) throw new Error('변환한 이미지가 20MB를 초과합니다. 용량 절약 옵션을 사용해 주세요.')
    return {
      id: crypto.randomUUID(),
      name: file.name || 'image',
      size: blob.size,
      width,
      height,
      mime: 'image/webp',
      createdAt: new Date().toISOString(),
      blob,
    }
  } finally {
    bitmap.close()
    if (canvas) { canvas.width = 1; canvas.height = 1 }
  }
}

export async function createPngBlob(blob: Blob): Promise<Blob> {
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('이미지가 너무 커서 PNG로 변환할 수 없습니다.')
  readImageHeader(new Uint8Array(await blob.arrayBuffer()))
  const bitmap = await decodeImage(blob)
  const canvas = document.createElement('canvas')
  try {
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('이 브라우저에서 PNG 변환을 지원하지 않습니다.')
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG 파일을 만들지 못했습니다.')), 'image/png')
    })
  } finally {
    bitmap.close()
    canvas.width = 1
    canvas.height = 1
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function downloadImageAsPng(image: StoredImage): Promise<void> {
  const png = await createPngBlob(image.blob)
  const name = image.name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'moa-image'
  downloadBlob(png, `${name}.png`)
}