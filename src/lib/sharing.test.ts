import { describe, expect, it, vi } from 'vitest'
import { copyNoteText, pngFilename, safeFileStem, shareNoteText, sharePngImage, sharedNoteText, supportsFileSharing, supportsTextSharing } from './sharing'

const png = () => new File(['png-data'], '메모.png', { type: 'image/png' })

describe('outbound sharing', () => {
  it('shares the current text directly without exposing an app URL or losing Markdown indentation', async () => {
    const native = vi.fn(async () => {})
    const operation = shareNoteText(' 현재 제목 ', '    indented code\n\n다음 줄\n', { share: native, canShare: () => true })
    // No asynchronous preparation precedes the native call; browser activation is retained.
    expect(native).toHaveBeenCalledOnce()
    expect(native).toHaveBeenCalledWith({ title: '현재 제목', text: '현재 제목\n\n    indented code\n\n다음 줄' })
    expect(await operation).toBe('shared')
  })
  it('treats an OS share cancellation as cancellation rather than copying or downloading', async () => {
    const copy = vi.fn(async () => {})
    const result = await shareNoteText('제목', '본문', {
      share: async () => { throw new DOMException('사용자가 취소했습니다.', 'AbortError') }, canShare: () => true,
      clipboard: { writeText: copy },
    })
    expect(result).toBe('cancelled')
    expect(copy).not.toHaveBeenCalled()
  })
  it('checks actual file support separately from text support', async () => {
    const native = vi.fn(async () => {})
    const platform = { share: native, canShare: (data: ShareData) => Boolean(data.text) }
    expect(supportsTextSharing(platform)).toBe(true)
    expect(supportsFileSharing([png()], platform)).toBe(false)
    expect(await sharePngImage(png(), '사진', platform)).toBe('unsupported')
    expect(native).not.toHaveBeenCalled()
  })
  it('passes a prepared PNG file to the OS without recompressing it', async () => {
    const file = png()
    const native = vi.fn(async () => {})
    const operation = sharePngImage(file, '사진 메모', { share: native, canShare: () => true })
    expect(native).toHaveBeenCalledWith({ files: [file], title: '사진 메모' })
    expect(await operation).toBe('shared')
    await expect(sharePngImage(new File(['webp'], 'file.webp', { type: 'image/webp' }), '사진', { share: native, canShare: () => true })).rejects.toThrow('PNG')
  })
  it('provides an explicit clipboard action and reports permission failures', async () => {
    const copy = vi.fn(async () => {})
    await copyNoteText('제목', '본문', { clipboard: { writeText: copy } })
    expect(copy).toHaveBeenCalledWith('제목\n\n본문')
    await expect(copyNoteText('제목', '본문', {})).rejects.toThrow('텍스트 파일')
    await expect(copyNoteText('제목', '본문', { clipboard: { writeText: async () => { throw new DOMException('denied', 'NotAllowedError') } } })).rejects.toThrow('텍스트 파일')
  })
  it('handles missing or blocked native APIs without throwing during capability checks', async () => {
    expect(supportsTextSharing({})).toBe(false)
    expect(supportsTextSharing({ share: async () => {}, canShare: () => { throw new Error('blocked') } })).toBe(false)
    expect(supportsFileSharing([], { share: async () => {}, canShare: () => true })).toBe(false)
    expect(await shareNoteText('제목', '', {})).toBe('unsupported')
    await expect(shareNoteText('', '   ', {})).rejects.toThrow('텍스트')
    expect(sharedNoteText('', '본문')).toBe('본문')
  })
  it('generates usable PNG filenames without stripping dots from note titles', () => {
    expect(pngFilename('photo.webp')).toBe('photo.png')
    expect(pngFilename('folder/photo:1.jpeg')).toBe('folder_photo_1.png')
    expect(pngFilename('.png')).toBe('moa-image.png')
    expect(safeFileStem('2026.11.25 기록')).toBe('2026.11.25 기록')
  })
})