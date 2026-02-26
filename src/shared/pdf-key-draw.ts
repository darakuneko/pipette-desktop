// SPDX-License-Identifier: GPL-2.0-or-later
// Shared PDF key-drawing helpers extracted from pdf-export.ts

import { jsPDF } from 'jspdf'
import type { KleKey } from './kle/types'
import { hasSecondaryRect } from './kle/filter-keys'
import { computeUnionPolygon, insetAxisAlignedPolygon } from './kle/rect-union'

// ── Constants ────────────────────────────────────────────────────────

export const SPACING_FRACTION = 0.2 / 3.4
export const FACE_INSET_FRACTION = 0.1 / 3.4
export const ROUNDNESS = 0.08

/** Cubic Bezier kappa for 90° arc approximation: 4*(√2 − 1)/3 */
export const KAPPA = 0.5522847498

// ── Types ────────────────────────────────────────────────────────────

export interface Bounds {
  minX: number
  minY: number
  width: number
  height: number
}

type PdfMatrix = { toString(): string }
type PdfMatrixCtor = new (
  sx: number, shy: number, shx: number, sy: number, tx: number, ty: number,
) => PdfMatrix

// ── Utility functions ────────────────────────────────────────────────

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunks: string[] = []
  const CHUNK_SIZE = 8192
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE)))
  }
  return btoa(chunks.join(''))
}

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** Rotate point (px,py) by `angle` degrees around center (cx,cy). */
export function rotatePoint(
  px: number,
  py: number,
  angle: number,
  cx: number,
  cy: number,
): [number, number] {
  const rad = degreesToRadians(angle)
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = px - cx
  const dy = py - cy
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
}

/** Compute bounding-box corners of a key, accounting for rotation. */
export function keyCorners(key: KleKey): [number, number][] {
  const corners: [number, number][] = [
    [key.x, key.y],
    [key.x + key.width, key.y],
    [key.x + key.width, key.y + key.height],
    [key.x, key.y + key.height],
  ]
  if (hasSecondaryRect(key)) {
    corners.push(
      [key.x + key.x2, key.y + key.y2],
      [key.x + key.x2 + key.width2, key.y + key.y2],
      [key.x + key.x2 + key.width2, key.y + key.y2 + key.height2],
      [key.x + key.x2, key.y + key.y2 + key.height2],
    )
  }
  if (key.rotation === 0) return corners
  return corners.map(([x, y]) =>
    rotatePoint(x, y, key.rotation, key.rotationX, key.rotationY),
  )
}

export function computeBounds(keys: KleKey[]): Bounds {
  if (keys.length === 0) {
    return { minX: 0, minY: 0, width: 0, height: 0 }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const key of keys) {
    for (const [x, y] of keyCorners(key)) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY }
}

export function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const t = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${d} ${t}`
}

// ── Page layout constants (mm, shared by keymap + layout PDF) ────────

export const PAGE_WIDTH = 297
export const MARGIN = 5
export const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2
export const FOOTER_HEIGHT = 6
export const BORDER_PAD = 4

// ── Text helpers ─────────────────────────────────────────────────────

/**
 * Strip non-Latin1 characters: jsPDF's built-in Helvetica only supports
 * WinAnsiEncoding (U+0020..U+00FF).
 */
export function sanitizeLabel(text: string): string {
  return text.replace(/[^\x20-\xFF]/g, '')
}

/** Build the standard footer line for PDF exports. */
export function buildFooterText(deviceName: string, timestamp: string): string {
  const label = sanitizeLabel(deviceName).trim()
  if (label) return `${label} - Exported ${timestamp} by Pipette`
  return `Exported ${timestamp} by Pipette`
}

// ── PDF drawing primitives ───────────────────────────────────────────

/**
 * Apply rotation transform for a key in jsPDF's coordinate system.
 * jsPDF converts mm to PDF points internally (Y-flipped), so we compute
 * the rotation matrix in PDF point space and apply via `cm` operator.
 */
export function applyKeyRotation(
  doc: jsPDF,
  key: KleKey,
  offsetX: number,
  offsetY: number,
  scale: number,
): void {
  if (key.rotation === 0) return

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MatrixCtor = (doc as any).Matrix as PdfMatrixCtor
  const k = doc.internal.scaleFactor
  const H = doc.internal.pageSize.getHeight() * k

  // Rotation center in mm -> PDF points (Y-up)
  const rcx = (offsetX + key.rotationX * scale) * k
  const rcy = H - (offsetY + key.rotationY * scale) * k

  // Negate: CW in visual Y-down = CW in PDF Y-up = negative angle in math convention
  const rad = degreesToRadians(-key.rotation)
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  const matrix = new MatrixCtor(
    cos,
    sin,
    -sin,
    cos,
    rcx * (1 - cos) + rcy * sin,
    rcy * (1 - cos) - rcx * sin,
  )
  doc.setCurrentTransformationMatrix(matrix)
}

/**
 * Draw a filled+stroked polygon with rounded convex corners using jsPDF lines().
 * Mirrors the SVG polygonToSvgPath logic for PDF output.
 */
export function drawRoundedPolygon(
  doc: jsPDF,
  vertices: [number, number][],
  cornerRadius: number,
  style: string,
): void {
  const n = vertices.length
  if (n < 3) return

  const arcs = vertices.map((curr, i) => {
    const prev = vertices[(i - 1 + n) % n]
    const next = vertices[(i + 1) % n]
    const dx1 = curr[0] - prev[0]
    const dy1 = curr[1] - prev[1]
    const len1 = Math.hypot(dx1, dy1)
    const dx2 = next[0] - curr[0]
    const dy2 = next[1] - curr[1]
    const len2 = Math.hypot(dx2, dy2)
    // Cross product > 0 = right turn (convex) in screen coords (y-down CW winding)
    const isConvex = dx1 * dy2 - dy1 * dx2 > 0
    const maxR = Math.min(len1, len2) / 2
    const actualR = isConvex ? Math.min(cornerRadius, maxR) : 0
    if (actualR <= 0) {
      return { sx: curr[0], sy: curr[1], ex: curr[0], ey: curr[1], r: 0, tdx1: 0, tdy1: 0, tdx2: 0, tdy2: 0 }
    }
    return {
      sx: curr[0] - (dx1 / len1) * actualR,
      sy: curr[1] - (dy1 / len1) * actualR,
      ex: curr[0] + (dx2 / len2) * actualR,
      ey: curr[1] + (dy2 / len2) * actualR,
      r: actualR,
      tdx1: dx1 / len1, tdy1: dy1 / len1, // incoming edge unit direction
      tdx2: dx2 / len2, tdy2: dy2 / len2, // outgoing edge unit direction
    }
  })

  // Build relative-coordinate segments for doc.lines()
  const segs: number[][] = []
  let penX = arcs[0].ex
  let penY = arcs[0].ey
  for (let i = 1; i <= n; i++) {
    const a = arcs[i % n]
    // Straight line to arc start
    segs.push([a.sx - penX, a.sy - penY])
    penX = a.sx
    penY = a.sy
    if (a.r > 0) {
      // Cubic Bezier: CP1 tangent to incoming edge, CP2 tangent to outgoing edge
      const c1x = a.sx + KAPPA * a.r * a.tdx1
      const c1y = a.sy + KAPPA * a.r * a.tdy1
      const c2x = a.ex - KAPPA * a.r * a.tdx2
      const c2y = a.ey - KAPPA * a.r * a.tdy2
      segs.push([c1x - penX, c1y - penY, c2x - penX, c2y - penY, a.ex - penX, a.ey - penY])
      penX = a.ex
      penY = a.ey
    }
  }

  doc.lines(segs, arcs[0].ex, arcs[0].ey, [1, 1], style, true)
}

// ── Key outline drawing (no labels) ─────────────────────────────────

/**
 * Draw a key's outline shape only (no labels).
 * Used for layout PDF export where we just need the physical key shapes.
 */
export function drawKeyOutline(
  doc: jsPDF,
  key: KleKey,
  offsetX: number,
  offsetY: number,
  scale: number,
): void {
  const hasRotation = key.rotation !== 0
  if (hasRotation) {
    doc.saveGraphicsState()
    applyKeyRotation(doc, key, offsetX, offsetY, scale)
  }

  const spacing = scale * SPACING_FRACTION
  const inset = scale * FACE_INSET_FRACTION
  const corner = scale * ROUNDNESS

  const gx = offsetX + key.x * scale
  const gy = offsetY + key.y * scale
  const gw = key.width * scale - spacing
  const gh = key.height * scale - spacing

  const x = gx + inset
  const y = gy + inset
  const w = gw - 2 * inset
  const h = gh - 2 * inset

  doc.setDrawColor(0)
  doc.setFillColor(255, 255, 255)

  if (hasSecondaryRect(key)) {
    const gx2 = gx + key.x2 * scale
    const gy2 = gy + key.y2 * scale
    const gw2 = key.width2 * scale - spacing
    const gh2 = key.height2 * scale - spacing
    const verts = computeUnionPolygon(gx, gy, gw, gh, gx2, gy2, gw2, gh2)
    if (verts.length > 0) {
      drawRoundedPolygon(doc, insetAxisAlignedPolygon(verts, inset), corner, 'FD')
    } else {
      doc.roundedRect(x, y, w, h, corner, corner, 'FD')
    }
  } else {
    doc.roundedRect(x, y, w, h, corner, corner, 'FD')
  }

  if (hasRotation) {
    doc.restoreGraphicsState()
  }
}

/**
 * Draw an encoder outline (circle, no labels).
 * Used for layout PDF export.
 */
export function drawEncoderOutline(
  doc: jsPDF,
  key: KleKey,
  offsetX: number,
  offsetY: number,
  scale: number,
): void {
  const hasRotation = key.rotation !== 0
  if (hasRotation) {
    doc.saveGraphicsState()
    applyKeyRotation(doc, key, offsetX, offsetY, scale)
  }

  const spacing = scale * SPACING_FRACTION
  const cx = offsetX + key.x * scale + (key.width * scale - spacing) / 2
  const cy = offsetY + key.y * scale + (key.height * scale - spacing) / 2
  const r = Math.min(key.width, key.height) * scale / 2 - spacing / 2

  doc.setDrawColor(0)
  doc.setFillColor(255, 255, 255)
  doc.circle(cx, cy, r, 'FD')

  if (hasRotation) {
    doc.restoreGraphicsState()
  }
}
