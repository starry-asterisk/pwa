import { describe, expect, it } from 'vitest'
import { readImageHeader } from './media'

function png(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(animated ? 65 : 45)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set(new TextEncoder().encode('IHDR'), 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  if (animated) {
    view.setUint32(33, 8)
    bytes.set(new TextEncoder().encode('acTL'), 37)
    bytes.set(new TextEncoder().encode('IEND'), 57)
  } else bytes.set(new TextEncoder().encode('IEND'), 37)
  return bytes
}

describe('image input validation', () => {
  it('rejects active document content regardless of an image filename', () => {
    expect(() => readImageHeader(new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toThrow('PNG, JPEG')
    expect(() => readImageHeader(new TextEncoder().encode('<!DOCTYPE html><html></html>'))).toThrow('PNG, JPEG')
  })
  it('rejects oversized dimensions before decoding the image', () => {
    expect(() => readImageHeader(png(9000, 9000))).toThrow('4,000만')
    expect(() => readImageHeader(png(20000, 1))).toThrow('16,383px')
  })
  it('refuses animation rather than silently discarding frames', () => {
    expect(() => readImageHeader(png(1, 1, true))).toThrow('움직이는')
    const webp = new Uint8Array(30)
    const view = new DataView(webp.buffer)
    webp.set(new TextEncoder().encode('RIFF'), 0)
    view.setUint32(4, 22, true)
    webp.set(new TextEncoder().encode('WEBPVP8X'), 8)
    view.setUint32(16, 10, true)
    webp[20] = 2
    expect(() => readImageHeader(webp)).toThrow('움직이는')
    expect(() => readImageHeader(new TextEncoder().encode('GIF89a'))).toThrow('GIF')
  })
})