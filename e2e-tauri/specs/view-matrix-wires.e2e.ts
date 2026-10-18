// SPDX-License-Identifier: GPL-2.0-or-later
//
// View Matrix Wires on a split keyboard, loaded from a JSON definition
// (the device list's "Load from JSON file", answered through the file
// dialog of the development tools; no keyboard is opened). The row-number
// gutter reads in ascending index order for any two labels close enough
// to collide: in fixtures/e2e_test_split_thumb.json the rotated label
// anchors of rows 3 and 7 differ by a fraction of a pixel, and 3 must
// still be drawn left of 7. Each column's number is drawn above the
// top-row key of that column on both halves, centred over it. The tests
// share one session and run in order.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { $, browser, expect } from '@wdio/globals'
import { clickIntoFileDialog, EDITOR_SELECTOR, setToolsToggle, tid } from '../helpers/app'

const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/e2e_test_split_thumb.json')
const LOAD_TIMEOUT_MS = 20_000

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** One gutter label's matrix index and its box on screen. */
interface WireLabel {
  index: number
  box: Box
}

/** The labels of one wire axis: every `<text>` of the overlay painted in
 *  that axis's wire colour (`fill`, a CSS variable of the matrix wires'
 *  constants), whatever order the overlay draws them in. Waits until there
 *  are `expectedCount` of them, as the overlay draws its labels over more
 *  than one render. */
async function readWireLabels(fill: string, expectedCount: number): Promise<WireLabel[]> {
  const read = () =>
    browser.execute((selector: string) => {
      return [...document.querySelectorAll(selector)].map((el) => {
        const { x, y, width, height } = el.getBoundingClientRect()
        return { text: el.textContent ?? '', box: { x, y, width, height } }
      })
    }, `${tid('matrix-wires')} text[fill="${fill}"]`)
  let labels: { text: string; box: Box }[] = []
  await browser.waitUntil(
    async () => {
      labels = await read()
      return labels.length === expectedCount
    },
    { timeoutMsg: `the matrix wires did not draw ${expectedCount} labels of ${fill}` },
  )
  return labels.map(({ text, box }) => ({ index: Number(text), box }))
}

/** The box of the editor's key at matrix position `row,col`. */
async function keyBox(row: number, col: number): Promise<Box> {
  const box = await browser.execute((selector: string) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const { x, y, width, height } = el.getBoundingClientRect()
    return { x, y, width, height }
  }, `${EDITOR_SELECTOR} g[data-key-pos="${row},${col}"]`)
  if (box === null) throw new Error(`the key ${row},${col} is not drawn`)
  return box
}

const centerX = (box: Box): number => box.x + box.width / 2
const centerY = (box: Box): number => box.y + box.height / 2

describe('View Matrix Wires on a split keyboard', () => {
  before(async () => {
    await $(tid('dummy-button')).waitForDisplayed({ timeout: LOAD_TIMEOUT_MS })
    await clickIntoFileDialog(tid('dummy-button'), FIXTURE_PATH)
    await $(EDITOR_SELECTOR).waitForDisplayed({ timeout: LOAD_TIMEOUT_MS })
  })

  it('keeps every colliding row label in ascending index order in the gutter', async () => {
    await setToolsToggle('overlay-view-matrix-wires-toggle', true)
    const labels = await readWireLabels('var(--wire-row)', 8)

    // Vertical centres closer than a label's height stand in for the
    // layout's own pitch: the rendered boxes are what the user sees, and
    // a box is lower than the row pitch, so any pair taken as overlapping
    // here is one the layout also stacked on separate lines.
    for (const a of labels) {
      for (const b of labels) {
        if (a.index >= b.index) continue
        if (Math.abs(centerY(a.box) - centerY(b.box)) < Math.min(a.box.height, b.box.height)) {
          expect(a.box.x).toBeLessThan(b.box.x)
        }
      }
    }

    // Rows 3 (left thumb) and 7 (right thumb) collide by a fraction of a
    // pixel: 3 must be left of 7, never "7 3".
    const row3 = labels.find((l) => l.index === 3)
    const row7 = labels.find((l) => l.index === 7)
    if (!row3 || !row7) throw new Error('the gutter has no label of row 3 or row 7')
    expect(row3.box.x).toBeLessThan(row7.box.x)
  })

  it('shows a column number above every top-row key on both halves', async () => {
    await setToolsToggle('overlay-view-matrix-wires-toggle', true)
    const labels = await readWireLabels('var(--wire-col)', 10)

    for (let col = 0; col <= 4; col++) {
      const matches = labels.filter((l) => l.index === col).sort((a, b) => centerX(a.box) - centerX(b.box))
      expect(matches).toHaveLength(2)
      // Row 0 is the left half's top row and row 4 the right half's.
      const keys = [await keyBox(0, col), await keyBox(4, col)].sort((a, b) => centerX(a) - centerX(b))
      for (let i = 0; i < 2; i++) {
        expect(Math.abs(centerX(matches[i].box) - centerX(keys[i]))).toBeLessThan(5)
        expect(matches[i].box.y + matches[i].box.height).toBeLessThanOrEqual(keys[i].y)
      }
    }
  })
})
