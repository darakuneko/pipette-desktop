// SPDX-License-Identifier: GPL-2.0-or-later
// Generate keymap PDF from current keymap state

import { jsPDF } from 'jspdf'
import type { KleKey } from './kle/types'
import { filterVisibleKeys, hasSecondaryRect, repositionLayoutKeys } from './kle/filter-keys'
import { computeUnionPolygon, insetAxisAlignedPolygon } from './kle/rect-union'

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunks: string[] = []
  const CHUNK_SIZE = 8192
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE)))
  }
  return btoa(chunks.join(''))
}

export interface PdfExportInput {
  deviceName: string
  layers: number
  keys: KleKey[]
  keymap: Map<string, number>
  encoderLayout: Map<string, number>
  encoderCount: number
  layoutOptions: Map<number, number>
  serializeKeycode: (code: number) => string
  keycodeLabel: (qmkId: string) => string
  isMask: (qmkId: string) => boolean
  findOuterKeycode: (qmkId: string) => { label: string } | undefined
  findInnerKeycode: (qmkId: string) => { label: string } | undefined
}

interface Bounds {
  minX: number
  minY: number
  width: number
  height: number
}

// Page layout dimensions in mm (dynamic height, one layer per page)
const PAGE_WIDTH = 297
const MARGIN = 5
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2
const FOOTER_HEIGHT = 6
const LAYER_HEADER_HEIGHT = 7
const BORDER_PAD = 4
// Match Python vial-gui: size=3.2, spacing=0.2, full_cell=3.4
// spacing_fraction = spacing / full_cell, face_inset = shadow_padding / full_cell
const SPACING_FRACTION = 0.2 / 3.4 // ≈ 0.0588
const FACE_INSET_FRACTION = 0.1 / 3.4 // ≈ 0.0294
const ROUNDNESS = 0.08

// Font size caps: Math.min(absolute max pt, scale-relative max pt)
const MASKED_LABEL_MAX = 18
const MASKED_LABEL_SCALE = 0.55
const NORMAL_LABEL_MAX = 20
const NORMAL_LABEL_SCALE = 0.65
const ENCODER_DIR_MAX = 14
const ENCODER_DIR_SCALE = 0.45
const ENCODER_LABEL_MAX = 16
const ENCODER_LABEL_SCALE = 0.5

// jsPDF's built-in Helvetica only supports WinAnsiEncoding (Latin-1).
// Strip non-Latin1 characters (outside U+0020..U+00FF) to avoid rendering blanks.
function sanitizeLabel(text: string): string {
  return text.replace(/[^\x20-\xFF]/g, '')
}

// Latin fallback labels for keycodes whose visual labels contain only non-Latin1 chars
const QMK_ALIAS_FALLBACK: Record<string, string> = {
  KC_LANG1: 'HAEN',
  KC_LANG2: 'HANJ',
}

function pdfKeyLabel(rawLabel: string, qmkId: string): string {
  const sanitized = sanitizeLabel(rawLabel)
  if (sanitized.trim()) return sanitized
  if (!rawLabel) return ''
  return QMK_ALIAS_FALLBACK[qmkId] ?? qmkId.replace(/^KC_/, '')
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

/** Rotate point (px,py) by `angle` degrees around center (cx,cy). */
function rotatePoint(
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
function keyCorners(key: KleKey): [number, number][] {
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

function computeBounds(keys: KleKey[]): Bounds {
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

function fitText(doc: jsPDF, text: string, maxWidth: number, maxSize: number): number {
  let size = maxSize
  while (size > 4) {
    doc.setFontSize(size)
    if (doc.getTextWidth(text) <= maxWidth) return size
    size -= 0.5
  }
  return 4
}

function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const t = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${d} ${t}`
}

type PdfMatrix = { toString(): string }
type PdfMatrixCtor = new (
  sx: number, shy: number, shx: number, sy: number, tx: number, ty: number,
) => PdfMatrix

/**
 * Apply rotation transform for a key in jsPDF's coordinate system.
 * jsPDF converts mm to PDF points internally (Y-flipped), so we compute
 * the rotation matrix in PDF point space and apply via `cm` operator.
 */
function applyKeyRotation(
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

/** Cubic Bézier kappa for 90° arc approximation: 4*(√2 − 1)/3 */
const KAPPA = 0.5522847498

/**
 * Draw a filled+stroked polygon with rounded convex corners using jsPDF lines().
 * Mirrors the SVG polygonToSvgPath logic for PDF output.
 */
function drawRoundedPolygon(
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

function drawKey(
  doc: jsPDF,
  key: KleKey,
  layer: number,
  offsetX: number,
  offsetY: number,
  scale: number,
  input: PdfExportInput,
): void {
  const hasRotation = key.rotation !== 0
  if (hasRotation) {
    doc.saveGraphicsState()
    applyKeyRotation(doc, key, offsetX, offsetY, scale)
  }

  const spacing = scale * SPACING_FRACTION
  const inset = scale * FACE_INSET_FRACTION
  const corner = scale * ROUNDNESS

  // Grid-cell rect (before face inset)
  const gx = offsetX + key.x * scale
  const gy = offsetY + key.y * scale
  const gw = key.width * scale - spacing
  const gh = key.height * scale - spacing

  // Visual face rect (inset from grid cell)
  const x = gx + inset
  const y = gy + inset
  const w = gw - 2 * inset
  const h = gh - 2 * inset

  const code = input.keymap.get(`${layer},${key.row},${key.col}`) ?? 0
  const qmkId = input.serializeKeycode(code)
  const label = input.keycodeLabel(qmkId)
  const masked = input.isMask(qmkId)

  doc.setDrawColor(0)
  doc.setFillColor(255, 255, 255)

  if (hasSecondaryRect(key)) {
    // Union polygon for ISO/stepped keys
    const gx2 = gx + key.x2 * scale
    const gy2 = gy + key.y2 * scale
    const gw2 = key.width2 * scale - spacing
    const gh2 = key.height2 * scale - spacing
    const verts = computeUnionPolygon(gx, gy, gw, gh, gx2, gy2, gw2, gh2)
    if (verts.length > 0) {
      drawRoundedPolygon(doc, insetAxisAlignedPolygon(verts, inset), corner, 'FD')
    } else {
      // Fallback: non-overlapping secondary rect, draw primary rect only
      doc.roundedRect(x, y, w, h, corner, corner, 'FD')
    }
  } else {
    doc.roundedRect(x, y, w, h, corner, corner, 'FD')
  }

  if (masked) {
    // Inner rect for masked keys (modifier + base key)
    const innerPad = scale * 0.05
    const innerX = x + innerPad
    const innerY = y + h * 0.4 + innerPad
    const innerW = Math.max(0, w - innerPad * 2)
    const innerH = Math.max(0, h * 0.6 - innerPad * 2)
    const innerCorner = corner * 0.8

    doc.setFillColor(240, 240, 240)
    doc.roundedRect(innerX, innerY, innerW, innerH, innerCorner, innerCorner, 'FD')

    // Outer label (modifier) in top portion
    const outerLabel = sanitizeLabel(
      input.findOuterKeycode(qmkId)?.label.replace(/\n?\(kc\)$/, '') ?? label,
    )
    const outerSize = fitText(doc, outerLabel, w * 0.9, Math.min(MASKED_LABEL_MAX, scale * MASKED_LABEL_SCALE))
    doc.setFontSize(outerSize)
    doc.setTextColor(0)
    doc.text(outerLabel, x + w / 2, y + h * 0.22, {
      align: 'center',
      baseline: 'middle',
    })

    // Inner label (base key) in inner rect
    const innerLabel = sanitizeLabel(input.findInnerKeycode(qmkId)?.label ?? '')
    if (innerLabel) {
      const innerSize = fitText(doc, innerLabel, innerW * 0.9, Math.min(MASKED_LABEL_MAX, scale * MASKED_LABEL_SCALE))
      doc.setFontSize(innerSize)
      doc.text(innerLabel, x + w / 2, innerY + innerH / 2, {
        align: 'center',
        baseline: 'middle',
      })
    }
  } else {
    // Normal key label (may have \n for multi-line like "!\n1")
    // When sanitization empties all lines (CJK-only labels), fall back to qmkId
    const sanitizedLines = label.split('\n').map(sanitizeLabel)
    const lines = sanitizedLines.some((l) => l.trim())
      ? sanitizedLines
      : [pdfKeyLabel(label, qmkId)]
    doc.setTextColor(0)
    for (let i = 0; i < lines.length; i++) {
      const fontSize = fitText(doc, lines[i], w * 0.9, Math.min(NORMAL_LABEL_MAX, scale * NORMAL_LABEL_SCALE))
      doc.setFontSize(fontSize)
      const lineY = y + (h / (lines.length + 1)) * (i + 1)
      doc.text(lines[i], x + w / 2, lineY, {
        align: 'center',
        baseline: 'middle',
      })
    }
  }

  if (hasRotation) {
    doc.restoreGraphicsState()
  }
}

function drawEncoder(
  doc: jsPDF,
  key: KleKey,
  layer: number,
  offsetX: number,
  offsetY: number,
  scale: number,
  input: PdfExportInput,
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

  // encoderDir: 0=CW, 1=CCW
  const code = input.encoderLayout.get(`${layer},${key.encoderIdx},${key.encoderDir}`) ?? 0
  const qmkId = input.serializeKeycode(code)
  const label = pdfKeyLabel(input.keycodeLabel(qmkId), qmkId)
  const dirLabel = key.encoderDir === 0 ? 'CW' : 'CCW'

  doc.setTextColor(0)

  // Direction label on top
  const dirSize = fitText(doc, dirLabel, r * 1.6, Math.min(ENCODER_DIR_MAX, scale * ENCODER_DIR_SCALE))
  doc.setFontSize(dirSize)
  doc.text(dirLabel, cx, cy - r * 0.3, { align: 'center', baseline: 'middle' })

  // Key label on bottom
  const labelSize = fitText(doc, label, r * 1.6, Math.min(ENCODER_LABEL_MAX, scale * ENCODER_LABEL_SCALE))
  doc.setFontSize(labelSize)
  doc.text(label, cx, cy + r * 0.3, { align: 'center', baseline: 'middle' })

  if (hasRotation) {
    doc.restoreGraphicsState()
  }
}

export function generateKeymapPdf(input: PdfExportInput): string {
  const visibleKeys = filterVisibleKeys(
    repositionLayoutKeys(input.keys, input.layoutOptions),
    input.layoutOptions,
  )
  const normalKeys = visibleKeys.filter((k) => k.encoderIdx === -1)
  const encoderKeys = visibleKeys.filter((k) => k.encoderIdx !== -1)

  const bounds = computeBounds(visibleKeys)
  if (bounds.width === 0 || bounds.height === 0) {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    return arrayBufferToBase64(doc.output('arraybuffer'))
  }

  // Scale keyboard to fit usable page width, capped so page height stays reasonable
  const MAX_PAGE_HEIGHT = PAGE_WIDTH // cap at square page to avoid jsPDF orientation swap
  const maxContentHeight = MAX_PAGE_HEIGHT - MARGIN * 2 - LAYER_HEADER_HEIGHT - FOOTER_HEIGHT - BORDER_PAD * 2
  const scale = Math.min(
    USABLE_WIDTH / bounds.width,
    maxContentHeight / bounds.height,
  )
  // Visual keyboard dimensions (keys are visually smaller due to inter-key spacing)
  const spacing = scale * SPACING_FRACTION
  const visualW = bounds.width * scale - spacing
  const visualH = bounds.height * scale - spacing

  const borderW = visualW + BORDER_PAD * 2
  const borderH = visualH + BORDER_PAD * 2
  const borderX = (PAGE_WIDTH - borderW) / 2
  const borderY = MARGIN + LAYER_HEADER_HEIGHT
  const keysOffsetX = borderX + BORDER_PAD - bounds.minX * scale
  const keysOffsetY = borderY + BORDER_PAD - bounds.minY * scale

  // Dynamic page height: fits exactly one layer with minimal whitespace
  const pageHeight = MARGIN + LAYER_HEADER_HEIGHT + borderH + FOOTER_HEIGHT + MARGIN

  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: [PAGE_WIDTH, pageHeight],
  })

  // Footer text (rendered on each page at the end)
  const timestamp = formatTimestamp(new Date())
  const deviceLabel = sanitizeLabel(input.deviceName).trim()
  const footerText = deviceLabel
    ? `${deviceLabel} - Exported ${timestamp} by Pipette`
    : `Exported ${timestamp} by Pipette`

  for (let layer = 0; layer < input.layers; layer++) {
    if (layer > 0) {
      doc.addPage()
    }

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(12)
    doc.setTextColor(0)
    doc.text(`Layer ${layer}`, borderX, MARGIN + 5)

    // Outer border around keymap
    doc.setDrawColor(180)
    doc.setLineWidth(0.3)
    doc.roundedRect(borderX, borderY, borderW, borderH, 1.5, 1.5, 'S')

    doc.setFont('helvetica', 'normal')

    for (const key of normalKeys) {
      drawKey(doc, key, layer, keysOffsetX, keysOffsetY, scale, input)
    }

    for (const key of encoderKeys) {
      drawEncoder(doc, key, layer, keysOffsetX, keysOffsetY, scale, input)
    }
  }

  // Footer on each page
  const totalPages = doc.getNumberOfPages()
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(150)
    doc.text(footerText, PAGE_WIDTH / 2, pageHeight - MARGIN, { align: 'center' })
  }

  return arrayBufferToBase64(doc.output('arraybuffer'))
}
