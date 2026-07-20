// SPDX-License-Identifier: GPL-2.0-or-later

// Screenshot capture script for Pipette operation guide documentation.
// Usage: pnpm build && pnpm doc:screenshots
import type { ElectronApplication, Page, Locator } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, readdirSync, renameSync, rmdirSync, statSync, copyFileSync, constants as fsConstants } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  backupVirtualDeviceSettings,
  clickThroughUnlock,
  connectToDevice,
  dismissNotificationModal,
  escapeRegex,
  isAvailable,
  launchCaptureApp,
  nullifyLastDeviceConfig,
  resetToEditorMode,
  resetVirtualDeviceKeyboardLayout,
  restoreLastDeviceConfig,
  restoreVirtualDeviceSettings,
  selectKeyboardViaFilterModal,
  selectSnapshotViaFilterModal,
  VIRTUAL_DEVICE_DISPLAY_NAME,
  VIRTUAL_DEVICE_UID,
  waitForTypingTestCountdown,
  waitForUnlockDialog,
} from './doc-capture-common'
import {
  DUMMY_SNAPSHOTS,
  DUMMY_TA_UID,
  seedDummySnapshots,
  restoreSnapshots,
  seedDummyTypingAnalytics,
  restoreTypingAnalytics,
  seedDummyFilterStore,
  restoreFilterStore,
} from './analyze-seed'

const PROJECT_ROOT = resolve(import.meta.dirname, '../..')
const SCREENSHOT_DIR = resolve(PROJECT_ROOT, 'docs/screenshots')
const DEVICE_NAME = VIRTUAL_DEVICE_DISPLAY_NAME

// Click a tree-nav branch button only when it reports aria-expanded=false, so
// repeat runs don't collapse an already-expanded branch via the toggle handler.
// When already expanded, skip the click and the settle delay.
async function expandBranchIfCollapsed(branch: Locator, settleMs = 300): Promise<void> {
  if ((await branch.getAttribute('aria-expanded')) === 'true') return
  await branch.click()
  await branch.page().waitForTimeout(settleMs)
}

// Restore the Editor view after a prior run left the device in Typing Test mode.
// useDevicePrefs persists `viewMode` per keyboard; since `~/.config/Electron`
// is not isolated between capture runs, this guard avoids landing in a state
// where TabbedKeycodes is not rendered (KeymapEditor hides it under
// `typingTestMode`). Uses the locale-stable `data-active` attribute instead of
// the i18n-dependent aria-label text.
async function ensureEditorMode(page: Page): Promise<void> {
  const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
  if (!(await isAvailable(typingTestBtn))) return
  if ((await typingTestBtn.getAttribute('data-active')) !== 'true') return
  console.log('  [reset] Exiting Typing Test mode from prior run')
  await typingTestBtn.click()
  await page.waitForTimeout(500)
}

// Uses fixed filenames that match OPERATION-GUIDE.md references.
// A global counter tracks sequential numbering.
let screenshotCounter = 0

async function takeScreenshot(
  page: Page,
  filename: string,
  label: string,
  opts?: { element?: Locator; fullPage?: boolean },
): Promise<void> {
  const path = resolve(SCREENSHOT_DIR, filename)
  if (opts?.element) {
    await opts.element.screenshot({ path })
  } else {
    await page.screenshot({ path, fullPage: opts?.fullPage ?? false })
  }
  console.log(`  [${label}] ${filename}`)
}

async function capture(
  page: Page,
  name: string,
  opts?: { element?: Locator; fullPage?: boolean },
): Promise<void> {
  screenshotCounter++
  const num = String(screenshotCounter).padStart(2, '0')
  await takeScreenshot(page, `${num}-${name}.png`, num, opts)
}

async function captureNamed(
  page: Page,
  name: string,
  opts?: { element?: Locator; fullPage?: boolean },
): Promise<void> {
  await takeScreenshot(page, `${name}.png`, '--', opts)
}

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

async function ensureOverlayOpen(page: Page): Promise<boolean> {
  const toggle = page.locator('button[aria-controls="keycodes-overlay-panel"]')
  if (!(await isAvailable(toggle))) return false

  const isExpanded = await toggle.getAttribute('aria-expanded')
  if (isExpanded !== 'true') {
    await toggle.click()
    await page.waitForTimeout(500)
  }
  return true
}

async function closeOverlay(page: Page): Promise<void> {
  const toggle = page.locator('button[aria-controls="keycodes-overlay-panel"]')
  if (await isAvailable(toggle)) {
    const isExpanded = await toggle.getAttribute('aria-expanded')
    if (isExpanded === 'true') {
      await toggle.click()
      await page.waitForTimeout(300)
    }
  }
}

async function switchOverlayTab(page: Page, tabTestId: string): Promise<boolean> {
  const tab = page.locator(`[data-testid="${tabTestId}"]`)
  if (!(await isAvailable(tab))) {
    console.log(`  [skip] ${tabTestId} not found`)
    return false
  }
  await tab.click()
  await page.waitForTimeout(300)
  return true
}

async function connectDevice(app: ElectronApplication, page: Page): Promise<boolean> {
  if (!(await connectToDevice(page, DEVICE_NAME, { raceNoDeviceMessage: true }))) {
    return false
  }
  console.log(`Connected to ${DEVICE_NAME}`)

  // Per-keyboard view-mode auto-restore may reopen Typing View or Typing
  // Test left behind by a prior helper run (doc-capture-typing-test.ts ends
  // in Typing View). The virtual device resets to *locked* on every launch,
  // so that persisted viewMode can also surface the Unlock dialog before the
  // auto-restore can complete — clear it first, then reset back to the
  // keymap editor so every phase starts from the same state.
  await waitForUnlockDialog(app, page)
  await resetToEditorMode(page)
  return true
}

// --- Phase 1: Device Selection ---

async function captureDeviceSelection(page: Page): Promise<void> {
  console.log('\n--- Phase 1: Device Selection ---')
  await capture(page, 'device-selection', { fullPage: true })

  // File tab
  const fileTab = page.locator('[data-testid="tab-file"]')
  if (await isAvailable(fileTab)) {
    await fileTab.click()
    // Wait for keyboard list to load (async IPC fetch)
    const kbList = page.locator('[data-testid="pipette-keyboard-list"]')
    try {
      await kbList.waitFor({ state: 'visible', timeout: 5000 })
    } catch {
      console.log('  [warn] File tab keyboard list did not appear')
    }
    await page.waitForTimeout(500)
    await captureNamed(page, 'file-tab', { fullPage: true })
    // Switch back to keyboard tab
    const kbTab = page.locator('[data-testid="tab-keyboard"]')
    if (await isAvailable(kbTab)) {
      await kbTab.click()
      await page.waitForTimeout(300)
    }
  }
}

// --- Phase 1.5: Data Modal (from device selector) ---

const DUMMY_FAVORITES: Record<string, { type: string; entries: { id: string; label: string; filename: string; savedAt: string; updatedAt?: string }[] }> = {
  tapDance: {
    type: 'tapDance',
    entries: [
      { id: 'doc-td-1', label: 'Ctrl/Esc', filename: 'doc-td-1.json', savedAt: '2026-02-20T10:00:00.000Z', updatedAt: '2026-02-25T12:30:00.000Z' },
      { id: 'doc-td-2', label: 'Shift/CapsWord', filename: 'doc-td-2.json', savedAt: '2026-02-21T08:15:00.000Z', updatedAt: '2026-02-24T09:00:00.000Z' },
      { id: 'doc-td-3', label: 'Layer Toggle', filename: 'doc-td-3.json', savedAt: '2026-02-22T14:30:00.000Z' },
    ],
  },
  macro: {
    type: 'macro',
    entries: [
      { id: 'doc-mc-1', label: 'Email Signature', filename: 'doc-mc-1.json', savedAt: '2026-02-19T09:00:00.000Z', updatedAt: '2026-02-25T10:00:00.000Z' },
      { id: 'doc-mc-2', label: 'Git Commit', filename: 'doc-mc-2.json', savedAt: '2026-02-22T16:00:00.000Z' },
    ],
  },
  // Seeded empty so favorites saved locally on the capture machine cannot
  // leak into the combo / key-override / alt-repeat detail screenshots.
  combo: { type: 'combo', entries: [] },
  keyOverride: { type: 'keyOverride', entries: [] },
  altRepeatKey: { type: 'altRepeatKey', entries: [] },
}

// Playwright's electron.launch() uses a different userData path than the installed app.
// We resolve it dynamically via app.evaluate() before seeding.

function seedDummyFavorites(favBase: string): Map<string, string | null> {
  const backups = new Map<string, string | null>()
  for (const [type, index] of Object.entries(DUMMY_FAVORITES)) {
    const dir = join(favBase, type)
    mkdirSync(dir, { recursive: true })
    const indexPath = join(dir, 'index.json')
    backups.set(indexPath, existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null)
    writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
    for (const entry of index.entries) {
      const fp = join(dir, entry.filename)
      if (!existsSync(fp)) writeFileSync(fp, '{}', 'utf-8')
    }
  }
  return backups
}

function restoreFavorites(backups: Map<string, string | null>, favBase: string): void {
  for (const [indexPath, original] of backups) {
    if (original != null) {
      writeFileSync(indexPath, original, 'utf-8')
    } else {
      try { unlinkSync(indexPath) } catch { /* ignore */ }
    }
  }
  for (const index of Object.values(DUMMY_FAVORITES)) {
    const dir = join(favBase, index.type)
    for (const entry of index.entries) {
      const fp = join(dir, entry.filename)
      try { unlinkSync(fp) } catch { /* ignore */ }
    }
  }
}

// --- Key Label "apply to keymap" seed (Phase 8b) ---

const DOC_CAPTURE_COLEMAK_ID = 'doc-capture-colemak'
const DOC_CAPTURE_COLEMAK_NAME = 'Colemak (doc-capture)'
const DOC_CAPTURE_COLEMAK_FILENAME = `${DOC_CAPTURE_COLEMAK_ID}.json`
// Real Colemak permutation (same fixture used in shared/keymap/__tests__/keymap-apply.test.ts)
// so buildKeymapRewriteTable actually succeeds and the confirm modal opens.
const DOC_CAPTURE_COLEMAK_MAP: Record<string, string> = {
  KC_E: 'F', KC_R: 'P', KC_T: 'G', KC_Y: 'J', KC_U: 'L', KC_I: 'U', KC_O: 'Y',
  KC_P: ';', KC_S: 'R', KC_D: 'S', KC_F: 'T', KC_G: 'D', KC_J: 'N', KC_K: 'E',
  KC_L: 'I', KC_SCOLON: 'O', KC_N: 'K',
}

interface KeyLabelSeedBackup {
  indexPath: string
  originalIndex: string | null
  entryPath: string
  entryExisted: boolean
}

// Seeds a `keymapApplicable: true` Colemak entry into `sync/key-labels/` so
// captureKeyLabelKeymapApply can drive the footer's confirm modal without a
// real Hub download. Backs up index.json and replaces it wholesale (same
// idiom as seedDummyFavorites) rather than merging into whatever real
// entries the machine already has installed — the running app lazily adds
// the built-in QWERTY row itself on first list, so seeding does not need to
// reproduce that, and a real user's other installed labels never leak into
// the screenshot.
function seedDummyKeyLabel(keyLabelsBase: string): KeyLabelSeedBackup {
  mkdirSync(keyLabelsBase, { recursive: true })
  const indexPath = join(keyLabelsBase, 'index.json')
  const originalIndex = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null

  const now = new Date().toISOString()
  const entries = [{
    id: DOC_CAPTURE_COLEMAK_ID,
    name: DOC_CAPTURE_COLEMAK_NAME,
    uploaderName: 'pipette',
    filename: DOC_CAPTURE_COLEMAK_FILENAME,
    savedAt: now,
    updatedAt: now,
  }]
  writeFileSync(indexPath, JSON.stringify({ entries }, null, 2), 'utf-8')

  const entryPath = join(keyLabelsBase, DOC_CAPTURE_COLEMAK_FILENAME)
  const entryExisted = existsSync(entryPath)
  if (!entryExisted) {
    writeFileSync(
      entryPath,
      JSON.stringify({ name: DOC_CAPTURE_COLEMAK_NAME, map: DOC_CAPTURE_COLEMAK_MAP, keymapApplicable: true }, null, 2),
      'utf-8',
    )
  }
  return { indexPath, originalIndex, entryPath, entryExisted }
}

function restoreDummyKeyLabel(backup: KeyLabelSeedBackup): void {
  if (backup.originalIndex != null) {
    writeFileSync(backup.indexPath, backup.originalIndex, 'utf-8')
  } else {
    try { unlinkSync(backup.indexPath) } catch { /* ignore */ }
  }
  if (!backup.entryExisted) {
    try { unlinkSync(backup.entryPath) } catch { /* ignore */ }
  }
}

// --- Foreign keyboard-dir isolation (File tab reproducibility) ---

interface ForeignKeyboardIsolation {
  backupBase: string
  moves: Array<{ from: string; to: string }>
}

// Any sync/keyboards/{uid} directory this capture session does not own is
// leftover local user data (e.g. saves from a real keyboard once plugged into
// the workstation). The File tab lists every keyboard with saved files that
// is not currently connected, so such dirs would leak machine-specific
// entries into file-tab.png. Move them aside for the session; moved back in
// the cleanup path (also on failure — it runs in main()'s finally).
function isolateForeignKeyboardDirs(userDataPath: string): ForeignKeyboardIsolation {
  const kbBase = join(userDataPath, 'sync', 'keyboards')
  const backupBase = join(userDataPath, `doc-capture-kb-backup-${process.pid}`)
  const isolation: ForeignKeyboardIsolation = { backupBase, moves: [] }
  if (!existsSync(kbBase)) return isolation

  const allowed = new Set<string>([
    ...DUMMY_SNAPSHOTS.map((kb) => kb.uid),
    DUMMY_TA_UID,
    VIRTUAL_DEVICE_UID,
  ])
  for (const name of readdirSync(kbBase)) {
    if (allowed.has(name)) continue
    const from = join(kbBase, name)
    if (!statSync(from).isDirectory()) continue
    mkdirSync(backupBase, { recursive: true })
    const to = join(backupBase, name)
    renameSync(from, to)
    isolation.moves.push({ from, to })
  }
  if (isolation.moves.length > 0) {
    console.log(`Isolated ${isolation.moves.length} foreign keyboard dir(s): ${isolation.moves.map((m) => m.from.split('/').pop()).join(', ')}`)
  }
  return isolation
}

// Move the contents of `src` (a backup dir) into `dest` (the restored
// original location), merging entry-by-entry when `dest` already exists.
// This happens when cloud sync recreated `sync/keyboards/{uid}/` mid-run and
// wrote a fresh file into it — a plain directory-level renameSync would then
// fail with ENOTEMPTY and strand the whole backup.
//
// - `dest` absent → fast-path rename the whole tree.
// - `dest` present → for each entry in `src`: move it in if `dest` has no
//   same-named entry; if both are directories, recurse one level so nested
//   partial conflicts (e.g. `snapshots/`, `devices/`) get the same
//   per-entry treatment; otherwise leave the entry in `src` (sync's copy is
//   newer) and log the leftover path prominently so the user can reconcile.
// `src` is removed only once fully emptied; a non-empty leftover is logged
// so it is never silently stranded.
function mergeDirInto(src: string, dest: string): void {
  // Fast-path rename when `dest` is absent. The existsSync check is not a
  // clobber guard — it only picks the cheap path. If `dest` races into
  // existence between the check and the rename, renameSync on a *directory*
  // fails safely rather than overwriting data: POSIX rename() over an
  // existing non-empty dir → ENOTEMPTY, over a file → ENOTDIR; only an
  // existing *empty* dir is replaced, which loses nothing. On such a
  // failure we fall through to the per-entry merge.
  if (!existsSync(dest)) {
    try {
      renameSync(src, dest)
      return
    } catch (err) {
      if (!existsSync(dest)) {
        console.error(`  [restore] failed to move ${src} to ${dest}:`, err)
        return
      }
      // dest appeared concurrently — merge entry by entry below.
    }
  }

  let entries: string[]
  try {
    entries = readdirSync(src)
  } catch (err) {
    console.error(`  [restore] failed to read backup dir ${src}:`, err)
    return
  }

  for (const name of entries) {
    const srcEntry = join(src, name)
    const destEntry = join(dest, name)

    if (statSync(srcEntry).isDirectory()) {
      if (existsSync(destEntry) && !statSync(destEntry).isDirectory()) {
        console.error(
          `  [restore][conflict] ${destEntry} already exists as a file (written during this run) — kept it; your prior directory is preserved at ${srcEntry}, reconcile manually`,
        )
        continue
      }
      // Recurse: mergeDirInto's own fast path covers the absent-dest rename,
      // and its directory renameSync cannot silently clobber (see above).
      mergeDirInto(srcEntry, destEntry)
      try {
        if (readdirSync(srcEntry).length === 0) rmdirSync(srcEntry)
      } catch { /* moved wholesale, or still holds unresolved conflicts */ }
    } else {
      // File entry: atomic no-clobber move. COPYFILE_EXCL makes the copy
      // fail with EEXIST instead of overwriting, closing the TOCTOU window
      // an existsSync-then-rename would leave open (rename() silently
      // replaces an existing destination file, so a sync/app write landing
      // between check and move would be lost). The backup copy is only
      // unlinked after the copy succeeded.
      try {
        copyFileSync(srcEntry, destEntry, fsConstants.COPYFILE_EXCL)
        unlinkSync(srcEntry)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          console.error(
            `  [restore][conflict] ${destEntry} already exists (written during this run) — kept the newer destination copy; your prior data is preserved at ${srcEntry}, reconcile manually`,
          )
        } else {
          console.error(`  [restore] failed to move ${srcEntry} to ${destEntry}:`, err)
        }
      }
    }
  }

  let remaining: string[] = []
  try {
    remaining = readdirSync(src)
  } catch { /* already gone */ }
  if (remaining.length === 0) {
    try { rmdirSync(src) } catch { /* ignore */ }
  } else {
    console.error(`  [restore] ${remaining.length} unresolved conflict(s) left at ${src} — reconcile manually`)
  }
}

function restoreForeignKeyboardDirs(isolation: ForeignKeyboardIsolation): void {
  for (const { from, to } of isolation.moves) {
    try {
      mergeDirInto(to, from)
    } catch (err) {
      console.error(`  [restore] failed to merge ${to} back into ${from}:`, err)
    }
  }
  try { rmdirSync(isolation.backupBase) } catch { /* absent or non-empty (failed restore) — keep it */ }
}

async function captureDataModal(page: Page): Promise<void> {
  console.log('\n--- Phase 1.5: Data Modal (Tree Sidebar) ---')

  const dataBtn = page.locator('[data-testid="data-button"]')
  if (!(await isAvailable(dataBtn))) {
    console.log('  [skip] data-button not found')
    return
  }

  await dataBtn.click()
  await page.waitForTimeout(1000)

  const backdrop = page.locator('[data-testid="data-modal-backdrop"]')
  try {
    await backdrop.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] Data modal did not open')
    return
  }

  // Expand Local branch and navigate to Favorites > Tap Dance
  const navLocal = page.locator('[data-testid="nav-local"]')
  if (await isAvailable(navLocal)) {
    await expandBranchIfCollapsed(navLocal)

    const navFavorites = page.locator('[data-testid="nav-local-favorites"]')
    if (await isAvailable(navFavorites)) {
      await expandBranchIfCollapsed(navFavorites)

      const navTd = page.locator('[data-testid="nav-fav-tapDance"]')
      if (await isAvailable(navTd)) {
        await navTd.click()
        await page.waitForTimeout(500)
      }
    }
  }
  await captureNamed(page, 'data-sidebar-favorites', { fullPage: true })

  // Navigate to Keyboards (first keyboard if available)
  const navKeyboards = page.locator('[data-testid="nav-local-keyboards"]')
  if (await isAvailable(navKeyboards)) {
    await expandBranchIfCollapsed(navKeyboards)

    // Click first keyboard leaf if available
    const kbLeaf = page.locator('[data-testid^="nav-kb-"]').first()
    if (await isAvailable(kbLeaf)) {
      await kbLeaf.click()
      await page.waitForTimeout(500)
      await captureNamed(page, 'data-sidebar-keyboard-saves', { fullPage: true })
    }
  }

  // Navigate to Application
  const navApp = page.locator('[data-testid="nav-local-application"]')
  if (await isAvailable(navApp)) {
    await navApp.click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'data-sidebar-application', { fullPage: true })
  }

  // Navigate to Sync (Cloud Sync configured → remote-only keyboards listed by name;
  // otherwise an empty-state message appears, still a valid documentation state).
  // useDataNavTree caches expansion across modal opens, so branch clicks are guarded
  // by aria-expanded to avoid collapsing an already-open branch on repeat runs.
  const navSync = page.locator('[data-testid="nav-sync"]')
  if (await isAvailable(navSync)) {
    await expandBranchIfCollapsed(navSync, 500)

    const navSyncKeyboards = page.locator('[data-testid="nav-sync-keyboards"]')
    if (await isAvailable(navSyncKeyboards)) {
      await expandBranchIfCollapsed(navSyncKeyboards)
    }
    await captureNamed(page, 'data-sidebar-sync', { fullPage: true })
  }

  // Navigate to Hub (if available)
  const navHub = page.locator('[data-testid="nav-cloud-hub"]')
  if (await isAvailable(navHub)) {
    await expandBranchIfCollapsed(navHub)

    const hubKbs = page.locator('[data-testid="nav-hub-keyboards"]')
    if (await isAvailable(hubKbs)) {
      await expandBranchIfCollapsed(hubKbs)
    }
    await captureNamed(page, 'data-sidebar-hub', { fullPage: true })
  }

  await page.locator('[data-testid="data-modal-close"]').click()
  await page.waitForTimeout(300)
}

// --- Phase 1.7: Settings Modal (from device selector, named screenshots) ---

async function captureSettingsModal(page: Page): Promise<void> {
  console.log('\n--- Phase 1.7: Settings Modal ---')

  const settingsBtn = page.locator('[data-testid="settings-button"]')
  if (!(await isAvailable(settingsBtn))) {
    console.log('  [skip] settings-button not found')
    return
  }

  await settingsBtn.click()
  await page.waitForTimeout(500)

  const settingsModal = page.locator('[data-testid="settings-modal"]')
  if (!(await isAvailable(settingsModal))) {
    console.log('  [skip] settings-modal not found')
    return
  }

  // Switch to Tools tab to capture defaults section
  const toolsTab = page.locator('[data-testid="settings-tab-tools"]')
  if (await isAvailable(toolsTab)) {
    await toolsTab.click()
    await page.waitForTimeout(300)

    // Scroll down to show defaults section
    const defaultsSection = page.locator('[data-testid="settings-default-layout-row"]')
    if (await isAvailable(defaultsSection)) {
      await defaultsSection.scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
    }
    await captureNamed(page, 'settings-defaults', { fullPage: true })

    const zoomRow = page.locator('[data-testid="settings-zoom-factor-row"]')
    if (await isAvailable(zoomRow)) {
      await zoomRow.scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await captureNamed(page, 'settings-zoom', { fullPage: true })
    } else {
      console.log('  [skip] zoom factor row not found')
    }
  } else {
    console.log('  [skip] tools tab not found')
  }

  // Close settings modal
  const closeBtn = page.locator('[data-testid="settings-close"]')
  if (await isAvailable(closeBtn)) {
    await closeBtn.click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 1.8: Analyze Page (from device selector, Analyze tab) ---

// Captures the Analyze page from the device-selection screen. Real typing data
// is required for the charts to render; when no data exists on this machine,
// the sidebar is empty and we fall back to capturing only the overview so the
// guide still has a reference image. The per-tab sub-screenshots (Heatmap,
// WPM, Interval, Activity, Ergonomics, Layer) are skipped in that case.
async function captureAnalyzePage(page: Page): Promise<void> {
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
  // must land on the seeded dummy keyboard (DUMMY_TA_UID) specifically —
  // picking "whichever sorts first" can silently select a real, thin
  // "GPK60-63R" dataset instead of the seeded "GPK60-63R (docs)" one,
  // since the list is alphabetical and the plain name sorts first.
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

  // App filter popover — the multi-select now lives in the staged filter
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

  // The standalone snapshot-timeline capture was removed with the inline
  // quick-selector: the snapshot pick now lives in the filter modal's
  // Keymap row and `analyze-snapshot-timeline.png` was never referenced
  // by the operation guides.

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
      await captureNamed(page, 'analyze-interval-distribution', { fullPage: true })
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

// --- Phase 2: Keymap Editor Overview ---

async function captureKeymapEditor(page: Page): Promise<void> {
  console.log('\n--- Phase 2: Keymap Editor ---')
  await capture(page, 'keymap-editor-overview', { fullPage: true })
}

// --- Phase 3: Layer Navigation ---

async function captureLayerNavigation(page: Page): Promise<void> {
  console.log('\n--- Phase 3: Layer Navigation ---')

  await capture(page, 'layer-0', { fullPage: true })

  for (const layerNum of [1, 2]) {
    const btn = page.locator(`[data-testid="layer-panel-layer-num-${layerNum}"]`)
    if (await isAvailable(btn)) {
      await btn.click()
      await page.waitForTimeout(1000)
      await capture(page, `layer-${layerNum}`, { fullPage: true })
    }
  }

  const layer0Btn = page.locator('[data-testid="layer-panel-layer-num-0"]')
  if (await isAvailable(layer0Btn)) {
    await layer0Btn.click()
    await page.waitForTimeout(500)
  }
}

// --- Phase 4: Keycode Category Tabs ---

const KEYCODE_TABS = [
  { id: 'basic', label: 'Basic' },
  { id: 'layers', label: 'Layers' },
  { id: 'modifiers', label: 'Modifiers' },
  { id: 'system', label: 'System' },
  { id: 'midi', label: 'MIDI' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'tapDance', label: 'Tap-Hold / Tap Dance' },
  { id: 'macro', label: 'Macro' },
  { id: 'combo', label: 'Combo' },
  { id: 'keyOverride', label: 'Key Override' },
  { id: 'altRepeatKey', label: 'Alt Repeat Key' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'user', label: 'User' },
]

async function captureKeycodeCategories(page: Page): Promise<void> {
  console.log('\n--- Phase 4: Keycode Categories ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  for (const tab of KEYCODE_TABS) {
    const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(tab.label)}$`) })
    if (!(await isAvailable(tabBtn))) {
      console.log(`  [skip] Tab "${tab.label}" not found`)
      continue
    }
    await tabBtn.first().click()
    await page.waitForTimeout(300)
    await captureNamed(page, `tab-${tab.id}`, { fullPage: true })
  }

  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 4.5: Keyboard Tab (Device Picker) ---

async function captureKeyboardTab(page: Page): Promise<void> {
  console.log('\n--- Phase 4.5: Keyboard Tab (Device Picker) ---')

  const editorContent = page.locator('[data-testid="editor-content"]')
  const keyboardTabBtn = editorContent.locator('button', { hasText: /^Keyboard$/ })
  if (!(await isAvailable(keyboardTabBtn))) {
    console.log('  [skip] Keyboard tab not found')
    return
  }
  await keyboardTabBtn.first().click()
  await page.waitForTimeout(500)

  // Capture device list view
  await captureNamed(page, 'keyboard-tab-device-list', { fullPage: true })

  // Click the connected device to show its keymap. The tile's text is
  // "{productName}›" (name span + chevron span), so an anchored regex on the
  // whole button would never match — anchor the exact name against the inner
  // `.font-medium` name span instead, mirroring connectToDevice's structure,
  // so a device whose name merely contains DEVICE_NAME can't match.
  const deviceBtn = editorContent
    .locator('button')
    .filter({ has: page.locator('.font-medium', { hasText: new RegExp(`^${escapeRegex(DEVICE_NAME)}$`) }) })
  if (await isAvailable(deviceBtn)) {
    await deviceBtn.first().click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'keyboard-tab-keymap', { fullPage: true })
  }

  // Switch back to Basic tab
  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 5: Toolbar / Sidebar ---

async function captureSidebarTools(app: ElectronApplication, page: Page): Promise<void> {
  console.log('\n--- Phase 5: Toolbar ---')

  await captureNamed(page, 'toolbar', { fullPage: true })

  const zoomInBtn = page.locator('[data-testid="zoom-in-button"]')
  if (await isAvailable(zoomInBtn)) {
    await zoomInBtn.click()
    await zoomInBtn.click()
    await page.waitForTimeout(300)
    await captureNamed(page, 'zoom-in', { fullPage: true })
    const zoomOutBtn = page.locator('[data-testid="zoom-out-button"]')
    if (await isAvailable(zoomOutBtn)) {
      await zoomOutBtn.click()
      await zoomOutBtn.click()
    }
    await page.waitForTimeout(300)
  } else {
    console.log('  [skip] zoom-in-button not found')
  }

  const typingTestBtn = page.locator('[data-testid="typing-test-button"]')
  if (await isAvailable(typingTestBtn)) {
    await clickThroughUnlock(app, page, typingTestBtn)
    await waitForTypingTestCountdown(page)
    await page.waitForTimeout(500)
    await captureNamed(page, 'typing-test', { fullPage: true })
    await dismissNotificationModal(page)
    // Forcefully remove all fixed overlay/modal elements that block interaction
    await page.evaluate(() => {
      document.querySelectorAll('.fixed.inset-0').forEach((el) => el.remove())
    })
    await page.waitForTimeout(500)
    await typingTestBtn.click({ timeout: 5000 }).catch(() => {
      console.log('  [warn] Could not toggle typing test off')
    })
    await page.waitForTimeout(500)
    // Final cleanup: remove any remaining overlays
    await page.evaluate(() => {
      document.querySelectorAll('.fixed.inset-0').forEach((el) => el.remove())
    })
    await page.waitForTimeout(300)
  } else {
    console.log('  [skip] typing-test-button not found')
  }
}

// --- Phase 6: Modal Editors ---

// Tile-based editor captures (Combo, Key Override, Alt Repeat Key)
// Tab view: inline tile grid on the dedicated tab (no modal)
// Detail: clicking a tile opens the detail editor modal directly (no back button or internal tile grid)
interface TileEditorCapture {
  name: string
  keycodeTab: string
  tileTestId: string
  backdropTestId: string
  modalCloseTestId: string
}

const TILE_EDITOR_CAPTURES: TileEditorCapture[] = [
  {
    name: 'combo',
    keycodeTab: 'Combo',
    tileTestId: 'combo-tile-0',
    backdropTestId: 'combo-modal-backdrop',
    modalCloseTestId: 'combo-modal-close',
  },
  {
    name: 'key-override',
    keycodeTab: 'Key Override',
    tileTestId: 'ko-tile-0',
    backdropTestId: 'ko-modal-backdrop',
    modalCloseTestId: 'ko-modal-close',
  },
  {
    name: 'alt-repeat-key',
    keycodeTab: 'Alt Repeat Key',
    tileTestId: 'arep-tile-0',
    backdropTestId: 'ar-modal-backdrop',
    modalCloseTestId: 'ar-modal-close',
  },
]

async function openEditorModal(
  page: Page,
  keycodeTab: string,
  settingsTestId: string,
  backdropTestId: string,
): Promise<boolean> {
  // Dismiss any lingering modals/overlays before interacting with tabs
  await dismissNotificationModal(page)
  await page.evaluate(() => {
    document.querySelectorAll('.fixed.inset-0').forEach((el) => el.remove())
  })
  await page.waitForTimeout(300)

  const editorContent = page.locator('[data-testid="editor-content"]')
  const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(keycodeTab)}$`) })
  if (!(await isAvailable(tabBtn))) return false
  await tabBtn.first().click()
  await page.waitForTimeout(300)

  const settingsBtn = page.locator(`[data-testid="${settingsTestId}"]`)
  if (!(await isAvailable(settingsBtn))) return false
  await settingsBtn.click()

  try {
    await page.locator(`[data-testid="${backdropTestId}"]`).waitFor({ state: 'visible', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

async function captureModalEditors(page: Page): Promise<void> {
  console.log('\n--- Phase 6: Modal Editors ---')

  // Lighting modal: still uses settings button
  const lightingBackdropTestId = 'lighting-modal-backdrop'
  if (await openEditorModal(page, 'Lighting', 'lighting-settings-btn', lightingBackdropTestId)) {
    await captureNamed(page, 'lighting-modal', { fullPage: true })
    await page.locator('[data-testid="lighting-modal-close"]').click()
    await page.waitForTimeout(300)
  } else {
    console.log('  [skip] lighting modal not available')
  }

  // Tile-based editors: Combo, Key Override, Alt Repeat Key
  // Tab view = inline tile grid on the dedicated tab
  // Detail = clicking a tile opens the detail editor modal directly
  const editorContent = page.locator('[data-testid="editor-content"]')
  for (const editor of TILE_EDITOR_CAPTURES) {
    const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(editor.keycodeTab)}$`) })
    if (!(await isAvailable(tabBtn))) {
      console.log(`  [skip] ${editor.name} tab not found`)
      continue
    }
    await tabBtn.first().click()
    await page.waitForTimeout(300)

    // Capture the tab view (inline tile grid)
    await captureNamed(page, `${editor.name}-modal`, { fullPage: true })

    // Click tile to open detail editor modal
    const tile = page.locator(`[data-testid="${editor.tileTestId}"]`)
    if (!(await isAvailable(tile))) {
      console.log(`  [skip] ${editor.name} tile not found, detail skipped`)
      continue
    }
    await tile.click()
    try {
      await page.locator(`[data-testid="${editor.backdropTestId}"]`).waitFor({ state: 'visible', timeout: 3000 })
      await page.waitForTimeout(300)
      await captureNamed(page, `${editor.name}-detail`, { fullPage: true })
    } catch {
      console.log(`  [skip] ${editor.name} modal did not open, detail skipped`)
      continue
    }

    // Close the modal
    const closeBtn = page.locator(`[data-testid="${editor.modalCloseTestId}"]`)
    if (await isAvailable(closeBtn)) {
      await closeBtn.click()
    } else {
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(300)
  }
}

// --- Phase 6.5: JSON Editor Modals ---

async function captureJsonEditors(page: Page): Promise<void> {
  console.log('\n--- Phase 6.5: JSON Editor Modals ---')

  // Dismiss any lingering modals/overlays
  await dismissNotificationModal(page)
  await page.evaluate(() => {
    document.querySelectorAll('.fixed.inset-0').forEach((el) => el.remove())
  })
  await page.waitForTimeout(300)

  const editorContent = page.locator('[data-testid="editor-content"]')

  // Tap Dance JSON editor
  const tdTab = editorContent.locator('button', { hasText: /^Tap-Hold \/ Tap Dance$/ })
  if (await isAvailable(tdTab)) {
    await tdTab.first().click()
    await page.waitForTimeout(300)

    const jsonBtn = page.locator('[data-testid="tap-dance-json-editor-btn"]')
    if (await isAvailable(jsonBtn)) {
      await jsonBtn.click()
      await page.waitForTimeout(500)
      await captureNamed(page, 'json-editor-tap-dance', { fullPage: true })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    } else {
      console.log('  [skip] tap-dance-json-editor-btn not found')
    }
  }

  // Macro JSON editor (shows unlock warning)
  const macroTab = editorContent.locator('button', { hasText: /^Macro$/ })
  if (await isAvailable(macroTab)) {
    await macroTab.first().click()
    await page.waitForTimeout(300)

    const jsonBtn = page.locator('[data-testid="macro-json-editor-btn"]')
    if (await isAvailable(jsonBtn)) {
      await jsonBtn.click()
      await page.waitForTimeout(500)
      await captureNamed(page, 'json-editor-macro', { fullPage: true })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    } else {
      console.log('  [skip] macro-json-editor-btn not found')
    }
  }
}

// --- Phase 7: Editor Settings Panel (Save only) ---

async function captureEditorSettings(page: Page): Promise<void> {
  console.log('\n--- Phase 7: Editor Settings (Save Panel) ---')

  if (!(await ensureOverlayOpen(page))) {
    console.log('  [skip] overlay toggle not found')
    return
  }

  if (await switchOverlayTab(page, 'overlay-tab-data')) {
    await captureNamed(page, 'editor-settings-save', { fullPage: true })
  }
}

// --- Phase 7.5: Overlay Panel ---

async function captureOverlayPanel(page: Page): Promise<void> {
  console.log('\n--- Phase 7.5: Overlay Panel ---')

  if (!(await ensureOverlayOpen(page))) {
    console.log('  [skip] overlay toggle not found')
    return
  }

  if (await switchOverlayTab(page, 'overlay-tab-tools')) {
    await captureNamed(page, 'overlay-tools', { fullPage: true })
  }

  if (await switchOverlayTab(page, 'overlay-tab-data')) {
    await captureNamed(page, 'overlay-save', { fullPage: true })
  }

  await closeOverlay(page)
}

// --- Phase 8: Status Bar ---

async function captureStatusBar(page: Page): Promise<void> {
  console.log('\n--- Phase 8: Status Bar ---')

  const statusBar = page.locator('[data-testid="status-bar"]')
  if (await isAvailable(statusBar)) {
    await captureNamed(page, 'status-bar', { element: statusBar })
  } else {
    console.log('  [skip] status-bar not found')
  }
}

// --- Phase 8b: Simulation/Base tabs + Key Label "Apply to Keymap" confirm
// modal (Plan-qwerty-select-no-rewrite v7 — シミュレーションタブ方式) ---

// Drives the footer's Keyboard Layout select to the seeded `keymapApplicable`
// Colemak entry (see seedDummyKeyLabel above). Selecting it no longer opens
// any modal by itself — it switches the display and reveals the vertical
// simulation/Base tabs on the keymap. This waits for the simulation tab,
// clicks the Apply button on its layer-indicator row (the only way left to
// reach the Rewrite confirm modal), and captures it. Dismisses with Cancel,
// then resets the select back to QWERTY so every capture AFTER this one
// (Favorites, Key Popover, Basic View variants, ...) runs against the same
// untabbed QWERTY state every other phase assumes.
async function captureKeyLabelKeymapApply(page: Page): Promise<void> {
  console.log('\n--- Phase 8b: Simulation/Base Tabs + Apply-to-Keymap Modal ---')

  const layoutTrigger = page.getByRole('button', { name: 'Key Labels' })
  const triggerCount = await layoutTrigger.count()
  if (triggerCount === 0) {
    console.log('  [skip] Keyboard Layout select trigger not found (button aria-label="Key Labels" — footer may be in Edit mode, or quickSettings/keyboardLayout is unset)')
    return
  }
  if (triggerCount > 1) {
    console.log(`  [skip] ambiguous match: ${triggerCount} buttons named "Key Labels" (expected exactly 1)`)
    return
  }
  await layoutTrigger.click()
  await page.waitForTimeout(300)

  const option = page.getByRole('option', { name: DOC_CAPTURE_COLEMAK_NAME })
  const optionCount = await option.count()
  if (optionCount === 0) {
    console.log(`  [skip] seeded option "${DOC_CAPTURE_COLEMAK_NAME}" not found in the layout dropdown (seedDummyKeyLabel may not have landed, or the dropdown didn't open)`)
    return
  }
  await option.click()
  await page.waitForTimeout(300)

  const simulationTab = page.locator('[data-testid="keymap-pack-tab-simulation"]')
  try {
    await simulationTab.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    // No tabs within the timeout means `remapKind` never became 'simulated'
    // for the seeded entry — either `keymapApplicable` or the map's own
    // `buildKeymapRewriteTable` build failed.
    console.log('  [skip] simulation tab did not appear within 3s (remapKind never became "simulated" — check keymapApplicable and buildKeymapRewriteTable on the seeded entry)')
    return
  }

  const applyButton = page.locator('[data-testid="keymap-pack-apply-button"]')
  if (!(await isAvailable(applyButton))) {
    console.log('  [skip] simulation tab\'s Apply button not found (keymapEditable — keyboard.keymap.size > 0 — was likely false)')
    return
  }

  // Capture the tab strip itself, undimmed, before the confirm modal opens.
  // The modal shot below dims this same background, which is enough for
  // spatial context but not for judging the simulated-colour key tint the
  // guide's prose describes — this shot gives that a clean reference.
  await captureNamed(page, 'key-label-simulation-tabs', { fullPage: true })

  await applyButton.click()
  await page.waitForTimeout(300)

  const modal = page.locator('[data-testid="keymap-apply-confirm-modal"]')
  try {
    await modal.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] apply-to-keymap confirm modal did not open within 3s of clicking Apply')
    return
  }

  await captureNamed(page, 'key-label-keymap-apply-modal', { fullPage: true })
  console.log('  [ok] key-label-keymap-apply-modal.png captured')

  await page.locator('[data-testid="keymap-apply-confirm-cancel"]').click()
  await page.waitForTimeout(300)

  // Reset the select back to QWERTY (Default) — every capture after this
  // phase assumes the untabbed, unremapped state.
  await layoutTrigger.click()
  await page.waitForTimeout(300)
  const qwertyOption = page.getByRole('option', { name: 'QWERTY (Default)' })
  if (await isAvailable(qwertyOption)) {
    await qwertyOption.click()
    await page.waitForTimeout(300)
  } else {
    console.log('  [warn] could not find the QWERTY (Default) option to reset the layout select — later captures may run against Colemak')
  }
}

// --- Phase 9: Inline Favorites ---

async function captureFavorites(page: Page): Promise<void> {
  console.log('\n--- Phase 9: Inline Favorites ---')

  const editorContent = page.locator('[data-testid="editor-content"]')
  const tdTabLabel = 'Tap-Hold / Tap Dance'

  const tdTabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(tdTabLabel)}$`) })
  if (!(await isAvailable(tdTabBtn))) {
    console.log(`  [skip] ${tdTabLabel} tab not found`)
    return
  }
  await tdTabBtn.first().click()
  await page.waitForTimeout(300)

  // TD tab now shows a tile grid — click tile 0 to open the modal
  const tdTile = page.locator('[data-testid="td-tile-0"]')
  if (!(await isAvailable(tdTile))) {
    console.log('  [skip] td-tile-0 not found')
    return
  }
  await tdTile.click()
  await page.waitForTimeout(500)

  const tdBackdrop = page.locator('[data-testid="td-modal-backdrop"]')
  try {
    await tdBackdrop.waitFor({ state: 'visible', timeout: 3000 })
  } catch {
    console.log('  [skip] TD modal did not open')
    return
  }

  // TapDance modal now shows editor on the left and inline favorites panel on the right
  await captureNamed(page, 'inline-favorites', { fullPage: true })

  await page.locator('[data-testid="td-modal-close"]').click()
  await page.waitForTimeout(300)
}

// --- Phase 10: Key Popover ---

async function captureKeyPopover(page: Page): Promise<void> {
  console.log('\n--- Phase 10: Key Popover ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  // Switch to layer 0 using the layer panel testid
  const layer0Btn = page.locator('[data-testid="layer-panel-layer-num-0"]')
  if (await isAvailable(layer0Btn)) {
    await layer0Btn.click()
    await page.waitForTimeout(300)
  }
  // Switch to Basic tab using a visible button in the keycode tab bar
  const basicBtn = editorContent.locator('button:visible', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }

  // Double-click a key to open the popover. Target the first SVG <text>
  // element (key label) inside the layout, which is more stable than
  // matching inline style strings that may vary across environments.
  const keyLabel = editorContent.locator('svg text').first()
  if (!(await isAvailable(keyLabel))) {
    console.log('  [skip] No key label found in layout')
    return
  }

  // Scroll window to top and ensure keyboard layout is visible
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(300)
  // Use dispatchEvent to bypass viewport checks on SVG elements
  await keyLabel.evaluate((el) => {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(500)

  const popover = page.locator('[data-testid="key-popover"]')
  if (!(await isAvailable(popover))) {
    console.log('  [skip] Key popover did not open')
    return
  }

  // Capture Key tab (default view with search results)
  await captureNamed(page, 'key-popover-key', { fullPage: true })

  // Switch to Code tab and capture
  await page.locator('[data-testid="popover-tab-code"]').click()
  await page.waitForTimeout(300)
  await captureNamed(page, 'key-popover-code', { fullPage: true })

  // Switch back to Key tab and enable Mod Mask mode
  await page.locator('[data-testid="popover-tab-key"]').click()
  await page.waitForTimeout(200)

  await page.locator('[data-testid="popover-mode-mod-mask"]').click()
  await page.waitForTimeout(300)

  // Check a modifier to show the strip in action
  const lSftBtn = page.locator('[data-testid="mod-LSft"]')
  if (await isAvailable(lSftBtn)) {
    await lSftBtn.click()
    await page.waitForTimeout(200)
  }

  await captureNamed(page, 'key-popover-modifier', { fullPage: true })

  // Switch to LT mode to show layer selector
  await page.locator('[data-testid="popover-mode-mod-mask"]').click()
  await page.waitForTimeout(200)
  await page.locator('[data-testid="popover-mode-lt"]').click()
  await page.waitForTimeout(300)
  await captureNamed(page, 'key-popover-lt', { fullPage: true })

  // Close the popover
  const closeBtn = page.locator('[data-testid="popover-close"]')
  if (await isAvailable(closeBtn)) {
    await closeBtn.click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 11: Basic View Variants ---

async function captureBasicViewVariants(page: Page): Promise<void> {
  console.log('\n--- Phase 11: Basic View Variants ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  // Switch to Basic tab first
  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }

  const viewTypeTrigger = page.getByRole('button', { name: 'Basic Tab View' })
  if (!(await isAvailable(viewTypeTrigger))) {
    console.log('  [skip] basic view type selector not found')
    return
  }

  const viewListbox = page.getByRole('listbox', { name: 'Basic Tab View' })
  const viewTypes = [
    { value: 'ANSI', name: 'basic-ansi-view' },
    { value: 'ISO', name: 'basic-iso-view' },
    { value: 'JIS', name: 'basic-jis-view' },
    { value: 'LIST', name: 'basic-list-view' },
  ]

  for (const view of viewTypes) {
    await viewTypeTrigger.click()
    await page.waitForTimeout(200)
    await viewListbox.getByRole('option', { name: view.value, exact: true }).click()
    await page.waitForTimeout(500)
    await captureNamed(page, view.name, { fullPage: true })
  }

  // Restore ANSI view
  await viewTypeTrigger.click()
  await page.waitForTimeout(200)
  await viewListbox.getByRole('option', { name: 'ANSI', exact: true }).click()
  await page.waitForTimeout(300)
}

// --- Phase 12: Layer Panel States ---

async function captureLayerPanelStates(page: Page): Promise<void> {
  console.log('\n--- Phase 12: Layer Panel States ---')

  // First try to find the collapse button (panel is expanded)
  const collapseBtn = page.locator('[data-testid="layer-panel-collapse-btn"]')
  const expandBtn = page.locator('[data-testid="layer-panel-expand-btn"]')

  if (await isAvailable(collapseBtn)) {
    // Panel is expanded — capture collapsed first, then expanded
    await collapseBtn.click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'layer-panel-collapsed', { fullPage: true })

    // Re-expand
    const expandBtnAfter = page.locator('[data-testid="layer-panel-expand-btn"]')
    if (await isAvailable(expandBtnAfter)) {
      await expandBtnAfter.click()
      await page.waitForTimeout(500)
    }
    await captureNamed(page, 'layer-panel-expanded', { fullPage: true })
  } else if (await isAvailable(expandBtn)) {
    // Panel is collapsed — capture collapsed first
    await captureNamed(page, 'layer-panel-collapsed', { fullPage: true })

    await expandBtn.click()
    await page.waitForTimeout(500)
    await captureNamed(page, 'layer-panel-expanded', { fullPage: true })
  } else {
    console.log('  [skip] layer panel collapse/expand buttons not found')
  }
}

// --- Phase 13: Tile Grids ---

async function captureTileGrids(page: Page): Promise<void> {
  console.log('\n--- Phase 13: Tile Grids ---')

  const editorContent = page.locator('[data-testid="editor-content"]')

  const tileGrids = [
    { tabLabel: 'Tap-Hold / Tap Dance', tileTestId: 'td-tile-0', name: 'td-tile-grid' },
    { tabLabel: 'Macro', tileTestId: 'macro-tile-0', name: 'macro-tile-grid' },
    { tabLabel: 'Combo', tileTestId: 'combo-tile-0', name: 'combo-tile-grid' },
    { tabLabel: 'Key Override', tileTestId: 'ko-tile-0', name: 'ko-tile-grid' },
    { tabLabel: 'Alt Repeat Key', tileTestId: 'arep-tile-0', name: 'ar-tile-grid' },
  ]

  for (const grid of tileGrids) {
    const tabBtn = editorContent.locator('button', { hasText: new RegExp(`^${escapeRegex(grid.tabLabel)}$`) })
    if (!(await isAvailable(tabBtn))) {
      console.log(`  [skip] ${grid.tabLabel} tab not found`)
      continue
    }
    await tabBtn.first().click()
    await page.waitForTimeout(300)

    const tile = page.locator(`[data-testid="${grid.tileTestId}"]`)
    if (await isAvailable(tile)) {
      await captureNamed(page, grid.name, { fullPage: true })
    } else {
      console.log(`  [skip] ${grid.tileTestId} not found`)
    }
  }

  // Return to Basic tab
  const basicBtn = editorContent.locator('button', { hasText: /^Basic$/ })
  if (await isAvailable(basicBtn)) {
    await basicBtn.first().click()
    await page.waitForTimeout(300)
  }
}

// --- Phase 14: Macro Edit Modal (list mode + edit mode) ---

async function captureMacroEditModal(page: Page): Promise<void> {
  console.log('\n--- Phase 14: Macro Edit Modal ---')

  const editorContent = page.locator('[data-testid="editor-content"]')
  const macroTab = editorContent.locator('button', { hasText: /^Macro$/ })
  if (!(await isAvailable(macroTab))) {
    console.log('  [skip] Macro tab not found')
    return
  }
  await macroTab.first().click()
  await page.waitForTimeout(300)

  // Prefer an already-configured macro so the screenshot reflects a real list/edit UI
  // without mutating device state. If none are configured we skip. Macro tile 0 is
  // seeded as a text-only macro ("Hello") with no keycode field, so the edit-mode
  // capture below would find nothing to click — skip it in favor of another
  // configured tile (e.g. macro tile 1, seeded as a tap-KC_A action) whenever one
  // exists.
  const configuredTiles = page.locator('[data-testid^="macro-tile-"][data-configured]')
  const configuredCount = await configuredTiles.count()
  if (configuredCount === 0) {
    console.log('  [skip] No configured macro tile found — configure a macro on the device first')
    return
  }
  let configuredTile = configuredTiles.first()
  for (let i = 0; i < configuredCount; i++) {
    const candidate = configuredTiles.nth(i)
    if ((await candidate.getAttribute('data-testid')) !== 'macro-tile-0') {
      configuredTile = candidate
      break
    }
  }

  // Deselect any keymap key left selected by earlier phases; otherwise clicking a
  // macro tile assigns its keycode to the selected key instead of opening the modal.
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="tabbed-keycodes-root"]') as HTMLElement | null
    el?.click()
  })
  await page.waitForTimeout(200)

  await configuredTile.click()
  const modal = page.locator('[data-testid="macro-modal"]')
  try {
    await modal.waitFor({ state: 'visible', timeout: 2000 })
  } catch {
    console.log('  [skip] Macro modal did not open')
    return
  }

  try {
    await captureNamed(page, 'macro-list-mode', { element: modal })

    const firstKey = modal.locator('[data-testid="keycode-field"]').first()
    if (!(await isAvailable(firstKey))) {
      console.log('  [warn] No keycode-field found — edit-mode capture skipped')
      return
    }
    await firstKey.click()
    const closeEditBtn = modal.locator('[data-testid="macro-close-edit"]')
    try {
      await closeEditBtn.waitFor({ state: 'visible', timeout: 1500 })
    } catch {
      console.log('  [warn] edit mode did not activate — edit-mode capture skipped')
      return
    }
    await captureNamed(page, 'macro-edit-mode', { element: modal })
    await closeEditBtn.click()
    await page.waitForTimeout(300)
  } finally {
    const closeBtn = modal.locator('[data-testid="macro-modal-close"]')
    if (await isAvailable(closeBtn)) {
      await closeBtn.click().catch(() => { /* modal may already be gone */ })
      await page.waitForTimeout(300)
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })

  // Resolve the real userData path with a throwaway launch, then close it
  // before seeding. `ensureCacheIsFresh` (typing-analytics' SQLite cache
  // rebuild) runs once, fire-and-forget, during this same process's
  // `app.whenReady()` — it races the seed writes below whenever they land in
  // the same process's boot window, and there is no periodic recheck
  // afterward (see analyze-seed.ts: sync_state.json is only consulted "on
  // next launch"). If that boot-time rebuild wins the race, it captures an
  // empty JSONL snapshot and the seeded keyboard never appears in this
  // process's cache for the rest of its life, no matter what we write to
  // disk afterward — this is what silently emptied the Analyze screenshots.
  // Closing this throwaway app and relaunching fresh (below) after every
  // seed file is already on disk removes the race entirely: the real
  // capture session's own boot is guaranteed to see the seeded JSONL files
  // and the already-deleted sync_state.json together.
  console.log('Launching Electron app (virtual device) to resolve userData...')
  const primerApp = await launchCaptureApp()
  let userDataPath: string
  try {
    userDataPath = await primerApp.evaluate(async ({ app: a }) => a.getPath('userData'))
  } finally {
    // Fail closed: a primer that refuses to die could still run its
    // fire-and-forget analytics rebuild and recreate sync_state.json AFTER
    // the seeding below deletes it, silently reintroducing the boot race
    // this primer exists to prevent. Aborting is safer than continuing.
    await primerApp.close()
  }
  console.log(`userData: ${userDataPath}`)

  // Null out a stale `lastDevice` BEFORE the capture app itself launches —
  // see nullifyLastDeviceConfig's doc comment. This has broken back-to-back
  // doc-capture runs (and real `pnpm dev` launches) repeatedly: connecting
  // during a previous run persists `lastDevice`, and `restoreLastSession`
  // then auto-connects on the very next launch, skipping past the
  // device-selection screen this script's early phases depend on.
  const lastDeviceBackup = nullifyLastDeviceConfig(userDataPath)

  const favBase = join(userDataPath, 'sync', 'favorites')
  const keyLabelsBase = join(userDataPath, 'sync', 'key-labels')

  // Move aside keyboard dirs this session does not own. From this point on
  // the try/finally below owns putting them back: every seed/capture step —
  // including the seeding itself — runs inside the try, and each cleanup
  // step in the finally is guarded independently so no single failure can
  // strand user data in the backup dir.
  const kbBase = join(userDataPath, 'sync', 'keyboards')
  const foreignKbIsolation = isolateForeignKeyboardDirs(userDataPath)

  // The virtual device's uid is allowlisted above (never isolated), so this
  // is independent of foreignKbIsolation. Phase 5 (captureSidebarTools)
  // toggles Typing Test on the virtual device and persists `viewMode` into
  // its pipette_settings.json; e2e/virtual-device.test.ts shares the same
  // default userData and would otherwise auto-restore that leaked mode on
  // its next connect. Snapshot it now and restore in the finally below.
  const virtualDeviceSettingsBackup = backupVirtualDeviceSettings(userDataPath)
  // Reset a stale Keyboard Layout selection left over from a manual
  // `pnpm dev` session against the virtual device (see the doc comment on
  // `resetVirtualDeviceKeyboardLayout`) — must run after the backup above so
  // the original content still restores in the `finally` block below.
  resetVirtualDeviceKeyboardLayout(userDataPath)

  let favBackups: Map<string, string | null> | null = null
  let snapBackups: Map<string, string | null> | null = null
  let taBackup: Awaited<ReturnType<typeof seedDummyTypingAnalytics>> | null = null
  let filterStoreBackups: Map<string, string | null> | null = null
  let keyLabelBackup: KeyLabelSeedBackup | null = null
  let app: ElectronApplication | null = null

  try {
    favBackups = seedDummyFavorites(favBase)
    snapBackups = seedDummySnapshots(kbBase)
    taBackup = await seedDummyTypingAnalytics(userDataPath, Date.now())
    filterStoreBackups = seedDummyFilterStore(kbBase)
    keyLabelBackup = seedDummyKeyLabel(keyLabelsBase)
    console.log(
      `Seeded dummy data: fav=${favBackups.size} entries, snap=${DUMMY_SNAPSHOTS.length} keyboards, typing-analytics=${DUMMY_TA_UID}, filter-store=${filterStoreBackups.size} files, key-label=${DOC_CAPTURE_COLEMAK_NAME}`,
    )

    // Every seed file (including the deleted sync_state.json) is on disk
    // now, so this launch's own `ensureCacheIsFresh` deterministically
    // rebuilds the typing-analytics cache from it before the renderer
    // queries the keyboard list — no race with the seed writes above.
    console.log('Launching Electron app (virtual device) for capture...')
    app = await launchCaptureApp()

    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.setViewportSize({ width: 1320, height: 960 })
    await page.waitForTimeout(3000)

    // First post-launch call: wait a bit for the async startup-notification
    // fetch to land so we don't race past it and capture a later screen with
    // the modal still up.
    await dismissNotificationModal(page, { waitForAppearMs: 3000 })
    await captureDeviceSelection(page)       // 01
    await captureDataModal(page)             // 02
    await captureSettingsModal(page)         // named: settings-troubleshooting, settings-defaults
    await captureAnalyzePage(page)           // named: analyze-heatmap, analyze-heatmap-speed, analyze-wpm-time-series, analyze-wpm-time-of-day, analyze-interval-time-series, analyze-interval-distribution, analyze-activity-keystrokes, analyze-activity-calendar, analyze-ergonomics, analyze-ergonomics-learning, analyze-finger-assignment-modal, analyze-layer-keystrokes, analyze-layer-activations

    const connected = await connectDevice(app, page)
    if (!connected) {
      console.log('Failed to connect. Only device selection screenshots captured.')
      return
    }
    await ensureEditorMode(page)             // exit Typing Test if persisted from prior run

    await captureKeymapEditor(page)          // 03
    await captureLayerNavigation(page)       // 04-06
    await captureKeycodeCategories(page)     // 07+ (count varies by keyboard features)
    await captureKeyboardTab(page)           // keyboard-tab-device-list, keyboard-tab-keymap
    await captureSidebarTools(app, page)     // toolbar, zoom, typing-test
    await captureModalEditors(page)          // lighting, combo, ko, ar (when available)
    await captureJsonEditors(page)           // json-editor-tap-dance, json-editor-macro
    await captureEditorSettings(page)        // editor-settings-save
    await captureOverlayPanel(page)          // overlay-tools, overlay-save
    await captureStatusBar(page)             // status-bar
    await captureKeyLabelKeymapApply(page)   // named: key-label-keymap-apply-modal
    await captureFavorites(page)             // inline-favorites
    await captureKeyPopover(page)            // key-popover-key/code/modifier/lt
    await captureBasicViewVariants(page)     // named: basic-{ansi,iso,jis,list}-view
    await captureLayerPanelStates(page)      // layer-panel-collapsed/expanded
    await captureTileGrids(page)             // td-tile-grid, macro-tile-grid
    await captureMacroEditModal(page)        // macro-list-mode, macro-edit-mode

    console.log(`\nAll screenshots saved to: ${SCREENSHOT_DIR}`)
  } finally {
    // Each cleanup step is guarded on its own: a failure is logged but never
    // prevents the remaining steps from running.
    const cleanup = (label: string, fn: () => void): void => {
      try {
        fn()
      } catch (err) {
        console.error(`  [cleanup] ${label} failed:`, err)
      }
    }
    if (app) await app.close().catch((err: unknown) => console.error('  [cleanup] app.close failed:', err))
    // User data first: foreign dirs are disjoint from every seeded path, and
    // the cache/sync_state deletion inside restoreTypingAnalytics only forces
    // a rebuild on next boot — order relative to it is safe.
    cleanup('restore foreign keyboard dirs', () => restoreForeignKeyboardDirs(foreignKbIsolation))
    cleanup('restore virtual device settings', () => restoreVirtualDeviceSettings(virtualDeviceSettingsBackup))
    cleanup('restore lastDevice config', () => restoreLastDeviceConfig(lastDeviceBackup))
    cleanup('restore favorites', () => { if (favBackups) restoreFavorites(favBackups, favBase) })
    cleanup('restore snapshots', () => { if (snapBackups) restoreSnapshots(snapBackups) })
    cleanup('restore typing analytics', () => { if (taBackup) restoreTypingAnalytics(taBackup) })
    cleanup('restore filter store', () => { if (filterStoreBackups) restoreFilterStore(filterStoreBackups) })
    cleanup('restore key label', () => { if (keyLabelBackup) restoreDummyKeyLabel(keyLabelBackup) })
  }
}

main().catch((err: unknown) => {
  console.error('Script failed:', err)
  process.exit(1)
})
