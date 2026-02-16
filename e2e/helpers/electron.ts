// SPDX-License-Identifier: GPL-2.0-or-later

import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Launch the Electron app for E2E testing.
 * Requires a production build: run `pnpm build` before E2E tests.
 *
 * Set E2E_MODE=dev to use a running Vite dev server for the renderer.
 * The dev server URL defaults to http://localhost:5173 but can be
 * overridden via ELECTRON_RENDERER_URL. Only localhost URLs are
 * supported (CSP and navigation allowlist restrict other hosts).
 */
export async function launchApp(): Promise<{
  app: ElectronApplication
  page: Page
}> {
  const isDev = process.env.E2E_MODE === 'dev'
  const rendererUrl = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'

  // Build a clean env: strip ELECTRON_RENDERER_URL when not in dev mode
  // to prevent accidental dev behavior from shell environment leaking in.
  const { ELECTRON_RENDERER_URL: _stripped, ...cleanEnv } = process.env

  const app = await electron.launch({
    args: [
      resolve(PROJECT_ROOT, 'out/main/index.cjs'),
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...cleanEnv,
      ...(isDev ? { ELECTRON_RENDERER_URL: rendererUrl } : {}),
    },
  })

  // Wait for the first BrowserWindow to appear
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  return { app, page }
}
