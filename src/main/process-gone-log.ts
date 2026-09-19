// SPDX-License-Identifier: GPL-2.0-or-later
// Diagnostic logging for renderer and child process exits — one line per
// event through the rotating logger. No recovery is attempted here; this
// module only records what happened so a later crash can be diagnosed.

import { app } from 'electron'
import { log } from './logger'
import type { LogLevel } from './logger'

/** Routes through the shared rotating logger, but never lets a logging
 * failure (disk full, mkdir error) escape an Electron event handler. */
function safeLog(level: LogLevel, message: string): void {
  try {
    log(level, message)
  } catch {
    // Diagnostic logging is best-effort — a failure here must not crash
    // the process it's trying to explain.
  }
}

export function formatRenderProcessGone(
  details: Electron.RenderProcessGoneDetails,
  ctx: { visible: boolean; minimized: boolean; uptimeSec: number },
): string {
  return `Renderer process gone: reason=${details.reason} exitCode=${details.exitCode} visible=${ctx.visible} minimized=${ctx.minimized} uptimeSec=${ctx.uptimeSec}`
}

export function formatChildProcessGone(details: Electron.Details): string {
  let line = `Child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
  if (details.serviceName !== undefined) line += ` serviceName=${details.serviceName}`
  if (details.name !== undefined) line += ` name=${details.name}`
  return line
}

/** Classifies the main frame's health without relying on `isCrashed()` or a
 * PID check, neither of which reflects whether the frame itself has been
 * disposed or replaced. Accessing `mainFrame` can itself throw when the
 * frame was disposed before the getter runs, so that path is caught too. */
export function describeMainFrameState(webContents: Electron.WebContents): string {
  try {
    const frame = webContents.mainFrame
    if (frame.isDestroyed()) return 'destroyed'
    if (frame.detached) return 'detached'
    return 'available'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return `threw: ${message}`
  }
}

/** Registers renderer-side diagnostics on one window: render process exits,
 * hang/recovery transitions, and — on every `show` — a warning when the
 * main frame is not `available`. A frame can be disposed or replaced
 * without the process itself exiting, so `render-process-gone` alone would
 * miss that case; the `show`-time frame check catches it. Nothing is logged
 * on a normal show where the frame is available. */
export function registerProcessGoneLogging(win: Electron.BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    const ctx = {
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      uptimeSec: Math.round(process.uptime()),
    }
    const level: LogLevel = details.reason === 'clean-exit' ? 'info' : 'error'
    safeLog(level, formatRenderProcessGone(details, ctx))
  })

  win.webContents.on('unresponsive', () => {
    safeLog('warn', 'Renderer process unresponsive')
  })

  win.webContents.on('responsive', () => {
    safeLog('info', 'Renderer process responsive again')
  })

  win.on('show', () => {
    const state = describeMainFrameState(win.webContents)
    if (state !== 'available') {
      safeLog('warn', `Main frame not available on show: ${state}`)
    }
  })
}

/** Registers app-wide child process diagnostics (GPU, Utility, etc.) —
 * called once for the whole app, not per window. */
export function registerChildProcessGoneLogging(): void {
  app.on('child-process-gone', (_event, details) => {
    const level: LogLevel = details.reason === 'clean-exit' ? 'info' : 'error'
    safeLog(level, formatChildProcessGone(details))
  })
}
