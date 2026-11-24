import { chromium } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  for (const [filename, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['apple-touch-icon.png', 180, false], ['icon-maskable.png', 512, true]]) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${maskable ? 0 : 18}" fill="#7161e8"/><path d="M18 18h13a15 15 0 0 1 15 15v13H33a15 15 0 0 1-15-15Z" fill="#fff"/><path d="M32 18v14h14" fill="none" stroke="#cec8ff" stroke-width="4"/></svg>`
    const data = await page.evaluate(async ({ svg, size }) => {
      const image = new Image()
      image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      canvas.getContext('2d').drawImage(image, 0, 0, size, size)
      return canvas.toDataURL('image/png').split(',')[1]
    }, { svg, size })
    await writeFile(new URL(`../public/${filename}`, import.meta.url), Buffer.from(data, 'base64'))
  }
  console.log('Generated four local PWA icons.')
} finally { await browser.close() }