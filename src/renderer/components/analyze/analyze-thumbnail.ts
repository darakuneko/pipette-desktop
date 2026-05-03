// SPDX-License-Identifier: GPL-2.0-or-later
//
// Generate a JPEG (base64) thumbnail card for Hub Analytics uploads.
// Renders a small composition with the keyboard name + timestamp +
// keystroke count on a canvas — keeps the thumbnail step
// self-contained (no html2canvas / PDF detour) so the upload UX stays
// responsive even on a slow machine.
//
// Hub displays the thumbnail at ~16:9 in the post grid, so the canvas
// is sized to match the favorite/keymap thumbnails and exports as
// JPEG (quality 0.85).

const CANVAS_WIDTH = 800
const CANVAS_HEIGHT = 450

export interface AnalyzeThumbnailInput {
  keyboardName: string
  /** Local-time formatted "YYYY-MM-DD HH:mm" range. The dialog already
   * has `formatDateTime` output handy from the live filter row. */
  rangeLabel: string
  /** Total keystrokes from the upload preview. Shown alongside range so
   * the post grid card communicates "how big this dataset is" before
   * the user clicks through. */
  totalKeystrokes: number
  /** Hub deviceScope label ("All devices" / "Own" / a hash). Optional. */
  deviceLabel?: string
}

/**
 * Returns the JPEG base64 string (no `data:` prefix). Throws if the
 * canvas 2D context is unavailable (off-DOM or test runner without
 * canvas mocks).
 */
export function generateAnalyzeThumbnail(input: AnalyzeThumbnailInput): string {
  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_WIDTH
  canvas.height = CANVAS_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')

  // Background — slate gradient gives a recognisable Pipette look
  // without needing a logo asset bundled.
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT)
  grad.addColorStop(0, '#0f172a')
  grad.addColorStop(1, '#1e293b')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)

  // Accent stripe — narrow band along the top so the post grid can
  // tell analytics posts apart from keymap posts at a glance.
  ctx.fillStyle = '#0ea5e9'
  ctx.fillRect(0, 0, CANVAS_WIDTH, 6)

  // Title
  ctx.fillStyle = '#e2e8f0'
  ctx.font = 'bold 44px sans-serif'
  ctx.fillText('Analytics', 48, 96)

  // Keyboard name
  ctx.fillStyle = '#cbd5e1'
  ctx.font = 'bold 30px sans-serif'
  ctx.fillText(truncate(ctx, input.keyboardName, CANVAS_WIDTH - 96), 48, 152)

  // Period + device
  ctx.fillStyle = '#94a3b8'
  ctx.font = '22px sans-serif'
  ctx.fillText(input.rangeLabel, 48, 220)
  if (input.deviceLabel) {
    ctx.fillText(input.deviceLabel, 48, 252)
  }

  // Big keystroke count — visually anchors the card the way the post
  // grid expects (something distinctive to scan).
  ctx.fillStyle = '#f1f5f9'
  ctx.font = 'bold 64px sans-serif'
  const formatted = input.totalKeystrokes.toLocaleString()
  ctx.fillText(formatted, 48, 380)
  ctx.fillStyle = '#94a3b8'
  ctx.font = '22px sans-serif'
  ctx.fillText('keystrokes', 48, 410)

  return canvas
    .toDataURL('image/jpeg', 0.85)
    .replace(/^data:image\/jpeg;base64,/, '')
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo)}…`
}
