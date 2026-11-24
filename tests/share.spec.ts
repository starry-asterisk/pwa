import { expect, test, type Page } from '@playwright/test'

async function newNote(page: Page, title: string, body: string) {
  await page.locator('.heading-new').click()
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  await editor.getByRole('textbox', { name: '메모 제목', exact: true }).fill(title)
  await editor.getByRole('textbox', { name: '메모 내용', exact: true }).fill(body)
  return editor
}
async function pngBase64(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 32; canvas.height = 24
    const context = canvas.getContext('2d')!
    context.fillStyle = '#715de7'; context.fillRect(0, 0, 20, 24)
    context.fillStyle = 'rgba(255, 0, 0, 0.5)'; context.fillRect(24, 8, 8, 8)
    return canvas.toDataURL('image/png').split(',')[1]
  })
}
async function sharePayload(page: Page) { return page.evaluate(() => Reflect.get(window, '__moaShare')) }

test.beforeEach(async ({ page }) => {
  await page.route(/^https?:\/\//, route => new URL(route.request().url()).origin === 'http://127.0.0.1:4173' ? route.continue() : route.abort())
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => {
      const active = navigator.userActivation.isActive
      const files = await Promise.all((data.files || []).map(async file => ({
        name: file.name, type: file.type, bytes: [...new Uint8Array(await file.arrayBuffer()).slice(0, 8)],
      })))
      Reflect.set(window, '__moaShare', { title: data.title, text: data.text, url: data.url, files, active })
    } })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { Reflect.set(window, '__moaCopied', value) } } })
  })
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1, name: /모든 메모/ })).toBeVisible()
})

test('shares the current note draft through the OS API from an active user gesture', async ({ page }) => {
  const editor = await newNote(page, '내 기기로 보낼 메모', '아직 편집 중인 최신 내용입니다.')
  await editor.getByRole('button', { name: '메모 공유', exact: true }).click()
  const share = page.getByRole('dialog', { name: '다른 앱으로 보내기', exact: true })
  await share.getByRole('button', { name: '텍스트 공유', exact: true }).click()
  await expect.poll(() => sharePayload(page)).toMatchObject({ title: '내 기기로 보낼 메모', text: '내 기기로 보낼 메모\n\n아직 편집 중인 최신 내용입니다.', active: true, files: [] })
  expect((await sharePayload(page)).url).toBeUndefined()
  await share.getByRole('button', { name: '공유 닫기', exact: true }).click()
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('textbox', { name: '메모 내용', exact: true })).toHaveValue('아직 편집 중인 최신 내용입니다.')
})

test('cancelling the OS sheet leaves the note intact without copying content', async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: async () => { throw new DOMException('cancelled', 'AbortError') } }))
  const editor = await newNote(page, '취소해도 유지할 메모', '원본 내용')
  await editor.getByRole('button', { name: '메모 공유', exact: true }).click()
  const share = page.getByRole('dialog', { name: '다른 앱으로 보내기', exact: true })
  await share.getByRole('button', { name: '텍스트 공유', exact: true }).click()
  await expect(share.getByRole('button', { name: '텍스트 공유', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => Reflect.get(window, '__moaCopied'))).toBeUndefined()
  await page.keyboard.press('Escape')
  await expect(share).toHaveCount(0)
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('textbox', { name: '메모 내용', exact: true })).toHaveValue('원본 내용')
})

test('falls back to explicit text copy and text download when OS sharing is unsupported', async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }))
  const editor = await newNote(page, '복사할 메모', '클립보드와 파일로 보낼 내용')
  await editor.getByRole('button', { name: '메모 공유', exact: true }).click()
  const share = page.getByRole('dialog', { name: '다른 앱으로 보내기', exact: true })
  await expect(share.getByRole('button', { name: '텍스트 공유', exact: true })).toHaveCount(0)
  await share.getByRole('button', { name: '텍스트 복사', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__moaCopied'))).toBe('복사할 메모\n\n클립보드와 파일로 보낼 내용')
  const downloadEvent = page.waitForEvent('download')
  await share.getByRole('button', { name: '텍스트 파일 저장', exact: true }).click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toBe('복사할 메모.txt')
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).toString('utf8')).toBe('복사할 메모\n\n클립보드와 파일로 보낼 내용')
})

test('prepares a real PNG before sharing an image and keeps the stored image as WebP', async ({ page }) => {
  const bytes = await pngBase64(page)
  const editor = await newNote(page, '이미지 공유 메모', '공유할 이미지')
  await editor.getByLabel('이미지 파일 선택', { exact: true }).setInputFiles({ name: 'shared-image.png', mimeType: 'image/png', buffer: Buffer.from(bytes, 'base64') })
  await expect(editor.getByRole('img', { name: 'shared-image.png', exact: true })).toBeVisible()
  await editor.getByRole('button', { name: 'shared-image.png 공유', exact: true }).click()
  const share = page.getByRole('dialog', { name: '다른 앱으로 보내기', exact: true })
  await expect(share.getByRole('button', { name: '이미지 공유', exact: true })).toBeEnabled()
  await share.getByRole('button', { name: '이미지 공유', exact: true }).click()
  await expect.poll(() => sharePayload(page)).toMatchObject({ active: true, files: [{ name: 'shared-image.png', type: 'image/png', bytes: [137, 80, 78, 71, 13, 10, 26, 10] }] })
  const types = await page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open('moa-notes')
    request.onsuccess = () => {
      const database = request.result
      const get = database.transaction('images', 'readonly').objectStore('images').getAll()
      get.onsuccess = () => { database.close(); resolve(get.result.map(image => image.blob.type)) }
      get.onerror = () => { database.close(); reject(get.error) }
    }
  }))
  expect(types).toEqual(['image/webp'])
})

test('receives a real multipart OS-share navigation through the manifest service-worker target', async ({ page }) => {
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!.href
    return fetch(href).then(response => response.json())
  })
  expect(manifest.share_target).toMatchObject({ method: 'POST', enctype: 'multipart/form-data', params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'images', accept: ['image/png', 'image/jpeg', 'image/webp', '.png', '.jpg', '.jpeg', '.webp'] }] } })
  const target = new URL(manifest.share_target.action, page.url())
  expect(target.pathname).toBe('/pwa/share')
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const bytes = await pngBase64(page)
  await page.evaluate(({ action, bytes }) => {
    const form = document.createElement('form')
    form.action = action; form.method = 'POST'; form.enctype = 'multipart/form-data'
    for (const [name, value] of Object.entries({ title: '다른 앱에서 받은 메모', text: '휴대전화에서 보내온 텍스트', url: 'https://example.com/shared' })) {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input)
    }
    const file = new File([Uint8Array.from(atob(bytes), character => character.charCodeAt(0))], 'inbound-image.png', { type: 'image/png' })
    const files = new DataTransfer(); files.items.add(file)
    const input = document.createElement('input'); input.type = 'file'; input.name = 'images'; input.files = files.files; form.append(input)
    document.body.append(form); form.submit()
  }, { action: target.href, bytes })
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  await expect(editor.getByRole('textbox', { name: '메모 제목', exact: true })).toHaveValue('다른 앱에서 받은 메모')
  await expect(editor.getByRole('textbox', { name: '메모 내용', exact: true })).toHaveValue('휴대전화에서 보내온 텍스트\nhttps://example.com/shared')
  await expect(editor.getByRole('img', { name: 'inbound-image.png', exact: true })).toBeVisible()
  await expect(page).not.toHaveURL(/capture=/)
  await editor.getByRole('button', { name: '완료', exact: true }).click()
  await page.reload()
  const card = page.getByRole('button', { name: '다른 앱에서 받은 메모 메모 열기', exact: true })
  await expect(card).toBeVisible()
  await expect(card.getByRole('img', { name: 'inbound-image.png', exact: true })).toBeVisible()
})

test('rejects malformed inbound sharing at the service-worker boundary', async ({ page }) => {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const statuses = await page.evaluate(async () => {
    const action = new URL('share', location.href)
    const empty = await fetch(action, { method: 'POST', body: new FormData() })
    const mixed = new FormData()
    mixed.set('text', '남길 내용')
    mixed.set('images', new File(['document'], 'file.html', { type: 'text/html' }))
    const unsupported = await fetch(action, { method: 'POST', body: mixed })
    return [empty.status, unsupported.status]
  })
  expect(statuses).toEqual([400, 415])
  await expect(page.locator('.note-card')).toHaveCount(0)
})