// SPDX-License-Identifier: GPL-2.0-or-later
//
// Regression coverage for the View Matrix Wires gutter label order on a
// split keyboard. The row-number gutter must always read in ascending
// index order for any two labels that land close enough together to
// collide — a sub-pixel difference between two rows' rotated label
// anchors (the split-thumb fixture's rows 3 and 7) must never flip which
// one appears to the left. Drives the dummy-JSON load path (no hardware or
// virtual device required) with a fixture built specifically to reproduce
// the reported "7 3" ordering.

import { test, expect } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { launchApp } from './helpers/electron'
import {
  closeKeycodesOverlay,
  dismissNotificationModal,
  nullifyLastDeviceConfig,
  openOverlayTab,
  overlayTabNotFoundMessage,
  restoreLastDeviceConfig,
  type LastDeviceBackup,
} from './helpers/doc-capture-common'

const SCREENSHOT_DIR = resolve(import.meta.dirname, 'screenshots')
const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/e2e_test_split_thumb.json')

let app: ElectronApplication
let page: Page
let lastDeviceBackup: LastDeviceBackup

test.beforeAll(async () => {
  const launched = await launchApp({
    // No virtual device needed — the dummy-JSON load path never touches
    // HID at all. Still guard against a `lastDevice` left over from an
    // earlier e2e run in the shared ~/.config/Electron profile: that would
    // auto-reconnect on boot and skip the device-selector screen (and its
    // "Load from JSON file…" button) entirely — same gotcha documented on
    // popover-behavior.test.ts and tray-start-unlock.test.ts.
    onMainReady: async ({ userDataPath }) => {
      lastDeviceBackup = nullifyLastDeviceConfig(userDataPath)
    },
  })
  app = launched.app
  page = launched.page

  await dismissNotificationModal(page, { waitForAppearMs: 3_000 })

  // Route the next native open-file dialog straight to the split-thumb
  // fixture, mirroring doc-capture-view-matrix.ts's interceptFileDialog —
  // there is no real file picker to drive in a headless Electron session.
  await app.evaluate(
    async ({ dialog }, fixturePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] })
    },
    FIXTURE_PATH,
  )

  await page.locator('[data-testid="dummy-button"]').click()
  await page.locator('[data-testid="editor-content"]').waitFor({ state: 'visible', timeout: 20_000 })
  await dismissNotificationModal(page)
})

test.afterAll(async () => {
  await app?.close()
  // Restore after close — window-state saves on quit rewrite config.json,
  // so restoring first would just be overwritten by that later write.
  if (lastDeviceBackup) restoreLastDeviceConfig(lastDeviceBackup)
})

/** Saves a screenshot for local visual review only — same rationale as
 *  popover-behavior.test.ts's own `capture`: nothing on CI looks at these,
 *  and there is no pixel-diff baseline to maintain. */
async function capture(locator: Locator, name: string): Promise<void> {
  if (process.env.CI) return
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await locator.screenshot({ path: resolve(SCREENSHOT_DIR, `${name}.png`) })
}

/** Opens the Tools tab and flips the View Matrix Wires toggle to `on`,
 *  idempotently — mirrors doc-capture-view-matrix.ts's setViewMatrixWires,
 *  but local to this spec since that script's helper isn't exported for
 *  reuse. Leaves the overlay closed again on return. */
async function enableMatrixWires(): Promise<void> {
  if (!(await openOverlayTab(page, 'tools'))) {
    throw new Error(overlayTabNotFoundMessage('tools'))
  }
  const toggle = page.locator('[data-testid="overlay-view-matrix-wires-toggle"]')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  }
  await closeKeycodesOverlay(page)
}

/** One gutter label's matrix index and on-screen bounding box. */
interface WireLabel {
  index: number
  box: { x: number; y: number; width: number; height: number }
}

/** Reads every label of one wire axis out of the overlay. Labels are
 *  every `<text>` painted with that axis's own wire color (`fill`, a CSS
 *  variable defined in matrix-wires constants) — filtering on `fill` is
 *  robust against the overlay's own draw order instead of assuming a
 *  fixed slice of texts belongs to one axis. `expectedCount` is awaited
 *  via `toHaveCount` before reading, since `locator.count()` alone doesn't
 *  auto-wait for the overlay to finish rendering all of its labels. */
async function readWireLabels(fill: string, expectedCount: number): Promise<WireLabel[]> {
  const locator = page.locator(`[data-testid="matrix-wires"] text[fill="${fill}"]`)
  await expect(locator).toHaveCount(expectedCount)
  const count = await locator.count()
  const labels: WireLabel[] = []
  for (let i = 0; i < count; i++) {
    const el = locator.nth(i)
    const text = await el.textContent()
    const box = await el.boundingBox()
    if (text === null || box === null) throw new Error(`wire label ${i} has no text/box`)
    labels.push({ index: Number(text), box })
  }
  return labels
}

async function readRowLabels(expectedCount: number): Promise<WireLabel[]> {
  return readWireLabels('var(--wire-row)', expectedCount)
}

async function readColLabels(expectedCount: number): Promise<WireLabel[]> {
  return readWireLabels('var(--wire-col)', expectedCount)
}

// Tagged @virtual so it runs in CI with the other self-contained specs
// (ci.yml's `--grep @virtual`): the dummy JSON load path needs no real
// hardware or local Hub either, even though it never touches the virtual
// device itself.
test.describe('View Matrix Wires — split-board gutter label order', { tag: '@virtual' }, () => {
  test('keeps every colliding row label in ascending index order in the rendered gutter', async () => {
    await enableMatrixWires()

    const labels = await readRowLabels(8)

    // "Vertical centers closer than the label height" is this test's own
    // stand-in for buildMatrixWires's `pitch`. This deliberately checks
    // rendered bounding boxes — what the user actually sees — rather than
    // recomputing the layout's pitch from a font size; box height is
    // smaller than the row pitch, so any pair this treats as overlapping
    // is one the layout also stacked onto separate lines.
    for (const a of labels) {
      for (const b of labels) {
        if (a.index >= b.index) continue
        const aCenterY = a.box.y + a.box.height / 2
        const bCenterY = b.box.y + b.box.height / 2
        if (Math.abs(aCenterY - bCenterY) < Math.min(a.box.height, b.box.height)) {
          expect(a.box.x).toBeLessThan(b.box.x)
        }
      }
    }

    // The reported case: rows 3 (left thumb) and 7 (right thumb) collide
    // by a fraction of a pixel. Row 3 must render to the left of row 7,
    // never "7 3".
    const row3 = labels.find((l) => l.index === 3)!
    const row7 = labels.find((l) => l.index === 7)!
    expect(row3.box.x).toBeLessThan(row7.box.x)

    await capture(page.locator('[data-testid="primary-pane"]'), 'view-matrix-wires-split')
  })

  test('shows a column number above every top-row key on both halves', async () => {
    // enableMatrixWires is idempotent, so this test doesn't depend on the
    // toggle already being on from the previous one.
    await enableMatrixWires()

    const labels = await readColLabels(10)

    for (let col = 0; col <= 4; col++) {
      const matches = labels.filter((l) => l.index === col)
      expect(matches).toHaveLength(2)
      const labelCenters = matches.map((l) => l.box.x + l.box.width / 2).sort((a, b) => a - b)

      const leftKeyBox = await page
        .locator(`[data-testid="editor-content"] g[data-key-pos="0,${col}"]`)
        .boundingBox()
      const rightKeyBox = await page
        .locator(`[data-testid="editor-content"] g[data-key-pos="4,${col}"]`)
        .boundingBox()
      if (leftKeyBox === null || rightKeyBox === null) throw new Error(`key box missing for column ${col}`)
      const keyBoxesSorted = [leftKeyBox, rightKeyBox].sort(
        (a, b) => a.x + a.width / 2 - (b.x + b.width / 2),
      )
      const keyCenters = keyBoxesSorted.map((box) => box.x + box.width / 2)

      expect(Math.abs(labelCenters[0] - keyCenters[0])).toBeLessThan(5)
      expect(Math.abs(labelCenters[1] - keyCenters[1])).toBeLessThan(5)

      // "Above" means above: each label's box must sit at or higher than
      // the top of the key it labels, not just horizontally aligned with it.
      const matchesSorted = [...matches].sort(
        (a, b) => a.box.x + a.box.width / 2 - (b.box.x + b.box.width / 2),
      )
      for (let i = 0; i < matchesSorted.length; i++) {
        expect(matchesSorted[i].box.y + matchesSorted[i].box.height).toBeLessThanOrEqual(keyBoxesSorted[i].y)
      }
    }

    await capture(page.locator('[data-testid="primary-pane"]'), 'view-matrix-wires-split-col-labels')
  })
})
