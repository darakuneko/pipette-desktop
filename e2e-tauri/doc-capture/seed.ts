// SPDX-License-Identifier: GPL-2.0-or-later
//
// The data the main capture shows, written into the session's userData
// directory while the app is stopped: favorites, keymap snapshots of two
// keyboards, a keyboard's typing analytics and saved Analyze filters, and a
// Key Label that can rewrite the keymap. The directory is the session's
// temporary one, so nothing is backed up or restored.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DUMMY_SNAPSHOTS,
  DUMMY_TA_UID,
  seedDummyFilterStore,
  seedDummySnapshots,
  seedDummyTypingAnalytics,
} from '../helpers/analyze-seed'

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
  // Seeded empty so the combo / key-override / alt-repeat detail
  // screenshots show no favorites.
  combo: { type: 'combo', entries: [] },
  keyOverride: { type: 'keyOverride', entries: [] },
  altRepeatKey: { type: 'altRepeatKey', entries: [] },
}

function seedDummyFavorites(favBase: string): number {
  let count = 0
  for (const [type, index] of Object.entries(DUMMY_FAVORITES)) {
    const dir = join(favBase, type)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8')
    for (const entry of index.entries) writeFileSync(join(dir, entry.filename), '{}', 'utf-8')
    count += index.entries.length
  }
  return count
}

// --- Key Label "apply to keymap" seed ---

export const DOC_CAPTURE_COLEMAK_NAME = 'Colemak (doc-capture)'
const DOC_CAPTURE_COLEMAK_ID = 'doc-capture-colemak'
const DOC_CAPTURE_COLEMAK_FILENAME = `${DOC_CAPTURE_COLEMAK_ID}.json`
// Real Colemak permutation (same fixture used in shared/keymap/__tests__/keymap-apply.test.ts)
// so buildKeymapRewriteTable actually succeeds and the confirm modal opens.
const DOC_CAPTURE_COLEMAK_MAP: Record<string, string> = {
  KC_E: 'F', KC_R: 'P', KC_T: 'G', KC_Y: 'J', KC_U: 'L', KC_I: 'U', KC_O: 'Y',
  KC_P: ';', KC_S: 'R', KC_D: 'S', KC_F: 'T', KC_G: 'D', KC_J: 'N', KC_K: 'E',
  KC_L: 'I', KC_SCOLON: 'O', KC_N: 'K',
}

// Seeds a `keymapApplicable: true` Colemak entry into `sync/key-labels/` so
// the Key Label capture can drive the footer's confirm modal without a Hub
// download. The app adds the built-in QWERTY row itself on first list, so
// the seed does not need to reproduce that.
function seedDummyKeyLabel(keyLabelsBase: string): void {
  mkdirSync(keyLabelsBase, { recursive: true })
  const now = new Date().toISOString()
  const entries = [{
    id: DOC_CAPTURE_COLEMAK_ID,
    name: DOC_CAPTURE_COLEMAK_NAME,
    uploaderName: 'pipette',
    filename: DOC_CAPTURE_COLEMAK_FILENAME,
    savedAt: now,
    updatedAt: now,
  }]
  writeFileSync(join(keyLabelsBase, 'index.json'), JSON.stringify({ entries }, null, 2), 'utf-8')
  writeFileSync(
    join(keyLabelsBase, DOC_CAPTURE_COLEMAK_FILENAME),
    JSON.stringify({ name: DOC_CAPTURE_COLEMAK_NAME, map: DOC_CAPTURE_COLEMAK_MAP, keymapApplicable: true }, null, 2),
    'utf-8',
  )
}

/** Writes every seed of the main capture into `userDataPath`. The typing
 *  analytics seed reads this device's machine hash from sync_state.json, so
 *  the app must have run once with this directory, and removes that file so
 *  the next launch rebuilds the cache from the seeded days. */
export async function seedCaptureData(userDataPath: string, nowMs: number): Promise<void> {
  const kbBase = join(userDataPath, 'sync', 'keyboards')
  const favorites = seedDummyFavorites(join(userDataPath, 'sync', 'favorites'))
  seedDummySnapshots(kbBase)
  await seedDummyTypingAnalytics(userDataPath, nowMs)
  const filterFiles = seedDummyFilterStore(kbBase).size
  seedDummyKeyLabel(join(userDataPath, 'sync', 'key-labels'))
  console.log(
    `Seeded dummy data: fav=${favorites} entries, snap=${DUMMY_SNAPSHOTS.length} keyboards, typing-analytics=${DUMMY_TA_UID}, filter-store=${filterFiles} files, key-label=${DOC_CAPTURE_COLEMAK_NAME}`,
  )
}
