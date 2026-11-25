import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'

async function makeCapture(page: Page) {
  const width = 80
  const height = 32
  const title = 'Windows 화면 캡처'
  const text = '영역에서 읽어낸 텍스트 · Snapshot 42'
  const png = Buffer.from(await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    context.fillStyle = '#f4f0ff'
    context.fillRect(0, 0, width, height)
    context.fillStyle = '#413562'
    context.fillText('Snapshot 42', 6, 20)
    return canvas.toDataURL('image/png').split(',')[1]
  }, { width, height }), 'base64')
  const id = randomUUID()
  const manifest = {
    format: 'moa-capture', schemaVersion: 1, id, createdAt: new Date().toISOString(), title, text,
    image: { path: 'image.png', name: 'capture.png', mime: 'image/png', size: png.byteLength, width, height },
  }
  const file = Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), 'image.png': png }, { level: 0 }))
  return { id, title, text, file }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/145.0.0.0' })
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: { setConsumer(consumer: (params: unknown) => void) { Reflect.set(window, '__moaFileLaunchConsumer', consumer) } },
    })
  })
  await page.route(/^https?:\/\//, route => new URL(route.request().url()).origin === 'http://127.0.0.1:4173' ? route.continue() : route.abort())
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1, name: /모든 메모/ })).toBeVisible()
})

async function openFromWindows(page: Page, file: Buffer) {
  await page.waitForFunction(() => typeof Reflect.get(window, '__moaFileLaunchConsumer') === 'function')
  await page.evaluate(encoded => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    const capture = new File([bytes], 'windows.moacapture', { type: 'application/vnd.moa.capture+zip' })
    Reflect.get(window, '__moaFileLaunchConsumer')({ files: [{ kind: 'file', getFile: async () => capture }] })
  }, file.toString('base64'))
}

test('accepts the Windows file launch, waits for the current editor, and saves the image and OCR as one note', async ({ page }) => {
  const response = await page.request.get('./manifest.webmanifest')
  expect(response.ok()).toBe(true)
  const manifest = await response.json()
  expect(manifest.file_handlers).toContainEqual({
    action: manifest.scope, accept: { 'application/vnd.moa.capture+zip': ['.moacapture'] },
  })
  const capture = await makeCapture(page)
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  const titleInput = editor.getByRole('textbox', { name: '메모 제목' })
  const complete = editor.getByRole('button', { name: '완료', exact: true })
  await page.locator('.heading-new').click()
  await titleInput.fill('캡처 전에 작성하던 메모')

  await openFromWindows(page, capture.file)
  await expect(titleInput).toHaveValue('캡처 전에 작성하던 메모')
  await complete.click()
  await expect(titleInput).toHaveValue(capture.title)
  await expect(editor.getByRole('textbox', { name: '메모 내용' })).toHaveValue(capture.text)
  await expect(editor.getByRole('img', { name: 'capture.png', exact: true })).toBeVisible()
  await expect(editor.getByText(/· WebP/)).toBeVisible()
  await complete.click()
  const card = page.getByRole('button', { name: `${capture.title} 메모 열기`, exact: true })
  await expect(card).toHaveCount(1)

  await openFromWindows(page, capture.file)
  await expect(titleInput).toHaveValue(capture.title)
  await complete.click()
  await expect(card).toHaveCount(1)
})

test('imports a saved capture file from Settings and exposes the GitHub installer', async ({ page }) => {
  const capture = await makeCapture(page)
  await page.getByRole('button', { name: '설정 열기', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '설정', exact: true })
  await expect(settings.getByRole('link', { name: 'Windows 보조 앱 설치 파일' })).toHaveAttribute(
    'href', 'https://github.com/starry-asterisk/pwa/releases/latest/download/Moa-Setup.exe',
  )
  await settings.getByLabel('모아 캡처 파일').setInputFiles({
    name: 'fallback.moacapture', mimeType: 'application/octet-stream', buffer: capture.file,
  })
  await expect(settings).toHaveCount(0)
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  await expect(editor.getByRole('textbox', { name: '메모 내용' })).toHaveValue(capture.text)
  await expect(editor.getByRole('img', { name: 'capture.png', exact: true })).toBeVisible()
})

test('recovers a capture when the browser blocks reading its OS file handle', async ({ page }) => {
  const capture = await makeCapture(page)
  await page.waitForFunction(() => typeof Reflect.get(window, '__moaFileLaunchConsumer') === 'function')
  await page.evaluate(() => {
    Reflect.get(window, '__moaFileLaunchConsumer')({ files: [{
      kind: 'file',
      getFile: async () => { throw new DOMException('An attempt was made to break through the security policy of the user agent.', 'SecurityError') },
    }] })
  })
  const recovery = page.getByRole('alert')
  await expect(recovery).toContainText('브라우저가 전달된 캡처 파일의 읽기를 허용하지 않았어요.')
  const fileChooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '캡처 파일 선택', exact: true }).click()
  await (await fileChooser).setFiles({
    name: 'retained.moacapture', mimeType: 'application/octet-stream', buffer: capture.file,
  })
  await expect(recovery).toHaveCount(0)
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  await expect(editor.getByRole('textbox', { name: '메모 내용' })).toHaveValue(capture.text)
  await expect(editor.getByRole('img', { name: 'capture.png', exact: true })).toBeVisible()
})
