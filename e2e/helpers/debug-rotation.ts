// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Debug script for rotation transform issues.
 * Loads a vial.json via dummy mode and captures screenshots + debug info.
 *
 * Usage:
 *   pnpm build && npx tsx e2e/helpers/debug-rotation.ts
 */

import { _electron as electron } from '@playwright/test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const VIAL_JSON_PATH = resolve(PROJECT_ROOT, 'e2e/fixtures/e2e_test_iso.json')
const OUTPUT_DIR = '/tmp/vial-debug'

async function main(): Promise<void> {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(OUTPUT_DIR, { recursive: true })

  console.log('Launching app...')
  const app = await electron.launch({
    args: [
      resolve(PROJECT_ROOT, 'out/main/index.js'),
      '--no-sandbox',
      '--disable-gpu-sandbox',
    ],
    cwd: PROJECT_ROOT,
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  // Mock Electron dialog.showOpenDialog in main process
  await app.evaluate(({ dialog }, jsonPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [jsonPath],
    })
  }, VIAL_JSON_PATH)

  // Click "Load Dummy" button
  console.log('Loading vial.json via dummy mode...')
  await page.getByTestId('dummy-button').click()
  await page.waitForTimeout(3000)

  // Screenshot: full editor
  await page.screenshot({ path: `${OUTPUT_DIR}/02-editor.png`, fullPage: true })
  console.log('Saved: 02-editor.png')

  // Exhaustive SVG debug info
  const debug = await page.evaluate(() => {
    const svg = document.querySelector('svg.select-none') as SVGElement | null
    if (!svg) return { error: 'SVG not found' }

    const out: Record<string, unknown> = {
      svgWidth: svg.getAttribute('width'),
      svgHeight: svg.getAttribute('height'),
      viewBox: svg.getAttribute('viewBox'),
      svgBBox: (() => {
        const r = svg.getBoundingClientRect()
        return { top: r.top, left: r.left, width: r.width, height: r.height }
      })(),
    }

    // Enumerate EVERY <g> child of the SVG (each is a key)
    const allGroups = svg.querySelectorAll(':scope > g')
    out.totalKeys = allGroups.length

    const keyDetails: Record<string, unknown>[] = []
    allGroups.forEach((g, idx) => {
      const transform = g.getAttribute('transform')
      const hasRotation = !!transform
      const firstChild = g.children[0]
      const tag = firstChild?.tagName ?? '??'

      // Extract key rect/path dimensions
      let shape: Record<string, string> = {}
      if (tag === 'path') {
        shape = { d: firstChild.getAttribute('d')?.substring(0, 100) ?? '' }
      } else if (tag === 'rect') {
        shape = {
          x: firstChild.getAttribute('x') ?? '',
          y: firstChild.getAttribute('y') ?? '',
          width: firstChild.getAttribute('width') ?? '',
          height: firstChild.getAttribute('height') ?? '',
        }
      }

      // Get visual bounding box (after transform)
      const bbox = g.getBoundingClientRect()

      const entry: Record<string, unknown> = {
        idx,
        transform,
        hasRotation,
        shapeTag: tag,
        shape,
        childCount: g.children.length,
        visualBBox: {
          x: Math.round(bbox.x * 10) / 10,
          y: Math.round(bbox.y * 10) / 10,
          w: Math.round(bbox.width * 10) / 10,
          h: Math.round(bbox.height * 10) / 10,
        },
      }

      // For rotated keys, also compute expected position
      if (hasRotation) {
        // Parse transform values
        const m = transform?.match(/translate\(([^,]+),\s*([^)]+)\)\s*rotate\(([^)]+)\)\s*translate\(([^,]+),\s*([^)]+)\)/)
        if (m) {
          entry.parsedTransform = {
            tx1: parseFloat(m[1]),
            ty1: parseFloat(m[2]),
            angle: parseFloat(m[3]),
            tx2: parseFloat(m[4]),
            ty2: parseFloat(m[5]),
          }
        }

        // Get ALL children details for rotated keys
        entry.allChildren = Array.from(g.children).map((c) => ({
          tag: c.tagName,
          attrs: Object.fromEntries(
            Array.from(c.attributes).map((a) => [
              a.name,
              a.name === 'd' ? a.value.substring(0, 200) : a.value,
            ]),
          ),
        }))
      }

      keyDetails.push(entry)
    })

    out.keys = keyDetails

    // Container info
    const containers = document.querySelectorAll('[class*="keyboard"], [class*="editor"]')
    out.containers = Array.from(containers).slice(0, 5).map((c) => {
      const el = c as HTMLElement
      const cs = getComputedStyle(el)
      return {
        className: el.className.substring(0, 80),
        clientH: el.clientHeight,
        clientW: el.clientWidth,
        minH: cs.minHeight,
        overflowY: cs.overflowY,
      }
    })

    // Find the keyboard area div (parent of the SVG's parent)
    const svgParent = svg.parentElement
    const keyArea = svgParent?.parentElement
    if (keyArea) {
      const cs = getComputedStyle(keyArea)
      out.keyAreaParent = {
        tag: keyArea.tagName,
        className: keyArea.className.substring(0, 80),
        style: keyArea.getAttribute('style'),
        minH: cs.minHeight,
        clientH: keyArea.clientHeight,
      }
    }

    return out
  })

  console.log('\n=== FULL SVG DEBUG ===')
  console.log(JSON.stringify(debug, null, 2))

  // Capture SVG element
  const svgEl = page.locator('svg.select-none').first()
  if (await svgEl.isVisible()) {
    await svgEl.screenshot({ path: `${OUTPUT_DIR}/04-svg-only.png` })
    console.log('\nSaved: 04-svg-only.png')
  }

  await app.close()
  console.log('Done! Screenshots saved to:', OUTPUT_DIR)
}

main().catch((err: unknown) => {
  console.error('Debug failed:', err)
  process.exit(1)
})
