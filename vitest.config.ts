import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({ test: {
  environment: 'node', setupFiles: ['src/test/setup.ts'], include: ['src/**/*.test.ts'],
  alias: { 'virtual:pwa-register': fileURLToPath(new URL('./src/test/pwa-register.ts', import.meta.url)) },
} })
