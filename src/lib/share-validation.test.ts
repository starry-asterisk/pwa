import { describe, expect, it } from 'vitest'
import { ShareValidationError, validateSharedForm } from './share-validation'

describe('share target input validation', () => {
  it('preserves every supported shared image and the supplied text and link', () => {
    const form = new FormData()
    form.set('title', '공유한 메모')
    form.set('text', '남길 내용')
    form.set('url', 'https://example.com/')
    form.append('images', new File(['png'], 'one.png', { type: 'image/png' }))
    form.append('images', new File(['webp'], 'two.webp', { type: 'image/webp' }))
    const result = validateSharedForm(form)
    expect(result.files.map(file => file.name)).toEqual(['one.png', 'two.webp'])
    expect(result.text).toBe('남길 내용\nhttps://example.com/')
  })

  it('rejects an entire mixed share rather than silently dropping an unsupported file', () => {
    const form = new FormData()
    form.append('images', new File(['png'], 'one.png', { type: 'image/png' }))
    form.append('images', new File(['pdf'], 'two.pdf', { type: 'application/pdf' }))
    expect(() => validateSharedForm(form)).toThrow(ShareValidationError)
    try { validateSharedForm(form) } catch (error) { expect((error as ShareValidationError).status).toBe(415) }
  })

  it('rejects any oversized image before a capture is persisted', () => {
    const form = new FormData()
    form.append('images', new File(['png'], 'one.png', { type: 'image/png' }))
    form.append('images', new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }))
    try { validateSharedForm(form); throw new Error('Expected rejection') }
    catch (error) { expect((error as ShareValidationError).status).toBe(413) }
  })

  it('refuses too many files and malformed text values', () => {
    const form = new FormData()
    for (let index = 0; index < 11; index++) form.append('images', new File(['x'], `${index}.webp`, { type: 'image/webp' }))
    expect(() => validateSharedForm(form)).toThrow('10장')
    const malformed = new FormData()
    malformed.set('text', new File(['x'], 'text.txt'))
    expect(() => validateSharedForm(malformed)).toThrow('텍스트 형식')
  })
})

describe('share target completeness', () => {
  it('deduplicates a URL supplied by both Android text and url fields', () => {
    const form = new FormData()
    form.set('text', 'https://example.com/')
    form.set('url', 'https://example.com/')
    expect(validateSharedForm(form).text).toBe('https://example.com/')
  })
  it('rejects empty captures and unrecognized file fields instead of dropping data', () => {
    expect(() => validateSharedForm(new FormData())).toThrow('선택해 주세요')
    const form = new FormData()
    form.set('text', '일부 내용')
    form.set('other-file', new File(['pdf'], 'file.pdf', { type: 'application/pdf' }))
    expect(() => validateSharedForm(form)).toThrow('첨부 파일')
  })
  it('bounds the whole image transfer even when each individual image is valid', () => {
    const file = new File([new Uint8Array(18 * 1024 * 1024)], 'image.png', { type: 'image/png' })
    const form = new FormData()
    form.append('images', file); form.append('images', file); form.append('images', file)
    try { validateSharedForm(form); throw new Error('Expected rejection') }
    catch (error) { expect((error as ShareValidationError).status).toBe(413) }
  })
})
describe('platform share file metadata', () => {
  it('accepts a supported extension when the OS supplies an empty or generic MIME type', () => {
    const form = new FormData()
    form.append('images', new File(['png'], 'screenshot.PNG'))
    form.append('images', new File(['jpeg'], 'photo.jpeg', { type: 'application/octet-stream' }))
    expect(validateSharedForm(form).files.map(file => file.type)).toEqual(['image/png', 'image/jpeg'])
  })
  it('does not override an explicitly unsupported MIME type with a filename extension', () => {
    const form = new FormData()
    form.append('images', new File(['html'], 'fake.png', { type: 'text/html' }))
    expect(() => validateSharedForm(form)).toThrow('PNG, JPEG')
  })
})