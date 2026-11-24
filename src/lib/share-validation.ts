const MAX_SHARE_IMAGE_BYTES = 25 * 1024 * 1024
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])

export class ShareValidationError extends Error {
  constructor(message: string, public status: number) {
    super(message)
    this.name = 'ShareValidationError'
  }
}

export function validateSharedForm(form: FormData): { title: string; text: string; files: File[] } {
  const rawFiles = form.getAll('images')
  if (rawFiles.length > 10) throw new ShareValidationError('이미지는 한 번에 10장까지 공유할 수 있습니다.', 413)
  const files: File[] = []
  for (const item of rawFiles) {
    if (!(item instanceof File) || !imageTypes.has(item.type)) {
      throw new ShareValidationError('PNG, JPEG, WebP 이미지만 공유할 수 있습니다. 다른 파일을 제외하고 다시 공유해 주세요.', 415)
    }
    if (item.size === 0) throw new ShareValidationError('빈 이미지 파일은 공유할 수 없습니다.', 400)
    if (item.size > MAX_SHARE_IMAGE_BYTES) throw new ShareValidationError('이미지는 파일당 25MB 이하로 공유해 주세요.', 413)
    files.push(item)
  }
  const title = form.get('title')
  const text = form.get('text')
  const url = form.get('url')
  if ([title, text, url].some(value => value !== null && typeof value !== 'string')) {
    throw new ShareValidationError('공유한 텍스트 형식이 올바르지 않습니다.', 400)
  }
  const body = [text, url].filter(value => typeof value === 'string' && value).join('\n')
  if (body.length > 500_000) throw new ShareValidationError('공유할 텍스트가 너무 큽니다.', 413)
  return { title: typeof title === 'string' ? title.slice(0, 200) : '', text: body, files }
}
