// SPDX-License-Identifier: GPL-2.0-or-later
// Active-application lookup for typing-analytics. Owns no timer:
// the analytics service calls in once per flush so app-tagging
// piggy-backs on existing debounce. Linux/Wayland falls back to a
// gdbus query against the FocusedWindow GNOME Shell extension.

import { exec } from 'node:child_process'
import { promisify } from 'node:util'

import { loadAppConfig } from '../app-config'

const execAsync = promisify(exec)

/** Hard cap on stored app names. Real values are short (a few dozen
 * chars at most); this only guards against junk values returned by
 * misbehaving native handlers polluting the SQLite cache. */
const MAX_NAME_LENGTH = 256

interface ActiveWindowInfo {
  application: string
  title: string
}

interface ActiveWindowLib {
  initialize(): void
  getActiveWindow(): ActiveWindowInfo | null
}

let cachedLib: ActiveWindowLib | null = null
let libLoadAttempted = false
let warnedFailure = false

function loadLib(): ActiveWindowLib | null {
  if (libLoadAttempted) return cachedLib
  libLoadAttempted = true
  try {
    // Lazy require so the native bindings are not pulled in during tests
    // or when Monitor App is permanently disabled.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@paymoapp/active-window') as {
      ActiveWindow: ActiveWindowLib
    }
    mod.ActiveWindow.initialize()
    cachedLib = mod.ActiveWindow
    return cachedLib
  } catch (err) {
    warnOnce('failed to load active-window', err)
    return null
  }
}

function warnOnce(msg: string, err: unknown): void {
  if (warnedFailure) return
  warnedFailure = true
  console.warn(`[app-monitor] ${msg}:`, err)
}

function normalize(value: string | null | undefined): string | null {
  if (!value) return null
  // Strip control chars (0x00-0x1F, 0x7F) so DB values stay grep-friendly.
  let s = String(value).replace(/[\x00-\x1F\x7F]/g, '').trim()
  if (s.length === 0) return null
  if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH)
  return s
}

async function gdbusFallback(): Promise<string | null> {
  if (process.platform !== 'linux') return null
  try {
    const { stdout } = await execAsync(
      'gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/shell/extensions/FocusedWindow --method org.gnome.shell.extensions.FocusedWindow.Get',
      { timeout: 500 },
    )
    // GVariant tuple: ('{"wm_class":"...", ...}',)
    const trimmed = stdout.trim()
    if (trimmed.length < 5) return null
    const jsonStr = trimmed.slice(2, -3)
    const data = JSON.parse(jsonStr) as { wm_class?: string }
    if (!data.wm_class) return null
    // "org.gnome.Nautilus" -> "Nautilus"
    const parts = data.wm_class.split('.')
    return normalize(parts[parts.length - 1] ?? data.wm_class)
  } catch {
    // gdbus missing, extension absent, or timeout. Stay quiet — every
    // flush hits this path on non-GNOME Linux setups, and we already
    // warned once via warnOnce when active-window failed.
    return null
  }
}

/**
 * Resolve the active application's display name. Returns null when:
 * - Monitor App is disabled in AppConfig
 * - the native lib failed to load
 * - the underlying call threw or returned no usable name
 * - Linux/Wayland fallback also failed
 *
 * Side-effect: emits a single console warning when the native lib
 * fails on a platform where it shouldn't (macOS / Windows). On Linux
 * the native impl falls through to gdbus by design — Wayland sandboxes
 * window focus, so the throw is the expected branch and we stay quiet.
 */
export async function getCurrentAppName(): Promise<string | null> {
  const config = loadAppConfig()
  if (!config.typingMonitorAppEnabled) return null

  const lib = loadLib()
  if (!lib) return await gdbusFallback()

  let info: ActiveWindowInfo | null = null
  try {
    info = lib.getActiveWindow()
  } catch (err) {
    if (process.platform !== 'linux') warnOnce('getActiveWindow threw', err)
    return await gdbusFallback()
  }

  // application is the canonical identifier on macOS / Windows; fall back
  // to the window title only when application is missing or empty so the
  // SQLite cache does not get a mix of "VSCode" and "main.ts — VSCode".
  const fromApp = normalize(info?.application ?? null)
  if (fromApp) return fromApp
  const fromTitle = normalize(info?.title ?? null)
  if (fromTitle) return fromTitle
  return await gdbusFallback()
}

/** Test-only reset of internal caches. Allows mocking the native lib in
 * subsequent calls. Not exported through any IPC — only consumed by
 * vitest specs. */
export function __resetAppMonitorForTests(): void {
  cachedLib = null
  libLoadAttempted = false
  warnedFailure = false
}

/** Test-only override that bypasses the lazy require. Lets specs inject
 * a stub without dragging in the native binding. */
export function __setAppMonitorLibForTests(lib: ActiveWindowLib | null): void {
  cachedLib = lib
  libLoadAttempted = true
  warnedFailure = false
}
