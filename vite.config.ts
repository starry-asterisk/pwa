import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
const base = process.env.VITE_BASE_PATH || '/pwa/'
export default defineConfig({
  base,
  plugins: [react(), VitePWA({
    strategies: 'injectManifest', srcDir: 'src', filename: 'sw.ts',
    registerType: 'prompt', injectRegister: null,
    includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
    injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,wasm,woff2}'], maximumFileSizeToCacheInBytes: 5_000_000 },
    manifest: {
      id: base, name: '모아 · 나의 작은 기록함', short_name: '모아',
      description: '메모와 이미지를 담아 두고, 내 기기에서 이어 쓰는 개인 기록함',
      lang: 'ko', start_url: base, scope: base,
      display: 'standalone', background_color: '#f7f8fc', theme_color: '#7161e8',
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: 'icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      share_target: { action: `${base}share`, method: 'POST', enctype: 'multipart/form-data',
        params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'images', accept: ['image/png', 'image/jpeg', 'image/webp'] }] } },
    },
  })],
  optimizeDeps: { exclude: ['@jsquash/webp'] },
  build: { target: 'es2022' },
})