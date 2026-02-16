// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Quick screenshot utility for visual inspection during development.
 *
 * Launches the Electron app, waits for the renderer to load, captures
 * a screenshot, and exits. Does not require a connected keyboard device.
 *
 * Usage:
 *   # With dev server (requires pnpm dev:linux in another terminal):
 *   npx tsx e2e/helpers/screenshot-quick.ts
 *
 *   # Custom output path:
 *   npx tsx e2e/helpers/screenshot-quick.ts /tmp/my-screenshot.png
 *
 *   # Custom wait time (ms) before capture:
 *   WAIT_MS=5000 npx tsx e2e/helpers/screenshot-quick.ts
 */

import { _electron as electron } from '@playwright/test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_OUTPUT = '/tmp/vial-screenshot.png'
const DEFAULT_WAIT_MS = 3000

async function main(): Promise<void> {
  const outputPath = process.argv[2] || DEFAULT_OUTPUT
  const waitMs = Number(process.env.WAIT_MS) || DEFAULT_WAIT_MS

  console.log(`Launching app (wait ${waitMs}ms)...`)

  const app = await electron.launch({
    args: [
      resolve(PROJECT_ROOT, 'out/main/index.cjs'),
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL:
        process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173',
    },
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(waitMs)

  await page.screenshot({ path: outputPath, fullPage: true })
  console.log(`Screenshot saved: ${outputPath}`)

  await app.close()
}

main().catch((err: unknown) => {
  console.error('Screenshot failed:', err)
  process.exit(1)
})
