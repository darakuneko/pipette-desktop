// SPDX-License-Identifier: GPL-2.0-or-later
// Generate layout PDF exports — key outlines only, no labels

import { jsPDF } from 'jspdf'
import type { KleKey } from './kle/types'
import { filterVisibleKeys, repositionLayoutKeys } from './kle/filter-keys'
import type { LayoutOption } from './layout-options'
import {
  arrayBufferToBase64,
  computeBounds,
  drawKeyOutline,
  drawEncoderOutline,
  formatTimestamp,
  buildFooterText,
  sanitizeLabel,
  SPACING_FRACTION,
  PAGE_WIDTH,
  MARGIN,
  USABLE_WIDTH,
  FOOTER_HEIGHT,
  BORDER_PAD,
} from './pdf-key-draw'

export interface LayoutPdfInput {
  deviceName: string
  keys: KleKey[]                    // All keys (unfiltered)
  layoutOptions: LayoutOption[]     // Parsed option definitions
  currentValues: Map<number, number>  // Current selected values
}

interface RenderedVariant {
  value: number
  label: string
  keys: KleKey[]
  bounds: ReturnType<typeof computeBounds>
}

// Layout constants for variant stacking
const VARIANT_HEADER_HEIGHT = 5
const VARIANT_GAP = 3
const HEADER_LINE_HEIGHT = 5       // mm per line at 12pt bold
const HEADER_BASELINE_OFFSET = 4   // baseline offset for 12pt bold text
const HEADER_BOTTOM_GAP = 3        // gap below header before content
const HEADER_MAX_CHARS = 80        // conservative limit for 12pt bold in USABLE_WIDTH
const MAX_PAGE_HEIGHT = PAGE_WIDTH  // Cap at square — matches keymap PDF

/**
 * Pick PDF orientation so jsPDF does not swap format dimensions.
 * landscape ensures width >= height; portrait ensures height >= width.
 */
function pageOrientation(pageHeight: number): 'landscape' | 'portrait' {
  return pageHeight > PAGE_WIDTH ? 'portrait' : 'landscape'
}

/** Pre-computed page data for a single layout option. */
interface PageData {
  headerLines: string[]
  variants: RenderedVariant[]
  scale: number
  pageHeight: number
}

/** Boolean options have at most 1 label entry (the option name). */
function isBooleanOption(option: LayoutOption): boolean {
  return option.labels.length <= 1
}

/**
 * Compute visible keys for a specific set of layout option values.
 */
function getVisibleKeys(allKeys: KleKey[], values: Map<number, number>): KleKey[] {
  return filterVisibleKeys(repositionLayoutKeys(allKeys, values), values)
}

/**
 * Draw a keyboard outline (keys + encoders, no labels) on the current page.
 */
function drawKeyboard(
  doc: jsPDF,
  keys: KleKey[],
  offsetX: number,
  offsetY: number,
  scale: number,
): void {
  doc.setFont('helvetica', 'normal')
  for (const key of keys) {
    if (key.encoderIdx !== -1) {
      drawEncoderOutline(doc, key, offsetX, offsetY, scale)
    } else {
      drawKeyOutline(doc, key, offsetX, offsetY, scale)
    }
  }
}

/**
 * Split header text into lines at " / " boundaries, keeping lines under HEADER_MAX_CHARS.
 */
function splitHeaderLines(text: string): string[] {
  const segments = text.split(' / ')
  if (segments.length <= 1) return [text]
  const lines: string[] = []
  let current = segments[0]
  for (let i = 1; i < segments.length; i++) {
    const candidate = `${current} / ${segments[i]}`
    if (candidate.length > HEADER_MAX_CHARS) {
      lines.push(current)
      current = segments[i]
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines
}

/** Compute header height in mm from line count. */
function headerHeight(lineCount: number): number {
  return lineCount * HEADER_LINE_HEIGHT + HEADER_BOTTOM_GAP
}

/**
 * Build a state-description header for a specific set of layout option values.
 * Boolean ON → option name; Boolean OFF → skipped; Select → "Option: Choice".
 * Returns parts joined by " / ", or fallback if empty.
 */
function buildStateHeader(
  layoutOptions: LayoutOption[],
  values: Map<number, number>,
  fallback: string,
): string {
  const parts: string[] = []
  for (const opt of layoutOptions) {
    const val = values.get(opt.index) ?? 0
    if (isBooleanOption(opt)) {
      if (val !== 0) {
        const name = sanitizeLabel(opt.labels[0] || '').trim()
        if (name) parts.push(name)
      }
    } else {
      const optName = sanitizeLabel(opt.labels[0] || '').trim()
      const choiceRaw = opt.labels[val + 1] || ''
      const choice = sanitizeLabel(choiceRaw).trim()
      if (optName && choice) parts.push(`${optName}: ${choice}`)
      else if (choice) parts.push(choice)
    }
  }
  return parts.join(' / ') || fallback
}

/**
 * Build the list of { value, label } pairs for a layout option.
 * Boolean options produce Off/On; select options use their choice labels.
 */
function buildVariantEntries(option: LayoutOption): { value: number; label: string }[] {
  if (isBooleanOption(option)) {
    return [
      { value: 0, label: 'Off' },
      { value: 1, label: 'On' },
    ]
  }
  return option.labels.slice(1).map((raw, i) => {
    const label = sanitizeLabel(raw || `Choice ${i}`).trim() || `Choice ${i}`
    return { value: i, label }
  })
}

/**
 * Compute page data for one layout option.
 * Returns multiple pages when variants don't fit on a single page.
 */
function computePageData(
  option: LayoutOption,
  allKeys: KleKey[],
  currentValues: Map<number, number>,
  allLayoutOptions: LayoutOption[],
): PageData[] {
  const rawName = option.labels[0] || `Option ${option.index}`
  const optionName = sanitizeLabel(rawName).trim() || `Option ${option.index}`

  const entries = buildVariantEntries(option)
  const variants: RenderedVariant[] = entries.map((entry) => {
    const values = new Map(currentValues)
    values.set(option.index, entry.value)
    const visibleKeys = getVisibleKeys(allKeys, values)
    return {
      value: entry.value,
      label: entry.label,
      keys: visibleKeys,
      bounds: computeBounds(visibleKeys),
    }
  })

  if (variants.length === 0) return []

  const maxBoundsWidth = Math.max(...variants.map((v) => v.bounds.width))
  const maxBoundsHeight = Math.max(...variants.map((v) => v.bounds.height))
  if (maxBoundsWidth === 0 || maxBoundsHeight === 0) return []

  const scaleByWidth = USABLE_WIDTH / maxBoundsWidth

  // Use a single-line estimate for initial layout; actual header height computed per page.
  const singleLineHeader = headerHeight(1)
  const baseOverhead = MARGIN * 2 + singleLineHeader + FOOTER_HEIGHT

  // Ensure at least 1 variant fits per page — shrink scale only if necessary
  const maxContentH = MAX_PAGE_HEIGHT - baseOverhead
  const scaleForOne = (maxContentH - VARIANT_HEADER_HEIGHT - BORDER_PAD * 2 - VARIANT_GAP) / maxBoundsHeight
  const scale = Math.min(scaleByWidth, scaleForOne)

  // Height of one variant block at the computed scale
  const blockHeight = VARIANT_HEADER_HEIGHT + maxBoundsHeight * scale + BORDER_PAD * 2 + VARIANT_GAP
  const maxPerPage = Math.max(1, Math.floor(maxContentH / blockHeight))

  // Split variants into pages.
  // Each page header shows the full keyboard state for that variant via buildStateHeader.
  // Variant labels are cleared — the state is described entirely by the header.
  const pages: PageData[] = []
  for (let i = 0; i < variants.length; i += maxPerPage) {
    const group = variants.slice(i, i + maxPerPage)
    const variantValues = new Map(currentValues)
    variantValues.set(option.index, group[0].value)
    const lines = splitHeaderLines(buildStateHeader(allLayoutOptions, variantValues, optionName))
    const unlabeled = group.map((v) => ({ ...v, label: '' }))
    const hdrH = headerHeight(lines.length)
    const pageHeight = MARGIN * 2 + hdrH + FOOTER_HEIGHT + group.length * blockHeight
    pages.push({ headerLines: lines, variants: unlabeled, scale, pageHeight })
  }

  return pages
}

/** Render a pre-computed page onto the current jsPDF page. */
function renderPage(doc: jsPDF, page: PageData, footerText: string): void {
  // Page header — multi-line, split at " / " boundaries
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(0)
  let yPos = MARGIN
  for (const line of page.headerLines) {
    doc.text(line, MARGIN, yPos + HEADER_BASELINE_OFFSET)
    yPos += HEADER_LINE_HEIGHT
  }
  yPos += HEADER_BOTTOM_GAP
  for (const variant of page.variants) {
    // Variant label (cleared in ALL PDF where the page header describes the state)
    if (variant.label) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(80)
      doc.text(variant.label, MARGIN + 2, yPos + 3.5)
    }
    yPos += VARIANT_HEADER_HEIGHT

    // Keyboard border
    const spacing = page.scale * SPACING_FRACTION
    const visualW = variant.bounds.width * page.scale - spacing
    const visualH = variant.bounds.height * page.scale - spacing
    const borderW = visualW + BORDER_PAD * 2
    const borderH = visualH + BORDER_PAD * 2
    const borderX = (PAGE_WIDTH - borderW) / 2

    doc.setDrawColor(180)
    doc.setLineWidth(0.3)
    doc.roundedRect(borderX, yPos, borderW, borderH, 1.5, 1.5, 'S')

    const keysOffsetX = borderX + BORDER_PAD - variant.bounds.minX * page.scale
    const keysOffsetY = yPos + BORDER_PAD - variant.bounds.minY * page.scale
    drawKeyboard(doc, variant.keys, keysOffsetX, keysOffsetY, page.scale)

    yPos += borderH + VARIANT_GAP
  }

  // Footer
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(150)
  doc.text(footerText, PAGE_WIDTH / 2, page.pageHeight - MARGIN, { align: 'center' })
}

/**
 * Generate PDF with all layout option variations.
 * One page per layout option, each variant rendered as a stacked keyboard outline.
 */
export function generateAllLayoutOptionsPdf(input: LayoutPdfInput): string {
  const { deviceName, keys, layoutOptions, currentValues } = input

  if (layoutOptions.length === 0) {
    return generateCurrentLayoutPdf(input)
  }

  // Phase 1: pre-compute every page so we know the first page's dimensions.
  // computePageData returns multiple pages when variants overflow a single page.
  const pages: PageData[] = []
  for (const option of layoutOptions) {
    pages.push(...computePageData(option, keys, currentValues, layoutOptions))
  }

  if (pages.length === 0) {
    return generateCurrentLayoutPdf(input)
  }

  // Phase 2: create doc with correct first-page size, then render all pages.
  const doc = new jsPDF({
    orientation: pageOrientation(pages[0].pageHeight),
    unit: 'mm',
    format: [PAGE_WIDTH, pages[0].pageHeight],
  })

  const footerText = buildFooterText(deviceName, formatTimestamp(new Date()))

  renderPage(doc, pages[0], footerText)

  for (let i = 1; i < pages.length; i++) {
    doc.addPage([PAGE_WIDTH, pages[i].pageHeight], pageOrientation(pages[i].pageHeight))
    renderPage(doc, pages[i], footerText)
  }

  return arrayBufferToBase64(doc.output('arraybuffer'))
}

/**
 * Generate PDF with current layout selection — single page, key outlines only.
 */
export function generateCurrentLayoutPdf(input: LayoutPdfInput): string {
  const { deviceName, keys, layoutOptions, currentValues } = input

  const visibleKeys = getVisibleKeys(keys, currentValues)
  const bounds = computeBounds(visibleKeys)

  if (bounds.width === 0 || bounds.height === 0) {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    return arrayBufferToBase64(doc.output('arraybuffer'))
  }

  // Build multi-line header
  const fallback = sanitizeLabel(deviceName).trim() || 'Layout'
  const hdrLines = splitHeaderLines(buildStateHeader(layoutOptions, currentValues, fallback))
  const hdrH = headerHeight(hdrLines.length)

  const maxContentHeight = MAX_PAGE_HEIGHT - MARGIN * 2 - hdrH - FOOTER_HEIGHT - BORDER_PAD * 2
  const scale = Math.min(
    USABLE_WIDTH / bounds.width,
    maxContentHeight / bounds.height,
  )

  const spacing = scale * SPACING_FRACTION
  const visualW = bounds.width * scale - spacing
  const visualH = bounds.height * scale - spacing

  const borderW = visualW + BORDER_PAD * 2
  const borderH = visualH + BORDER_PAD * 2
  const borderX = (PAGE_WIDTH - borderW) / 2
  const borderY = MARGIN + hdrH

  const keysOffsetX = borderX + BORDER_PAD - bounds.minX * scale
  const keysOffsetY = borderY + BORDER_PAD - bounds.minY * scale

  const pageHeight = MARGIN + hdrH + borderH + FOOTER_HEIGHT + MARGIN

  const doc = new jsPDF({
    orientation: pageOrientation(pageHeight),
    unit: 'mm',
    format: [PAGE_WIDTH, pageHeight],
  })

  // Render multi-line header
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(12)
  doc.setTextColor(0)
  let hdrY = MARGIN
  for (const line of hdrLines) {
    doc.text(line, MARGIN, hdrY + HEADER_BASELINE_OFFSET)
    hdrY += HEADER_LINE_HEIGHT
  }

  // Outer border
  doc.setDrawColor(180)
  doc.setLineWidth(0.3)
  doc.roundedRect(borderX, borderY, borderW, borderH, 1.5, 1.5, 'S')

  drawKeyboard(doc, visibleKeys, keysOffsetX, keysOffsetY, scale)

  // Footer
  const footerText = buildFooterText(deviceName, formatTimestamp(new Date()))
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(7)
  doc.setTextColor(150)
  doc.text(footerText, PAGE_WIDTH / 2, pageHeight - MARGIN, { align: 'center' })

  return arrayBufferToBase64(doc.output('arraybuffer'))
}
