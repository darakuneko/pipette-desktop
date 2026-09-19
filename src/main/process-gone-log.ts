// SPDX-License-Identifier: GPL-2.0-or-later
// Diagnostic logging for renderer and child process exits — one line per
// event through the rotating logger. Recording only; no recovery is attempted.

import { app } from 'electron'
import { log } from './logger'
import type { LogLevel } from './logger'

/** Logs through the shared rotating logger, swallowing logger failures (disk
 * full, mkdir error) so they never escape an Electron event handler. */
function safeLog(level: LogLevel, message: string): void {
  try {
    log(level, message)
  } catch {
    // Best-effort: a logging failure must not crash the process it explains.
  }
}

function levelForReason(reason: string): LogLevel {
  return reason === 'clean-exit' ? 'info' : 'error'
}

export function formatRenderProcessGone(
  details: Electron.RenderProcessGoneDetails,
  ctx: { visible: boolean | 'unknown'; minimized: boolean | 'unknown'; uptimeSec: number },
): string {
  return `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode} visible=${ctx.visible} minimized=${ctx.minimized} uptimeSec=${ctx.uptimeSec}`
}

/** Reads a window's visibility/minimized state for the diagnostic line. A
 * window torn down during quit can throw "Object has been destroyed" from
 * these getters, so a failed read falls back to `'unknown'` rather than
 * losing the whole log line. */
function describeWindowContext(win: Electron.BrowserWindow): { visible: boolean | 'unknown'; minimized: boolean | 'unknown' } {
  try {
    return { visible: win.isVisible(), minimized: win.isMinimized() }
  } catch {
    return { visible: 'unknown', minimized: 'unknown' }
  }
}

export function formatChildProcessGone(details: Electron.Details): string {
  let line = `Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
  if (details.serviceName !== undefined) line += ` serviceName=${details.serviceName}`
  if (details.name !== undefined) line += ` name=${details.name}`
  return line
}

/** Classifies the main frame's health. `isCrashed()` and a PID check both miss
 * a frame that was disposed or replaced, and reading `mainFrame` — or even
 * `webContents` itself on a window torn down during quit — can throw, so the
 * caller passes a thunk and the whole read happens inside this try/catch. */
export function describeMainFrameState(getWebContents: () => Electron.WebContents): string {
  try {
    const frame = getWebContents().mainFrame
    if (frame.isDestroyed()) return 'destroyed'
    if (frame.detached) return 'detached'
    return 'available'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `threw: ${message}`
  }
}

/** Registers renderer diagnostics on one window: render process exits,
 * hang/recovery transitions, and a warning on every `show` where the main
 * frame is not `available`. A frame can be disposed or replaced without the
 * process exiting, which `render-process-gone` alone would miss; the
 * `show`-time check catches that. An available frame on show logs nothing. */
export function registerProcessGoneLogging(win: Electron.BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    const ctx = { ...describeWindowContext(win), uptimeSec: Math.round(process.uptime()) }
    safeLog(levelForReason(details.reason), formatRenderProcessGone(details, ctx))
  })

  win.webContents.on('unresponsive', () => {
    safeLog('warn', 'Renderer process unresponsive')
  })

  win.webContents.on('responsive', () => {
    safeLog('info', 'Renderer process responsive again')
  })

  win.on('show', () => {
    const state = describeMainFrameState(() => win.webContents)
    if (state !== 'available') {
      safeLog('warn', `Main frame not available on show: ${state}`)
    }
  })
}

/** Registers app-wide child process diagnostics (GPU, Utility, etc.) — called
 * once for the whole app, not per window. */
export function registerChildProcessGoneLogging(): void {
  app.on('child-process-gone', (_event, details) => {
    safeLog(levelForReason(details.reason), formatChildProcessGone(details))
  })
}
