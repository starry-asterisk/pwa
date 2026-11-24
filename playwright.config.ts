import { defineConfig, devices } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))
const temporary = join(root, '.cache', 'tmp')
const basePath = process.env.VITE_BASE_PATH || '/pwa/'
mkdirSync(temporary, { recursive: true })
process.env.TEMP = temporary
process.env.TMP = temporary
process.env.npm_config_cache = join(root, '.cache', 'npm')
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, '.cache', 'browsers')

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: '.cache/playwright-results',
  reporter: [['list'], ['html', { outputFolder: '.cache/playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:4173${basePath}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 1365, height: 900 },
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    acceptDownloads: true,
    serviceWorkers: 'allow',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: `http://127.0.0.1:4173${basePath}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
