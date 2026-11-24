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
