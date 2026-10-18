// SPDX-License-Identifier: GPL-2.0-or-later
//
// The window fits its display's work area. The nominal minimum size
// (1280x1024) stays, but where the work area is smaller (a small screen
// under the Dock, or an oversized saved windowState on any platform) the
// window is clamped into the visible area. The test saves a wildly
// oversized windowState in config.json while the app is stopped, launches
// it again and checks the window's bounds and minimum size against the
// work area. The window's bounds are what the window has now, which a
// window manager that clamps oversized windows itself may already have
// changed; the tests' X server runs none, so here the bounds are the app's.
// The clamp itself is unit-tested in src-tauri/src/window_bounds.rs and
// window_state.rs.

import { writeFileSync } from 'node:fs'
import { $, browser, expect } from '@wdio/globals'
import { connectVirtualKeyboard, restartApp, tid } from '../helpers/app'
import { readAppConfig, userDataPath } from '../helpers/driver'
import { waitForPage, windowState } from '../helpers/resident'

/** Large and far off the origin enough to need the clamp on any monitor,
 *  with its centre, (100, 100), still on the primary display: a saved
 *  state whose centre is on no display is dropped for the default one,
 *  which would never reach the clamp of a saved position. */
const SEEDED_WINDOW_STATE = { x: -9900, y: -9900, width: 20000, height: 20000 }
/** Under Wayland the app neither reads nor sets its window's position. */
const positionsKnown = !process.env.WAYLAND_DISPLAY || process.env.GDK_BACKEND === 'x11'

describe('Window clamped to the display work area', () => {
  before(function () {
    // The restart finds the app's process through /proc.
    if (process.platform !== 'linux') this.skip()
  })

  it('keeps the window bounds and the minimum size inside the work area', async () => {
    await restartApp(() => {
      writeFileSync(
        userDataPath('config.json'),
        JSON.stringify({ ...readAppConfig(), windowState: SEEDED_WINDOW_STATE }, null, 2),
      )
    })
    await waitForPage()
    await connectVirtualKeyboard()
    await $(tid('status-bar')).waitForDisplayed()

    // The screen's available area is the work area of the display the
    // window is on (GDK's monitor work area).
    const workArea = await browser.execute(() => {
      const screen = window.screen as Screen & { availLeft?: number; availTop?: number }
      return { x: screen.availLeft ?? 0, y: screen.availTop ?? 0, width: screen.availWidth, height: screen.availHeight }
    })
    const bounds = await browser.getWindowRect()
    const { minSize } = await windowState()

    // Smaller than asked, not merely a request that happened to fit.
    expect(bounds.width).toBeLessThan(SEEDED_WINDOW_STATE.width)
    expect(bounds.height).toBeLessThan(SEEDED_WINDOW_STATE.height)
    expect(bounds.width).toBeLessThanOrEqual(workArea.width)
    expect(bounds.height).toBeLessThanOrEqual(workArea.height)
    if (positionsKnown) {
      expect(bounds.x).toBeGreaterThanOrEqual(workArea.x)
      expect(bounds.y).toBeGreaterThanOrEqual(workArea.y)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height)
    }

    // A minimum size larger than the work area would keep the user from
    // dragging the window's edge back inside it.
    if (minSize === null) throw new Error('the window has no minimum size')
    expect(minSize.width).toBeLessThanOrEqual(workArea.width)
    expect(minSize.height).toBeLessThanOrEqual(workArea.height)
  })
})
