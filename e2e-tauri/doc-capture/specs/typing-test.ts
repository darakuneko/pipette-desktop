// SPDX-License-Identifier: GPL-2.0-or-later
//
// The Typing Test screenshots of the virtual keyboard: each mode and
// state, the History modal and Keystroke Timeline on seeded runs, Romaji
// and Kana input on a seeded hiragana word list, the Mode modal's tabs on
// recorded Tatoeba and Aozora Bunko datasets, the Record and consent
// modals, the completion screen's timeline, and Weak Spot Training.
//
//   pnpm doc:screenshots --spec e2e-tauri/doc-capture/specs/typing-test.ts

import { VIRTUAL_DEVICE_NAME } from '../../helpers/app'
import { userDataPath } from '../../helpers/driver'
import {
  captureNamed,
  clickThroughUnlock,
  connectToDevice,
  dismissNotificationModal,
  outputDirectory,
  prepareCapture,
  relaunchApp,
  resetToEditorMode,
  virtualDeviceSettingsPath,
  waitForTypingTestCountdown,
  waitForUnlockDialog,
} from '../common'
import { Page } from '../page'
import {
  captureCompletionTimelineScreenshot,
  captureKanaInputScreenshot,
  captureModeModalScreenshots,
  captureRomajiInputScreenshot,
  captureWeakSpotHintScreenshot,
  captureWeakSpotToggleScreenshot,
  expandSettingsPanelIfCollapsed,
  selectMonkeytypePack,
} from '../phases-typing-test'
import {
  backupFile,
  backupRunKeystrokeLog,
  kanaLanguagePackPath,
  respondTypingDatasets,
  seedAccuracyTrendHistory,
  seedKanaLanguagePack,
  seedRunKeystrokeLog,
  type FileBackup,
} from '../typing-test-seed'

const DEVICE_NAME = VIRTUAL_DEVICE_NAME

describe('Typing Test screenshots', () => {
  it('captures the Typing Test modes, modals, inputs and Weak Spot Training', async () => {
    const page = new Page()

    // The virtual keyboard's settings, the seeded files and config.json
    // (the recording consent the capture accepts) as they were before the
    // capture: the Weak Spot Training captures start from them again.
    let settingsBackup: FileBackup = { path: '', content: null }
    let backups: FileBackup[] = []
    await relaunchApp(() => {
      settingsBackup = backupFile(virtualDeviceSettingsPath())
      backups = [
        settingsBackup,
        backupFile(kanaLanguagePackPath()),
        ...backupRunKeystrokeLog(),
        backupFile(userDataPath('config.json')),
      ]
      seedAccuracyTrendHistory(settingsBackup)
      seedKanaLanguagePack()
      seedRunKeystrokeLog()
    })
    await prepareCapture(page)

    console.log(`Looking for ${DEVICE_NAME}...`)
    const connected = await connectToDevice(page, DEVICE_NAME)
    if (!connected) throw new Error(`Device "${DEVICE_NAME}" not found`)
    console.log(`Connected to ${DEVICE_NAME}`)

    await dismissNotificationModal(page)
    // The virtual keyboard is locked on every launch; a view mode restored
    // on connect can bring the Unlock dialog up before anything is clicked.
    await waitForUnlockDialog(page)
    await dismissNotificationModal(page)
    await resetToEditorMode(page)

    console.log('\n--- Typing Test Screenshots ---')

    // resetToEditorMode above guarantees we start from the editor, so enter
    // Typing Test unconditionally.
    const typingTestView = page.locator('[data-testid="typing-test-view"]')
    const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
    await typingTestBtn.waitFor({ state: 'visible', timeout: 10_000 })
    await clickThroughUnlock(page, typingTestBtn)
    await page.waitForTimeout(1000)
    await dismissNotificationModal(page)

    // 1. Words mode — waiting state (explicitly select to avoid persisted config)
    await typingTestView.waitFor({ state: 'visible', timeout: 10_000 })
    // Entering Typing Test starts with a 3s countdown placeholder before the
    // word list renders; wait it out so mode clicks below land on real controls.
    await waitForTypingTestCountdown(page)
    await page.locator('[data-testid="mode-words"]').click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'typing-test-words-waiting')

    // 1b. History modal — opens on the Results tab (default), populated by
    // the seeded runs (3 same-condition `words` runs, the last with a
    // keystroke log) — so the WPM Trend chart, stats row, and table (with
    // its Timeline link column) all have real data.
    await expandSettingsPanelIfCollapsed(page)
    await page.locator('[data-testid="typing-test-history-toggle"]').click()
    await page.locator('[data-testid="history-modal"]').waitFor({ state: 'visible', timeout: 5_000 })
    await page.waitForTimeout(300)
    await captureNamed(page, 'typing-test-history-results')

    // 1c. Keystroke Timeline — opened from the seeded run's row. The seeded
    // log carries `lineBreaks`, so this opens in the per-LINE view.
    const timelineOpenBtn = page.locator('[data-testid^="history-timeline-open-"]').first()
    if (!(await timelineOpenBtn.isVisible().catch(() => false))) {
      throw new Error('history-timeline-open button not found — the seeded run log guarantees this row, so silently skipping the capture would ship a stale/missing doc screenshot')
    }
    await timelineOpenBtn.click()
    await page.locator('[data-testid="word-timeline-modal"]').waitFor({ state: 'visible', timeout: 5_000 })
    await page.waitForTimeout(400)
    await captureNamed(page, 'typing-test-timeline')
    await page.locator('[data-testid="word-timeline-close"]').click()
    await page.waitForTimeout(300)

    // 1d. History modal — Analysis tab (Accuracy Trend / Most missed /
    // Error mix), same seeded data as the Results tab above.
    await page.locator('[data-testid="history-view-tab-analysis"]').click()
    await page.waitForTimeout(300)
    await captureNamed(page, 'typing-test-history-analysis')

    await page.locator('[data-testid="history-modal-close"]').click()
    await page.waitForTimeout(300)

    // 2. Time mode
    await page.locator('[data-testid="mode-time"]').click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'typing-test-time-mode')

    // 3. Quote mode
    await page.locator('[data-testid="mode-quote"]').click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'typing-test-quote-mode')

    // 4. Words mode with options (punctuation + numbers enabled)
    await page.locator('[data-testid="mode-words"]').click()
    await page.waitForTimeout(300)
    await page.locator('[data-testid="toggle-punctuation"]').click()
    await page.waitForTimeout(200)
    await page.locator('[data-testid="toggle-numbers"]').click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'typing-test-words-options')

    // Reset options back
    await page.locator('[data-testid="toggle-punctuation"]').click()
    await page.locator('[data-testid="toggle-numbers"]').click()
    await page.waitForTimeout(300)

    // 5. Running state — type a few characters to start the test
    // Focus is managed by the component via hidden textarea
    await page.keyboard.type('the ', { delay: 80 })
    await page.waitForTimeout(500)
    await captureNamed(page, 'typing-test-running')

    // 5b. Romaji input — hiragana pack, Romaji toggle on, mid-word guide line
    console.log('\n--- Typing Test Romaji Input ---')
    await captureRomajiInputScreenshot(page)

    // Reset back to english/words so the language switch also drops the
    // run's romajiInput flag (see clearRomajiInputForLanguage) before
    // the Mode Modal captures below reuse the same language selector.
    await page.locator('[data-testid="language-selector"]:not([disabled])').click()
    await page.waitForTimeout(400)
    await selectMonkeytypePack(page, 'english')

    // 5c. Kana input — hiragana pack, Kana method, physical-key stroke guide
    console.log('\n--- Typing Test Kana Input ---')
    await captureKanaInputScreenshot(page)

    // 6. Mode modal — MonkeyType / Tatoeba / Aozora Bunko / File Import tabs
    console.log('\n--- Typing Test Mode Modal ---')
    await respondTypingDatasets()
    await captureModeModalScreenshots(page)

    // 7. Footer Record modal + Recording Consent modal (REC lives in the
    // keymap-editor footer, so this does not need to enter Typing View).
    console.log('\n--- Typing Record Modal ---')

    // Exit typing test back to the editor so the footer (hidden in
    // Typing Test / Typing View) is visible again.
    if (await typingTestBtn.isVisible().catch(() => false)) {
      await typingTestBtn.click()
      await page.waitForTimeout(500)
    }

    let consentAccepted = false
    const recordBtn = page.locator('[data-testid="typing-record-button"]')
    if (await recordBtn.isVisible().catch(() => false)) {
      await recordBtn.click()
      await page.waitForTimeout(400)
      await captureNamed(page, 'typing-test-rec-tab')

      // Toggle Start to surface the consent modal. Accept it (real Enable
      // click, not Cancel) — the completion-timeline capture below (step 8)
      // needs recording consent genuinely accepted so an ordinary Typing
      // Test run saves a keystroke log. Accepting also flips Record on
      // (see TypingRecordModal.handleConsentAccept), so it's toggled back
      // off right after, leaving consent accepted but Record itself off.
      const recordToggle = page.locator('[data-testid="typing-record-toggle"]')
      if (await recordToggle.isVisible().catch(() => false)) {
        await recordToggle.click()
        const consentModal = page.locator('[data-testid="typing-consent-modal"]')
        if (await consentModal.isVisible().catch(() => false)) {
          await captureNamed(page, 'typing-test-rec-consent', { element: consentModal })

          const acceptBtn = page.locator('[data-testid="typing-consent-accept"]')
          if (await acceptBtn.isVisible().catch(() => false)) {
            await acceptBtn.click()
            await page.waitForTimeout(300)
            consentAccepted = true
            // Consent-accept also turned Record on — toggle it back off.
            if (await recordToggle.isVisible().catch(() => false)) {
              await recordToggle.click()
              await page.waitForTimeout(200)
            }
          }
        } else {
          console.log('  [info] typing-consent-modal did not appear (consent already accepted)')
          consentAccepted = true
        }
      } else {
        console.log('  [warn] typing-record-toggle not found')
      }

      const closeBtn = page.locator('[data-testid="typing-record-close"]')
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click()
        await page.waitForTimeout(200)
      }
    } else {
      console.log('  [skip] typing-record-button not found — Record modal capture skipped')
    }

    // 8. Completion screen — inline Keystroke Timeline, once a run finishes
    // with a saved keystroke log (requires the consent accepted just above).
    console.log('\n--- Typing Test Completion Timeline ---')
    if (consentAccepted) {
      await clickThroughUnlock(page, typingTestBtn)
      await page.waitForTimeout(1000)
      await dismissNotificationModal(page)
      await typingTestView.waitFor({ state: 'visible', timeout: 10_000 })
      await waitForTypingTestCountdown(page)
      await captureCompletionTimelineScreenshot(page)
    } else {
      console.log('  [skip] recording consent was not accepted — completion-timeline capture skipped')
    }

    // Weak Spot Training — each capture starts the app again with its own
    // History, from the files as they were before the capture.
    console.log('\n--- Weak Spot Training Screenshots ---')
    await captureWeakSpotToggleScreenshot(page, settingsBackup, backups)
    await captureWeakSpotHintScreenshot(page, settingsBackup, backups)

    console.log(`\nScreenshots saved to: ${outputDirectory()}`)
  })
})
