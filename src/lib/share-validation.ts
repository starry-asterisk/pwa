const MAX_SHARE_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_SHARE_TOTAL_BYTES = 50 * 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

export class ShareValidationError extends Error {
  constructor(message: string, public status: number) {
    super(message)
    this.name = 'ShareValidationError'
  }
}

export function validateSharedForm(form: FormData): { title: string; text: string; files: File[] } {
  for (const [name, item] of form.entries()) {
    if (item instanceof File && !['images', 'title', 'text', 'url'].includes(name)) throw new ShareValidationError('지원하지 않는 첨부 파일이 있습니다. 이미지만 다시 공유해 주세요.', 415)
  }
  const rawFiles = form.getAll('images')
  if (rawFiles.length > 10) throw new ShareValidationError('이미지는 한 번에 10장까지 공유할 수 있습니다.', 413)
  const files: File[] = []
  let totalBytes = 0
  for (const item of rawFiles) {
    const extension = item instanceof File ? /\.(png|jpe?g|webp)$/i.exec(item.name)?.[1].toLowerCase() : undefined
    const inferredType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : extension ? 'image/jpeg' : ''
    const mime = item instanceof File && imageTypes.has(item.type) ? item.type
      : item instanceof File && (!item.type || item.type === 'application/octet-stream') ? inferredType : ''
    if (!(item instanceof File) || !mime) {
      throw new ShareValidationError('PNG, JPEG, WebP 이미지만 공유할 수 있습니다. 다른 파일을 제외하고 다시 공유해 주세요.', 415)
    }
    if (item.size === 0) throw new ShareValidationError('빈 이미지 파일은 공유할 수 없습니다.', 400)
    if (item.size > MAX_SHARE_IMAGE_BYTES) throw new ShareValidationError('이미지는 파일당 25MB 이하로 공유해 주세요.', 413)
    totalBytes += item.size
    if (totalBytes > MAX_SHARE_TOTAL_BYTES) throw new ShareValidationError('한 번에 공유하는 이미지의 전체 크기는 50MB 이하여야 합니다.', 413)
    files.push(item.type === mime ? item : new File([item], item.name, { type: mime, lastModified: item.lastModified }))
  }
  const title = form.get('title')
  const text = form.get('text')
  const url = form.get('url')
  if ([title, text, url].some(value => value !== null && typeof value !== 'string')) {
    throw new ShareValidationError('공유한 텍스트 형식이 올바르지 않습니다.', 400)
  }
  const parts = [text, url].filter((value): value is string => typeof value === 'string' && Boolean(value))
  const body = parts.filter((value, index) => parts.findIndex(part => part.trim() === value.trim()) === index).join('\n')
  if (body.length > 500_000) throw new ShareValidationError('공유할 텍스트가 너무 큽니다.', 413)
  if (!files.length && !(typeof title === 'string' && title.trim()) && !body.trim()) throw new ShareValidationError('공유할 텍스트나 이미지를 선택해 주세요.', 400)
  return { title: typeof title === 'string' ? title.slice(0, 200) : '', text: body, files }
}
