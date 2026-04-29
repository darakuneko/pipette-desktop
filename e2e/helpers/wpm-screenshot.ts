// SPDX-License-Identifier: GPL-2.0-or-later

// Ad-hoc screenshot of the Analyze > WPM view for visual verification
// of the stat-card tooltip alignment fix. Copies the user's production
// userData into a temp dir so existing typing analytics data renders
// without competing with a running production instance.
//
// Usage: pnpm build && npx tsx e2e/helpers/wpm-screenshot.ts [output-path]

import { _electron as electron } from '@playwright/test'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { dismissNotificationModal } from './doc-capture-common'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const DEFAULT_OUTPUT = '/tmp/wpm-screenshot.png'
const SRC_USER_DATA = resolve(homedir(), '.config/pipette-desktop')
const TEMP_USER_DATA = resolve(tmpdir(), 'pipette-wpm-screenshot')

function setupUserData(): void {
  if (!existsSync(SRC_USER_DATA)) {
    console.log(`[warn] ${SRC_USER_DATA} not found — running without seed data`)
    return
  }
  rmSync(TEMP_USER_DATA, { recursive: true, force: true })
  cpSync(SRC_USER_DATA, TEMP_USER_DATA, { recursive: true })
  console.log(`Copied userData: ${SRC_USER_DATA} → ${TEMP_USER_DATA}`)
}

function cleanupUserData(): void {
  rmSync(TEMP_USER_DATA, { recursive: true, force: true })
}

async function main(): Promise<void> {
  const outputPath = process.argv[2] || DEFAULT_OUTPUT

  setupUserData()

  console.log('Launching Electron app...')
  const app = await electron.launch({
    args: [
      resolve(PROJECT_ROOT, 'out/main/index.js'),
      '--no-sandbox',
      '--disable-gpu-sandbox',
      `--user-data-dir=${TEMP_USER_DATA}`,
    ],
    cwd: PROJECT_ROOT,
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1320, height: 960 })
  await page.waitForTimeout(3000)

  try {
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })

    const analyzeTab = page.locator('[data-testid="tab-analyze"]')
    await analyzeTab.waitFor({ state: 'visible', timeout: 10_000 })
    await analyzeTab.click()
    console.log('Switched to Analyze tab')

    await page.locator('[data-testid="analyze-page"]').waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(1000)

    const kbButtons = page.locator('[data-testid^="analyze-kb-"]')
    const kbCount = await kbButtons.count()
    if (kbCount > 0) {
      await kbButtons.first().click()
      console.log(`Selected keyboard (found ${kbCount})`)
      await page.waitForTimeout(1500)
    } else {
      console.log('[warn] No keyboards in seeded data — capturing empty state')
    }

    const wpmTab = page.locator('[data-testid="analyze-tab-wpm"]')
    if (await wpmTab.count() > 0) {
      await wpmTab.click()
      console.log('Selected WPM tab')
      await page.waitForTimeout(2000)
    }

    await page.screenshot({ path: outputPath, fullPage: false })
    console.log(`Screenshot saved: ${outputPath}`)

    // Capture hover states for row-1 center card (index 2) and
    // right-most card (index 3) to verify wrap vs nowrap behaviour.
    const cards = page.locator('[class*="group/tt"][class*="block h-full w-full"]')
    const cardCount = await cards.count()
    if (cardCount >= 4) {
      await cards.nth(2).hover()
      await page.waitForTimeout(600)
      const center = outputPath.replace(/\.png$/, '-hover-center.png')
      await page.screenshot({ path: center, fullPage: false })
      console.log(`Center hover screenshot saved: ${center}`)

      await page.mouse.move(0, 0)
      await page.waitForTimeout(300)

      await cards.nth(3).hover()
      await page.waitForTimeout(600)
      const right = outputPath.replace(/\.png$/, '-hover-right.png')
      await page.screenshot({ path: right, fullPage: false })
      console.log(`Right-most hover screenshot saved: ${right}`)

      await page.mouse.move(0, 0)
      await page.waitForTimeout(300)

      const legendItems = page.locator('[data-testid="analyze-chart"] .recharts-legend-item')
      const legendCount = await legendItems.count()
      console.log(`Legend items found: ${legendCount}`)
      if (legendCount >= 2) {
        await legendItems.nth(1).hover({ force: true })
        await page.waitForTimeout(600)
        const legend = outputPath.replace(/\.png$/, '-hover-legend.png')
        await page.screenshot({ path: legend, fullPage: false })
        console.log(`Legend hover screenshot saved: ${legend}`)
      }
    } else {
      console.log(`[warn] Found only ${cardCount} stat-card wrappers`)
    }

    // Switch to Activity tab and hover the right-most heatmap cell
    // (hour=23) of any row with data. 168 cells total; the 24th cell
    // on each row is the right edge.
    await page.mouse.move(0, 0)
    await page.waitForTimeout(300)
    const activityTab = page.locator('[data-testid="analyze-tab-activity"]')
    if (await activityTab.count() > 0) {
      await activityTab.click()
      await page.waitForTimeout(1500)
      console.log('Switched to Activity tab')

      const rightEdgeCells = page.locator('[role="cell"][aria-label]').filter({ has: page.locator('text=23時, text=23:00') })
      // Fallback: pick the 24th cell of the first row with tooltip.
      const cells = page.locator('[role="cell"]')
      const cellsCount = await cells.count()
      console.log(`Heatmap cells found: ${cellsCount}`)

      // iterate rows (7) and pick right-edge (index 23, 47, 71, ...) that has aria-label
      for (let row = 0; row < 7; row++) {
        const idx = row * 24 + 23
        const cell = cells.nth(idx)
        const label = await cell.getAttribute('aria-label')
        if (label && label.length > 0) {
          await cell.hover({ force: true })
          await page.waitForTimeout(600)
          const activityOut = outputPath.replace(/\.png$/, '-activity-hover-right.png')
          await page.screenshot({ path: activityOut, fullPage: false })
          console.log(`Activity right-edge hover screenshot saved: ${activityOut} (row=${row}, label="${label}")`)
          break
        }
      }
      void rightEdgeCells // unused direct locator, kept for potential future use
    }

    const debugInfo = await page.evaluate(() => {
      const viewport = { w: window.innerWidth, h: window.innerHeight }
      const scroll = {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
      }
      const overflowing: Array<{ tag: string; right: number; width: number; id: string; cls: string }> = []
      const threshold = scroll.clientWidth
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.right > threshold + 5) {
          overflowing.push({
            tag: el.tagName,
            right: Math.round(r.right),
            width: Math.round(r.width),
            id: (el as HTMLElement).id ?? '',
            cls: ((el as HTMLElement).className?.toString?.() ?? '').slice(0, 100),
          })
        }
      }
      overflowing.sort((a, b) => b.right - a.right)

      // Scan all elements including scrollLeft/scrollWidth mismatches
      const problem: Array<{ tag: string; scrollW: number; clientW: number; cls: string }> = []
      for (const el of document.querySelectorAll('*')) {
        const scrollW = el.scrollWidth
        const clientW = el.clientWidth
        if (scrollW > clientW + 5) {
          problem.push({
            tag: el.tagName,
            scrollW,
            clientW,
            cls: ((el as HTMLElement).className?.toString?.() ?? '').slice(0, 100),
          })
        }
      }
      problem.sort((a, b) => (b.scrollW - b.clientW) - (a.scrollW - a.clientW))
      return { viewport, scroll, overflowCount: overflowing.length, overflow: overflowing.slice(0, 10), scrollProblemCount: problem.length, scrollProblem: problem.slice(0, 10) }
    })
    console.log('Debug info:', JSON.stringify(debugInfo, null, 2))
  } finally {
    await app.close()
    cleanupUserData()
  }
}

main().catch((err: unknown) => {
  console.error('Screenshot failed:', err)
  cleanupUserData()
  process.exit(1)
})
