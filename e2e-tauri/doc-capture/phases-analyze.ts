// SPDX-License-Identifier: GPL-2.0-or-later
//
// The captures of the Analyze page, opened from the device-selection screen,
// on the seeded keyboard's typing analytics.

import { DUMMY_TA_UID } from '../helpers/analyze-seed'
import { captureNamed, isAvailable, selectKeyboardViaFilterModal, selectSnapshotViaFilterModal } from './common'
import type { Page } from './page'

// Clicks a segmented control's "on" option, runs `shot` to capture that
// state, then clicks the "off" option back so later capture steps (and
// a re-run of this helper) don't inherit the alternate segment. Shared
// by the Heatmap Speed mode and Bigrams 3-gram captures, which only
// differ in what `shot` screenshots.
async function captureSegmentVariant(
  page: Page,
  onTestId: string,
  offTestId: string,
  shot: () => Promise<void>,
): Promise<void> {
  const onToggle = page.locator(`[data-testid="${onTestId}"]`)
  if (!(await isAvailable(onToggle))) {
    console.log(`  [warn] ${onTestId} not available — capture skipped`)
    return
  }
  await onToggle.click()
  await page.waitForTimeout(800)
  await shot()
  const offToggle = page.locator(`[data-testid="${offTestId}"]`)
  if (await isAvailable(offToggle)) {
    await offToggle.click()
    await page.waitForTimeout(500)
  }
}

// --- Phase 1.8: Analyze Page (from device selector, Analyze tab) ---

// Captures the Analyze page from the device-selection screen, drawn from the
// seeded typing analytics. When the seeded keyboard cannot be selected, the
// captures fall back to the overview so the guide still has a reference
// image.
export async function captureAnalyzePage(page: Page): Promise<void> {
  console.log('\n--- Phase 1.8: Analyze Page ---')

  const analyzeTab = page.locator('[data-testid="tab-analyze"]')
  if (!(await isAvailable(analyzeTab))) {
    console.log('  [skip] tab-analyze not found')
    return
  }
  await analyzeTab.click()
  await page.waitForTimeout(500)

  const analyzePage = page.locator('[data-testid="analyze-page"]')
  if (!(await isAvailable(analyzePage))) {
    console.log('  [skip] analyze-page did not open')
    return
  }

  // Keyboard selection lives in the staged filter modal behind the
  // summary chip (chip -> keyboard select -> Apply). Every capture below
  // must land on the seeded dummy keyboard (DUMMY_TA_UID) specifically:
  // the list is alphabetical, so "whichever sorts first" could be another
  // keyboard with typing data.
  const selected = await selectKeyboardViaFilterModal(page, DUMMY_TA_UID)
  if (!selected) {
    console.log('  [warn] seeded keyboard not selectable — capturing overview only')
  }
  const filterChip = page.locator('[data-testid="analyze-filter-chip"]')

  // Summary: default landing tab. Capture the four-card overview, then
  // surface the Goal Achievements modal from the Streak / Goal card.
  const summaryTab = page.locator('[data-testid="analyze-tab-summary"]')
  if (await isAvailable(summaryTab)) {
    await summaryTab.click()
    await page.waitForTimeout(800)
    await captureNamed(page, 'analyze-summary', { fullPage: true })

    const goalHistoryBtn = page.locator('[data-testid="analyze-streak-goal-history-open"]')
    if ((await isAvailable(goalHistoryBtn)) && (await goalHistoryBtn.isEnabled())) {
      await goalHistoryBtn.click()
      await page.waitForTimeout(500)
      const goalModal = page.locator('[data-testid="analyze-goal-achievements-modal"]')
      if (await isAvailable(goalModal)) {
        await captureNamed(page, 'analyze-goal-achievements', { element: goalModal })
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      } else {
        console.log('  [warn] analyze-goal-achievements-modal did not open')
      }
    } else {
      console.log('  [skip] analyze-streak-goal-history-open not available')
    }
  } else {
    console.log('  [skip] analyze-tab-summary not found')
  }

  // App filter popover — the multi-select lives in the staged filter
  // modal behind the summary chip. Captured as a full-page screenshot so
  // the open popover and the modal context land together, then both are
  // closed (Escape may close popover+modal together depending on event
  // propagation, so the modal close is guarded).
  if (await isAvailable(filterChip)) {
    await filterChip.click()
    await page.waitForTimeout(400)
    const appFilter = page.locator('[data-testid="analyze-filter-app"]')
    if (await isAvailable(appFilter)) {
      await appFilter.click()
      await page.waitForTimeout(300)
      await captureNamed(page, 'analyze-app-filter', { fullPage: true })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    } else {
      console.log('  [skip] analyze-filter-app not found')
    }
    const modalClose = page.locator('[data-testid="analyze-filter-modal-close"]')
    if (await isAvailable(modalClose)) {
      await modalClose.click()
      await page.waitForTimeout(300)
    }
  } else {
    console.log('  [skip] analyze-filter-chip not found — app filter capture skipped')
  }

  // Filter Store side panel — toggle open, capture the panel as an
  // element shot, then close so subsequent tabs render unobstructed.
  const filterStoreToggle = page.locator('[data-testid="analyze-filter-store-toggle"]')
  if (await isAvailable(filterStoreToggle)) {
    await filterStoreToggle.click()
    await page.waitForTimeout(400)
    const storePanel = page.locator('[data-testid="analyze-filter-store-panel"]')
    if (await isAvailable(storePanel)) {
      await captureNamed(page, 'analyze-filter-store', { element: storePanel })
    } else {
      console.log('  [warn] analyze-filter-store-panel did not open')
    }
    await filterStoreToggle.click()
    await page.waitForTimeout(200)
  } else {
    console.log('  [skip] analyze-filter-store-toggle not found')
  }

  // Heatmap: requires a snapshot; empty state is captured if none exists.
  const heatmapTab = page.locator('[data-testid="analyze-tab-keyHeatmap"]')
  if (await isAvailable(heatmapTab)) {
    await heatmapTab.click()
    await page.waitForTimeout(800)
    await captureNamed(page, 'analyze-heatmap', { fullPage: true })

    // Speed mode: switch the Count/Speed toggle, capture, then switch back
    // to Count. Mirrors the bigrams gram-toggle capture below.
    await captureSegmentVariant(
      page,
      'analyze-keyheatmap-mode-toggle-speed',
      'analyze-keyheatmap-mode-toggle-count',
      () => captureNamed(page, 'analyze-heatmap-speed', { fullPage: true }),
    )

    // Duration mode: same Count round-trip as Speed above.
    await captureSegmentVariant(
      page,
      'analyze-keyheatmap-mode-toggle-duration',
      'analyze-keyheatmap-mode-toggle-count',
      () => captureNamed(page, 'analyze-heatmap-duration', { fullPage: true }),
    )
  } else {
    console.log('  [skip] analyze-tab-keyHeatmap not found')
  }

  const wpmTab = page.locator('[data-testid="analyze-tab-wpm"]')
  if (await isAvailable(wpmTab)) {
    await wpmTab.click()
    await page.waitForTimeout(800)
    const wpmViewMode = page.locator('[data-testid="analyze-filter-wpm-view-mode"]')
    if (await isAvailable(wpmViewMode)) {
      await wpmViewMode.selectOption('timeSeries')
      await page.waitForTimeout(500)
      await captureNamed(page, 'analyze-wpm-time-series', { fullPage: true })
      await wpmViewMode.selectOption('timeOfDay')
      await page.waitForTimeout(500)
      await captureNamed(page, 'analyze-wpm-time-of-day', { fullPage: true })
    } else {
      console.log('  [warn] wpm view-mode select not found — capturing default only')
      await captureNamed(page, 'analyze-wpm-time-series', { fullPage: true })
    }
  } else {
    console.log('  [skip] analyze-tab-wpm not found')
  }

  const intervalTab = page.locator('[data-testid="analyze-tab-interval"]')
  if (await isAvailable(intervalTab)) {
    await intervalTab.click()
    await page.waitForTimeout(800)
    const intervalViewMode = page.locator('[data-testid="analyze-filter-interval-view-mode"]')
    if (await isAvailable(intervalViewMode)) {
      await intervalViewMode.selectOption('timeSeries')
      await page.waitForTimeout(500)
      await captureNamed(page, 'analyze-interval-time-series', { fullPage: true })
      await intervalViewMode.selectOption('distribution')
      await page.waitForTimeout(500)
      // The distribution "Section" select (in the controls row, right
      // after View) defaults to 'Interval distribution' — captured here
      // — then round-trips through 'Keypress duration' and 'Tapping
      // Term diagnosis' the same way the interval View select itself
      // round-trips timeSeries/distribution above.
      await captureNamed(page, 'analyze-interval-distribution', { fullPage: true })
      const distributionSection = page.locator('[data-testid="analyze-filter-interval-distribution-section"]')
      if (await isAvailable(distributionSection)) {
        await distributionSection.selectOption('duration')
        await page.waitForTimeout(500)
        await captureNamed(page, 'analyze-interval-duration', { fullPage: true })
        await distributionSection.selectOption('tappingTerm')
        await page.waitForTimeout(500)
        await captureNamed(page, 'analyze-interval-tapping-term', { fullPage: true })
        await distributionSection.selectOption('interval')
        await page.waitForTimeout(500)
      } else {
        console.log('  [warn] interval distribution-section select not found — duration/tapping-term captures skipped')
      }
    } else {
      console.log('  [warn] interval view-mode select not found — capturing default only')
      await captureNamed(page, 'analyze-interval-time-series', { fullPage: true })
    }
  } else {
    console.log('  [skip] analyze-tab-interval not found')
  }

  // Activity: representative captures for the keystrokes grid and the
  // year-spanning calendar. Both run from the same metric select; the
  // calendar capture comes second so the metric ends in calendar mode
  // ready for the operation guide screenshot.
  const activityTab = page.locator('[data-testid="analyze-tab-activity"]')
  if (await isAvailable(activityTab)) {
    await activityTab.click()
    await page.waitForTimeout(800)
    const activityMetric = page.locator('[data-testid="analyze-filter-activity-metric"]')
    if (await isAvailable(activityMetric)) {
      await activityMetric.selectOption('keystrokes')
      await page.waitForTimeout(500)
    }
    await captureNamed(page, 'analyze-activity-keystrokes', { fullPage: true })

    // Calendar view — switch via the View select. The chart always
    // renders the selected year (current year by default), which
    // gives the guide a representative full-year shape without
    // touching the year picker.
    const activityView = page.locator('[data-testid="analyze-filter-activity-view"]')
    if (await isAvailable(activityView)) {
      await activityView.selectOption('calendar')
      await page.waitForTimeout(800)
      await captureNamed(page, 'analyze-activity-calendar', { fullPage: true })
    }
  } else {
    console.log('  [skip] analyze-tab-activity not found')
  }

  const ergonomicsTab = page.locator('[data-testid="analyze-tab-ergonomics"]')
  if (await isAvailable(ergonomicsTab)) {
    await ergonomicsTab.click()
    await page.waitForTimeout(800)
    await captureNamed(page, 'analyze-ergonomics', { fullPage: true })

    // Learning curve sub-view: switch the View filter to 'learning'
    // and capture the trend chart, then restore the snapshot view so
    // the rest of the run keeps the historical layout. We also pivot
    // to the older keymap snapshot beforehand so the active range
    // expands to cover the historical matrix-minute rows seeded by
    // analyze-seed.ts; the default "Current keymap" range is only
    // ~4 hours and would render the empty state.
    const viewModeSelect = page.locator('[data-testid="analyze-filter-ergonomics-view-mode"]')
    if (await isAvailable(viewModeSelect)) {
      await viewModeSelect.selectOption('learning')
      await page.waitForTimeout(800)
      // Snapshot pivot goes through the staged filter modal (chip ->
      // Keymap row -> Apply); settleMs covers the range update +
      // matrix-cells-by-day re-fetch.
      const pivoted = await selectSnapshotViaFilterModal(page, 1, { settleMs: 1500 })
      if (!pivoted) {
        console.log('  [warn] only one snapshot present — learning curve may render empty')
      }
      await captureNamed(page, 'analyze-ergonomics-learning', { fullPage: true })
      if (pivoted) {
        // Reset to "Current keymap" (option index 0) so the captures
        // that follow keep the latest snapshot's 4-hour active window.
        await selectSnapshotViaFilterModal(page, 0, { settleMs: 800 })
      }
      await viewModeSelect.selectOption('snapshot')
      await page.waitForTimeout(400)
    } else {
      console.log('  [skip] analyze-filter-ergonomics-view-mode not found — learning capture skipped')
    }

    // Open button is disabled when no snapshot is available — gate on isEnabled.
    const fingerBtn = page.locator('[data-testid="analyze-finger-assignment-open"]')
    if ((await isAvailable(fingerBtn)) && (await fingerBtn.isEnabled())) {
      await fingerBtn.click()
      await page.waitForTimeout(500)
      const fingerModal = page.locator('[data-testid="finger-assignment-modal"]')
      if (await isAvailable(fingerModal)) {
        // Element screenshot so the modal fills the frame instead of the dimmed backdrop.
        await captureNamed(page, 'analyze-finger-assignment-modal', { element: fingerModal })
        const closeBtn = page.locator('[data-testid="finger-assignment-close"]')
        if (await isAvailable(closeBtn)) {
          await closeBtn.click()
          await page.waitForTimeout(500)
        }
      } else {
        console.log('  [warn] finger-assignment-modal did not open')
      }
    } else {
      console.log('  [warn] finger-assignment button not available — modal capture skipped')
    }
  } else {
    console.log('  [skip] analyze-tab-ergonomics not found')
  }

  const bigramsTab = page.locator('[data-testid="analyze-tab-bigrams"]')
  if (await isAvailable(bigramsTab)) {
    await bigramsTab.click()
    await page.waitForTimeout(800)
    // Element screenshot of the 2x2 quadrant grid keeps the four sub-views
    // legible — `fullPage` would dilute each quadrant against sidebar/filters.
    const bigramsContent = page.locator('[data-testid="analyze-bigrams-content"]')
    if (await isAvailable(bigramsContent)) {
      await captureNamed(page, 'analyze-bigrams', { element: bigramsContent })
    } else {
      console.log('  [warn] analyze-bigrams-content not visible — capture skipped')
    }

    // 3-gram view: switch the gram toggle, capture the root (toggle +
    // content) so the "3-gram" segment reads as active in the shot, then
    // switch back to 2-gram.
    await captureSegmentVariant(
      page,
      'analyze-bigrams-gram-toggle-3',
      'analyze-bigrams-gram-toggle-2',
      async () => {
        const bigramsRoot = page.locator('[data-testid="analyze-bigrams-root"]')
        if (await isAvailable(bigramsRoot)) {
          await captureNamed(page, 'analyze-bigrams-trigram', { element: bigramsRoot })
        } else {
          console.log('  [warn] analyze-bigrams-root not visible — trigram capture skipped')
        }
      },
    )
  } else {
    console.log('  [skip] analyze-tab-bigrams not found')
  }

  const layoutComparisonTab = page.locator('[data-testid="analyze-tab-layoutComparison"]')
  if (await isAvailable(layoutComparisonTab)) {
    await layoutComparisonTab.click()
    await page.waitForTimeout(500)
    // Pick Colemak so each diff panel actually has something to render.
    // All three panels render simultaneously, so we capture each one
    // via its data-testid root rather than flipping a sub-view toggle.
    const targetSelect = page.locator('[data-testid="analyze-layout-comparison-target-select"]')
    if (await isAvailable(targetSelect)) {
      const targetOptions = await targetSelect.locator('option:not([value="__none__"])').all()
      if (targetOptions.length === 0) {
        console.log('  [warn] layout-comparison no target options available — capture skipped')
      } else {
        const firstTarget = await targetOptions[0].getAttribute('value')
        await targetSelect.selectOption(firstTarget)
        await page.waitForTimeout(800)

        const heatmapPanel = page.locator('[data-testid="analyze-layout-comparison-heatmap-diff"]')
        if (await isAvailable(heatmapPanel)) {
          await captureNamed(page, 'analyze-layout-comparison-heatmap-diff', { element: heatmapPanel })
        } else {
          console.log('  [warn] layout-comparison heatmap panel not visible — capture skipped')
        }

        const fingerPanel = page.locator('[data-testid="analyze-layout-comparison-finger-diff"]')
        if (await isAvailable(fingerPanel)) {
          await captureNamed(page, 'analyze-layout-comparison-finger-diff', { element: fingerPanel })
        } else {
          console.log('  [warn] layout-comparison finger panel not visible — capture skipped')
        }

        const metricPanel = page.locator('[data-testid="analyze-layout-comparison-metric-table"]')
        if (await isAvailable(metricPanel)) {
          await captureNamed(page, 'analyze-layout-comparison-metric', { element: metricPanel })
        } else {
          console.log('  [warn] layout-comparison metric panel not visible — capture skipped')
        }
      }
    } else {
      console.log('  [warn] layout-comparison target select not found — capture skipped')
    }
  } else {
    console.log('  [skip] analyze-tab-layoutComparison not found')
  }

  const layerTab = page.locator('[data-testid="analyze-tab-layer"]')
  if (await isAvailable(layerTab)) {
    await layerTab.click()
    await page.waitForTimeout(800)
    await captureNamed(page, 'analyze-layer-keystrokes', { fullPage: true })

    const viewModeSelect = page.locator('[data-testid="analyze-filter-layer-view-mode"]')
    if (await isAvailable(viewModeSelect)) {
      await viewModeSelect.selectOption('activations')
      await page.waitForTimeout(500)
      await captureNamed(page, 'analyze-layer-activations', { fullPage: true })
    } else {
      console.log('  [warn] view-mode select not found — activations capture skipped')
    }
  } else {
    console.log('  [skip] analyze-tab-layer not found — Layer screenshots skipped')
  }

  // By App: per-application breakdown (App Usage donut + WPM by App).
  // Intentionally ignores the App filter so capturing the full chart
  // does not require seeding a filter selection.
  const byAppTab = page.locator('[data-testid="analyze-tab-byApp"]')
  if (await isAvailable(byAppTab)) {
    await byAppTab.click()
    // The donut animates in over several seconds; capturing too early
    // freezes it mid-unfold (slices clipped to a sliver). 10s gives the
    // recharts animation time to settle into its final geometry.
    await page.waitForTimeout(10_000)
    await captureNamed(page, 'analyze-by-app', { fullPage: true })
  } else {
    console.log('  [skip] analyze-tab-byApp not found')
  }

  // CSV export modal — opened via the Filter Store side panel's
  // "current CSV" button (the panel is the only entry point to the
  // export modal). Re-open the panel, click the export button, capture
  // the category-pick modal as an element shot, then close everything
  // so the run leaves no .csv files behind.
  const filterStoreToggleAgain = page.locator('[data-testid="analyze-filter-store-toggle"]')
  if (await isAvailable(filterStoreToggleAgain)) {
    await filterStoreToggleAgain.click()
    await page.waitForTimeout(400)
    const exportCurrentBtn = page.locator('[data-testid="analyze-filter-store-export-current-csv"]')
    if ((await isAvailable(exportCurrentBtn)) && (await exportCurrentBtn.isEnabled())) {
      await exportCurrentBtn.click()
      await page.waitForTimeout(400)
      const exportModal = page.locator('[data-testid="analyze-export-modal"]')
      if (await isAvailable(exportModal)) {
        await captureNamed(page, 'analyze-export-modal', { element: exportModal })
        await page.keyboard.press('Escape')
        await page.waitForTimeout(300)
      } else {
        console.log('  [warn] analyze-export-modal did not open')
      }
    } else {
      console.log('  [skip] analyze-filter-store-export-current-csv not available')
    }
    await filterStoreToggleAgain.click()
    await page.waitForTimeout(200)
  } else {
    console.log('  [skip] analyze-filter-store-toggle not found for export modal')
  }

  // Return to the Keyboard tab. When Analyze is active the DeviceSelector
  // replaces its entire render with AnalyzePage, so tab-keyboard is not in
  // the DOM — use the Back button instead.
  const backBtn = page.locator('[data-testid="analyze-back"]')
  if (await isAvailable(backBtn)) {
    await backBtn.click()
    await page.waitForTimeout(300)
  }
}
