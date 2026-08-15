// SPDX-License-Identifier: GPL-2.0-or-later

import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export interface LaunchAppOptions {
  /**
   * Runs after Electron's main process is up but before the first
   * BrowserWindow is awaited — the right spot to seed master files
   * into the userData directory so `ensureCacheIsFresh` rebuilds the
   * SQLite cache from them as the renderer loads.
   */
  onMainReady?: (ctx: { app: ElectronApplication; userDataPath: string }) => Promise<void>
  /** Extra environment variables for the launched process, merged in last (override shell env). */
  env?: Record<string, string>
}

/**
 * Launch the Electron app for E2E testing.
 * Requires a production build: run `pnpm build` before E2E tests.
 *
 * Set E2E_MODE=dev to use a running Vite dev server for the renderer.
 * The dev server URL defaults to http://localhost:5173 but can be
 * overridden via ELECTRON_RENDERER_URL. Only localhost URLs are
 * supported (CSP and navigation allowlist restrict other hosts).
 */
export async function launchApp(opts: LaunchAppOptions = {}): Promise<{
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
      resolve(PROJECT_ROOT, 'out/main/index.js'),
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...cleanEnv,
      ...(isDev ? { ELECTRON_RENDERER_URL: rendererUrl } : {}),
      ...opts.env,
    },
  })

  if (opts.onMainReady) {
    const userDataPath = await app.evaluate(async ({ app: a }) => a.getPath('userData'))
    await opts.onMainReady({ app, userDataPath })
  }

  // Wait for the first BrowserWindow to appear
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  return { app, page }
}

/** Reads and parses a userData JSON file (config.json, pipette_settings.json,
 * etc.), returning null when the file is missing or not valid JSON — the
 * common shape every suite that mutates userData directly needs to inspect
 * what a previous session persisted. */
export function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> } catch { return null }
}

/** Whether the app's Electron process is currently running (matched by its
 * command line, not a PID we hold) — used to serialize test sessions that
 * mutate the shared userData dir and must never overlap. */
export function electronRunning(): boolean {
  try {
    // [n] bracket trick keeps this pgrep's own `sh -c` wrapper (whose
    // command line contains the pattern text) from matching itself.
    execSync('pgrep -f "electron/dist/electro[n].*out/main/index.js"', { stdio: 'pipe' })
    return true
  } catch { return false }
}

/** Blocks until no matching Electron process remains, polling rather than a
 * fixed sleep since process teardown time varies with system load. */
export async function waitForElectronExit(timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (electronRunning()) {
    if (Date.now() - start > timeoutMs) throw new Error('previous electron instance did not exit')
    await new Promise((r) => setTimeout(r, 500))
  }
}

/**
 * Quit the launched app and wait for its Electron process to fully exit.
 * userData (~/.config/Electron) is shared with every other e2e suite —
 * files under it must not be restored while a process that might still be
 * writing to them (e.g. a close handler persisting windowState) is alive.
 */
export async function quitApp(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: a }) => { a.quit() }).catch(() => {})
  await app.close().catch(() => { /* already gone */ })
  await waitForElectronExit()
}
