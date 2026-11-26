import { expect, test, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const assetsDirectory = fileURLToPath(new URL('../.cache/test-assets/', import.meta.url))

async function startNote(page: Page, title: string, body: string, tags = '') {
  await page.locator('.heading-new').click()
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  await editor.getByRole('textbox', { name: '메모 제목', exact: true }).fill(title)
  await editor.getByRole('textbox', { name: '메모 내용', exact: true }).fill(body)
  if (tags) await editor.getByRole('textbox', { name: '태그', exact: true }).fill(tags)
  return editor
}

async function finishNote(page: Page) {
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  await editor.getByRole('button', { name: '완료', exact: true }).click()
  await expect(editor).toHaveCount(0)
}

async function snapshot(page: Page) {
  return page.evaluate(() => new Promise<{
    notes: Array<{ id: string; title: string; body: string; tags: string[]; cloudOwnerId: string | null }>
    images: Array<{ mime: string; blobType: string; size: number; width: number; height: number }>
  }>((resolve, reject) => {
    const request = indexedDB.open('moa-notes')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction(['notes', 'images'], 'readonly')
      const noteRequest = transaction.objectStore('notes').getAll()
      const imageRequest = transaction.objectStore('images').getAll()
      transaction.onerror = () => { database.close(); reject(transaction.error) }
      transaction.oncomplete = () => {
        resolve({ notes: noteRequest.result.map(note => ({ id: note.id, title: note.title, body: note.body, tags: note.tags, cloudOwnerId: note.cloudOwnerId })),
          images: imageRequest.result.map(image => ({ mime: image.mime, blobType: image.blob.type, size: image.blob.size, width: image.width, height: image.height })) })
        database.close()
      }
    }
  }))
}

async function createPngFixture(page: Page) {
  const fixture = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 160; canvas.height = 96
    const context = canvas.getContext('2d')!
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 110, 96)
    context.fillStyle = '#141424'; context.font = '16px sans-serif'; context.fillText('Memo 123', 5, 24)
    context.fillStyle = '#7361e8'; context.fillRect(8, 40, 60, 22)
    context.fillStyle = 'rgba(255, 0, 0, 0.5)'; context.fillRect(120, 12, 24, 24)
    context.fillStyle = 'rgba(0, 0, 255, 0.5)'; context.fillRect(120, 55, 24, 24)
    const png = canvas.toDataURL('image/png')
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('')
    return { png, hash }
  })
  await mkdir(assetsDirectory, { recursive: true })
  const path = join(assetsDirectory, 'roundtrip.png')
  await writeFile(path, Buffer.from(fixture.png.split(',')[1], 'base64'))
  return { path, hash: fixture.hash }
}

async function pngFingerprint(page: Page, bytes: Buffer) {
  return page.evaluate(async base64 => {
    const source = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([source], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width; canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('')
    return { hash, width: canvas.width, height: canvas.height }
  }, bytes.toString('base64'))
}

async function expectNoHorizontalOverflow(page: Page, selector = 'html') {
  await expect.poll(() => page.locator(selector).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
}

test.beforeEach(async ({ page }) => {
  // Browser tests remain local even when this build has a real cloud project configured.
  await page.route(/^https?:\/\//, route => new URL(route.request().url()).origin === 'http://127.0.0.1:4173' ? route.continue() : route.abort())
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1, name: /모든 메모/ })).toBeVisible()
})

test('saves title, body and tags across reload, searches, pins, and restores a trashed note', async ({ page }) => {
  const title = '디바이스를 이어 쓰는 기록'
  await startNote(page, title, '검색으로 찾을 유일한 본문입니다.', '일상, 디자인')
  await finishNote(page)
  const card = page.getByRole('button', { name: `${title} 메모 열기`, exact: true })
  await expect(card).toBeVisible()
  await page.reload()
  await card.click()
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  await expect(editor.getByRole('textbox', { name: '메모 제목', exact: true })).toHaveValue(title)
  await expect(editor.getByRole('textbox', { name: '메모 내용', exact: true })).toHaveValue('검색으로 찾을 유일한 본문입니다.')
  await expect(editor.getByRole('textbox', { name: '태그', exact: true })).toHaveValue('일상, 디자인')
  await finishNote(page)
  const search = page.getByRole('searchbox', { name: '메모 검색' })
  await search.fill('유일한 본문')
  await expect(card).toBeVisible()
  await search.fill('여기에는 없는 단어')
  await expect(card).toHaveCount(0)
  await search.fill('디자인')
  await expect(card).toBeVisible()
  await search.clear()
  await card.getByRole('button', { name: '메모 고정', exact: true }).click()
  await page.getByRole('navigation', { name: '메모 분류' }).getByRole('button', { name: /고정한 메모/ }).click()
  await expect(card).toBeVisible()
  await card.click()
  await editor.getByRole('button', { name: '휴지통으로 이동', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(card).toHaveCount(0)
  await page.getByRole('navigation', { name: '메모 분류' }).getByRole('button', { name: /휴지통/ }).click()
  await card.click()
  await editor.getByRole('button', { name: '메모 복원', exact: true }).click()
  await page.getByRole('navigation', { name: '메모 분류' }).getByRole('button', { name: /모든 메모/ }).click()
  await expect(card).toBeVisible()
  expect((await snapshot(page)).notes).toHaveLength(1)
})

test('stores a PNG as WebP and downloads a lossless PNG with text and alpha pixels intact', async ({ page }) => {
  const fixture = await createPngFixture(page)
  const editor = await startNote(page, '무손실 이미지 기록', '투명도와 작은 글자를 보존합니다.')
  await editor.getByLabel('이미지 파일 선택', { exact: true }).setInputFiles(fixture.path)
  await expect(editor.getByRole('img', { name: 'roundtrip.png', exact: true })).toBeVisible()
  await expect.poll(async () => (await snapshot(page)).images.length).toBe(1)
  const stored = (await snapshot(page)).images[0]
  expect(stored).toMatchObject({ mime: 'image/webp', blobType: 'image/webp', width: 160, height: 96 })
  expect(stored.size).toBeGreaterThan(0)
  const downloadEvent = page.waitForEvent('download')
  await editor.getByRole('button', { name: 'roundtrip.png PNG로 다운로드', exact: true }).click()
  const download = await downloadEvent
  const output = join(assetsDirectory, 'roundtrip-download.png')
  await download.saveAs(output)
  expect(download.suggestedFilename()).toBe('roundtrip.png')
  const bytes = await readFile(output)
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(await pngFingerprint(page, bytes)).toEqual({ hash: fixture.hash, width: 160, height: 96 })
  expect((await snapshot(page)).images).toHaveLength(1)
})

test('mobile Back closes the note, saves its last edit, and restores the filtered list', async ({ page }) => {
  const title = '뒤로가기 확인용 메모'
  await startNote(page, title, '기존 메모')
  await finishNote(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const search = page.getByRole('searchbox', { name: '메모 검색' })
  await search.fill(title)
  const card = page.getByRole('button', { name: `${title} 메모 열기`, exact: true })
  const listUrl = page.url()
  await card.click()
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  await editor.getByRole('button', { name: '메모 공유', exact: true }).click()
  const shareDialog = page.getByRole('dialog', { name: '다른 앱으로 보내기', exact: true })
  await expect(shareDialog).toBeVisible()
  await page.goBack({ waitUntil: 'commit' })
  await expect(shareDialog).toHaveCount(0)
  await editor.getByRole('textbox', { name: '메모 내용', exact: true }).fill('뒤로가기 직전의 마지막 수정')

  await page.goBack({ waitUntil: 'commit' })
  await expect(editor).toHaveCount(0)
  expect(page.url()).toBe(listUrl)
  await expect(search).toHaveValue(title)
  await card.click()
  await expect(editor.getByRole('textbox', { name: '메모 내용', exact: true })).toHaveValue('뒤로가기 직전의 마지막 수정')
  await finishNote(page)
})

test('imports a ZIP backup as new notes while preserving subsequent edits to existing notes', async ({ page }) => {
  await startNote(page, '백업 당시 제목', '백업 당시 내용')
  await finishNote(page)
  await page.getByRole('button', { name: '설정 열기', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '설정', exact: true })
  const downloadEvent = page.waitForEvent('download')
  await settings.getByRole('button', { name: '백업 내보내기', exact: true }).click()
  const download = await downloadEvent
  await mkdir(assetsDirectory, { recursive: true })
  const backup = join(assetsDirectory, 'notes-backup.zip')
  await download.saveAs(backup)
  await settings.getByRole('button', { name: '설정 닫기', exact: true }).click()
  await page.getByRole('button', { name: '백업 당시 제목 메모 열기', exact: true }).click()
  await page.getByRole('textbox', { name: '메모 제목', exact: true }).fill('백업 후에 수정한 제목')
  await page.getByRole('textbox', { name: '메모 내용', exact: true }).fill('덮어쓰면 안 되는 최신 내용')
  await finishNote(page)
  await page.getByRole('button', { name: '설정 열기', exact: true }).click()
  await settings.getByLabel('백업 ZIP 파일', { exact: true }).setInputFiles(backup)
  await expect.poll(async () => (await snapshot(page)).notes.length).toBe(2)
  const notes = (await snapshot(page)).notes
  expect(notes).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: '백업 당시 제목', body: '백업 당시 내용', cloudOwnerId: null }),
    expect.objectContaining({ title: '백업 후에 수정한 제목', body: '덮어쓰면 안 되는 최신 내용' }),
  ]))
  expect(new Set(notes.map(note => note.id)).size).toBe(2)
})

test('reloads offline and creates a persisted note with a WebP image using cached app assets', async ({ page, context }) => {
  const fixture = await createPngFixture(page)
  await startNote(page, '온라인에서 적은 메모', '오프라인에서도 볼 수 있습니다.')
  await finishNote(page)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: '온라인에서 적은 메모 메모 열기', exact: true })).toBeVisible()
  await expect(page.locator('.sync-status')).toContainText('오프라인')
  const editor = await startNote(page, '오프라인에서 새로 쓴 메모', '인터넷 없이도 기록을 남깁니다.')
  await editor.getByLabel('이미지 파일 선택', { exact: true }).setInputFiles(fixture.path)
  await expect(editor.getByRole('img', { name: 'roundtrip.png', exact: true })).toBeVisible()
  await finishNote(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const card = page.getByRole('button', { name: '오프라인에서 새로 쓴 메모 메모 열기', exact: true })
  await expect(card).toBeVisible()
  await expect(card.getByRole('img', { name: 'roundtrip.png', exact: true })).toBeVisible()
  expect((await snapshot(page)).images[0].blobType).toBe('image/webp')
})

test('renders Markdown without running embedded scripts or JavaScript links', async ({ page }) => {
  const editor = await startNote(page, '안전한 Markdown', '# 안전한 미리보기\n\n<script>window.__moaXss = true</script>\n<img src=x onerror="window.__moaXss=true">\n\n[위험한 링크](javascript:window.__moaXss=true)')
  await editor.getByRole('button', { name: '미리보기', exact: true }).click()
  await expect(editor.getByRole('heading', { name: '안전한 미리보기', exact: true })).toBeVisible()
  await expect(editor.locator('.markdown script, .markdown img, .markdown a[href^="javascript:"]')).toHaveCount(0)
  expect(await page.evaluate(() => Reflect.get(window, '__moaXss'))).toBeUndefined()
})

test('keeps the workspace, settings tabs, and note editor within 320px and 390px screens', async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expectNoHorizontalOverflow(page)
    const trigger = page.getByRole('button', { name: '설정 열기', exact: true })
    await trigger.click()
    const settings = page.getByRole('dialog', { name: '설정', exact: true })
    for (const label of ['일반', '동기화', '알림']) {
      await settings.getByRole('tab', { name: label, exact: true }).click()
      await expectNoHorizontalOverflow(page, '.settings-dialog')
      const bounds = await settings.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(-1)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
    }
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.locator('.mobile-fab').click()
    const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
    await editor.getByRole('textbox', { name: '메모 제목', exact: true }).fill(`휴대폰 ${width}px 기록`)
    await editor.getByRole('textbox', { name: '메모 내용', exact: true }).fill('작은 화면에서도 편하게 기록합니다.')
    await expectNoHorizontalOverflow(page, '.editor-dialog')
    await finishNote(page)
    await expectNoHorizontalOverflow(page)
  }
})

test('moves and permanently deletes a selected batch only after confirmation', async ({ page }) => {
  const fixture = await createPngFixture(page)
  const first = await startNote(page, '첫 번째 삭제 메모', '첨부 파일도 함께 정리합니다.')
  await first.getByLabel('이미지 파일 선택', { exact: true }).setInputFiles(fixture.path)
  await expect(first.getByRole('img', { name: 'roundtrip.png', exact: true })).toBeVisible()
  await finishNote(page)
  await startNote(page, '두 번째 삭제 메모', '두 메모를 한 번에 선택합니다.')
  await finishNote(page)

  const note = (title: string, action: string) => page.getByRole('button', { name: `${title} ${action}`, exact: true })
  await page.getByRole('button', { name: '선택', exact: true }).click()
  await note('첫 번째 삭제 메모', '선택').press('Space')
  await note('두 번째 삭제 메모', '선택').click()
  await expect(page.getByText('2개 선택', { exact: true })).toBeVisible()

  const search = page.getByRole('searchbox', { name: '메모 검색' })
  await search.fill('두 번째')
  await expect(note('두 번째 삭제 메모', '메모 열기')).toBeVisible()
  await search.clear()
  await page.getByRole('button', { name: '선택', exact: true }).click()

  await note('첫 번째 삭제 메모', '선택').click()
  await note('두 번째 삭제 메모', '선택').click()
  await page.getByRole('button', { name: '휴지통으로 이동', exact: true }).click()
  await expect(note('첫 번째 삭제 메모', '메모 열기')).toHaveCount(0)
  await page.getByRole('navigation', { name: '메모 분류' }).getByRole('button', { name: /휴지통/ }).click()
  await expect(note('두 번째 삭제 메모', '메모 열기')).toBeVisible()

  await note('첫 번째 삭제 메모', '메모 열기').click()
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  await editor.getByRole('button', { name: '영구 삭제', exact: true }).click()
  const individualConfirmation = page.getByRole('dialog', { name: '메모 1개를 영구 삭제할까요?', exact: true })
  await expect(individualConfirmation.getByRole('button', { name: '취소' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(individualConfirmation).toHaveCount(0)
  await expect(editor).toBeVisible()
  await finishNote(page)

  await page.getByRole('button', { name: '선택', exact: true }).click()
  await note('첫 번째 삭제 메모', '선택').click()
  await note('두 번째 삭제 메모', '선택').click()
  const purge = page.getByRole('button', { name: '영구 삭제', exact: true })
  await purge.click()
  const confirmation = page.getByRole('dialog', { name: '메모 2개를 영구 삭제할까요?', exact: true })
  await confirmation.getByRole('button', { name: '취소' }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.getByText('2개 선택', { exact: true })).toBeVisible()
  expect((await snapshot(page)).notes).toHaveLength(2)

  await purge.click()
  await confirmation.getByRole('button', { name: '영구 삭제', exact: true }).click()
  await expect(page.getByRole('heading', { name: '휴지통이 비어 있어요' })).toBeVisible()
  expect(await snapshot(page)).toEqual({ notes: [], images: [] })
  await page.reload()
  await expect(note('첫 번째 삭제 메모', '메모 열기')).toHaveCount(0)
})

test('touch long press selects a note without opening it and moving cancels selection', async ({ page }) => {
  const title = '길게 눌러 선택할 메모'
  await startNote(page, title, '카드를 눌러 이동한 뒤 다시 길게 누릅니다.')
  await finishNote(page)
  await page.setViewportSize({ width: 390, height: 650 })
  const touch = await page.context().newCDPSession(page)
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })

  const card = page.getByRole('button', { name: `${title} 메모 열기`, exact: true })
  const selectedCard = page.getByRole('button', { name: `${title} 선택`, exact: true })
  const editor = page.getByRole('dialog', { name: '메모 편집', exact: true })
  async function beginTouch() {
    await card.scrollIntoViewIfNeeded()
    const box = (await card.boundingBox())!
    const point = { x: Math.round(box.x + 60), y: Math.round(box.y + 85) }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    return point
  }
  const point = await beginTouch()
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y - 48 }] })
  await page.waitForTimeout(550)
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(selectedCard).toHaveCount(0)
  await expect(editor).toHaveCount(0)

  await beginTouch()
  await expect(selectedCard).toHaveAttribute('aria-pressed', 'true')
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(page.getByText('1개 선택', { exact: true })).toBeVisible()
  await expect(selectedCard).toHaveAttribute('aria-pressed', 'true')
  await expect(editor).toHaveCount(0)
  await expectNoHorizontalOverflow(page)
})
