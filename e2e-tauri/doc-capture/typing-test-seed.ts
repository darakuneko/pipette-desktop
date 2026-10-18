// SPDX-License-Identifier: GPL-2.0-or-later
//
// The data the Typing Test capture (specs/typing-test.ts) shows, written
// into the session's userData directory while the app is stopped: History
// runs of the virtual keyboard, a keystroke log of one of them, a
// downloaded hiragana word list and a File Import text; and, while it
// runs, the Hub's answers about the Tatoeba and Aozora Bunko datasets,
// recorded with the development tools so nothing reaches the network.
// Files the capture changes are snapshotted first, so a later step can put
// them back as they were before the capture's own runs.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunKeystrokeLog, RunLogIndex } from '../../src/shared/types/typing-run-log'
import { normalizeFileImportText } from '../../src/shared/types/typing-test-text-store'
import type { TypingTestTextEntryFile, TypingTestTextIndex, TypingTestTextMeta } from '../../src/shared/types/typing-test-text-store'
import { respondHttp } from '../helpers/app'
import { E2E_HUB_URL, userDataPath } from '../helpers/driver'
import { VIRTUAL_DEVICE_UID } from './common'

/** A file's content as found before the capture seeded or changed it, or
 *  null when it did not exist. */
export interface FileBackup {
  path: string
  content: string | null
}

/** Snapshots `path`'s content (or records that it didn't exist yet). */
export function backupFile(path: string): FileBackup {
  return { path, content: existsSync(path) ? readFileSync(path, 'utf-8') : null }
}

/** Puts back the file snapshotted by `backupFile`: writes back the
 *  original content, or removes the file if it did not exist. */
export function restoreFile(backup: FileBackup): void {
  if (backup.content != null) {
    writeFileSync(backup.path, backup.content, 'utf-8')
  } else {
    try { unlinkSync(backup.path) } catch { /* absent already */ }
  }
}

// [daysAgo, wpm, accuracy, correctChars, incorrectChars] for each seeded run — all
// share the same `words` (30, english, no toggles) condition with rising accuracy.
const ACCURACY_TREND_SEED_RUNS: [number, number, number, number, number][] = [
  [6, 58, 88, 145, 20],
  [3, 64, 92, 148, 13],
  [1, 71, 96, 154, 6],
]

// Plausible substitution/omission/insertion rates for the seeded runs
// (share of errorTargetChars) — same constants as analyze-seed.ts's
// DUMMY_ERROR_*_RATE, so the two seed helpers agree, and close to but not
// exactly the population means (shared/typing-benchmarks.ts) so the
// History Error mix section shows real figures instead of its empty
// state.
const SEED_ERROR_SUBSTITUTION_RATE = 0.018
const SEED_ERROR_OMISSION_RATE = 0.009
const SEED_ERROR_INSERTION_RATE = 0.006

// The most recent Accuracy Trend seed run (see ACCURACY_TREND_SEED_RUNS'
// last entry, daysAgo: 1) doubles as the Keystroke Timeline seed run — its
// History row gets this `runId` so the seeded run log below
// (`seedRunKeystrokeLog`) actually has a matching History entry to open
// the timeline icon from.
const TIMELINE_SEED_RUN_ID = 'doc-capture-timeline-run'

/** Fills in the baseline fields the settings validator expects (see
 *  DEFAULT_PIPETTE_SETTINGS in shared/types/pipette-settings.ts): a file
 *  with only `typingTestResults` is treated as incomplete and replaced
 *  with the defaults on first read, discarding the seed. Only filled in
 *  when missing so a prior file's own values survive. */
function withBaseline(settings: Record<string, unknown>): Record<string, unknown> {
  settings._rev ??= 1
  settings.keyboardLayout ??= 'qwerty'
  settings.autoAdvance ??= true
  settings.layerNames ??= []
  return settings
}

/** Seeds the Accuracy Trend seed runs above into the virtual device's
 *  pipette_settings.json, so the Accuracy Trend chart (History → Data
 *  section) has a real trend line to screenshot, and — since every run
 *  carries the error-class group — so the Error mix section below it
 *  shows real figures instead of its empty state. Merged onto
 *  whatever the file had before the capture (`settingsBackup`). */
export function seedAccuracyTrendHistory(settingsBackup: FileBackup): void {
  mkdirSync(dirname(settingsBackup.path), { recursive: true })
  const existing = withBaseline(settingsBackup.content != null
    ? (JSON.parse(settingsBackup.content) as Record<string, unknown>)
    : {})
  const now = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000
  existing.typingTestResults = ACCURACY_TREND_SEED_RUNS.map(([daysAgo, wpm, accuracy, correctChars, incorrectChars], i) => {
    // All-or-nothing error-class group (see TypingTestResult.errorSubstitutions
    // et al.) — errorTargetChars stands in for Σ target length the same way
    // analyze-seed.ts's dummy History rows do (correctChars + incorrectChars
    // is a plausible total, not a real Levenshtein alignment).
    const errorTargetChars = correctChars + incorrectChars
    const isLast = i === ACCURACY_TREND_SEED_RUNS.length - 1
    return {
      date: new Date(now - daysAgo * DAY_MS).toISOString(),
      runId: isLast ? TIMELINE_SEED_RUN_ID : undefined,
      wpm, accuracy, wordCount: 30, correctChars, incorrectChars, durationSeconds: 24,
      mode: 'words', mode2: 30, language: 'english', punctuation: false, numbers: false,
      errorSubstitutions: Math.round(errorTargetChars * SEED_ERROR_SUBSTITUTION_RATE),
      errorOmissions: Math.round(errorTargetChars * SEED_ERROR_OMISSION_RATE),
      errorInsertions: Math.round(errorTargetChars * SEED_ERROR_INSERTION_RATE),
      errorTargetChars,
    }
  })
  writeFileSync(settingsBackup.path, JSON.stringify(existing), 'utf-8')
}

/** Seeds a fresh `typingTestResults` array onto the settings the virtual
 *  keyboard had before the capture (`settingsBackup`), for the Weak Spot
 *  Training captures: History is read when the keyboard connects, so each
 *  of them runs after a relaunch with its own seed. */
export function seedWeakSpotHistory(settingsBackup: FileBackup, results: Record<string, unknown>[]): void {
  mkdirSync(dirname(settingsBackup.path), { recursive: true })
  const existing = withBaseline(settingsBackup.content != null
    ? (JSON.parse(settingsBackup.content) as Record<string, unknown>)
    : {})
  existing.typingTestResults = results
  writeFileSync(settingsBackup.path, JSON.stringify(existing), 'utf-8')
}

/** The run log files of the session's virtual keyboard, by run id. */
function runLogPaths(): { indexPath: string; payloadPath: string; filename: string } {
  const runsDir = userDataPath('sync', 'keyboards', VIRTUAL_DEVICE_UID, 'runs')
  const filename = `${TIMELINE_SEED_RUN_ID}.json`
  return { indexPath: join(runsDir, 'index.json'), payloadPath: join(runsDir, filename), filename }
}

/** Snapshots of the run log files `seedRunKeystrokeLog` writes. */
export function backupRunKeystrokeLog(): FileBackup[] {
  const { indexPath, payloadPath } = runLogPaths()
  return [backupFile(indexPath), backupFile(payloadPath)]
}

/** Seeds a plausible `RunKeystrokeLog` (index + payload file, the run log
 *  store's on-disk layout) for `TIMELINE_SEED_RUN_ID` — the History row
 *  seeded above with that runId — so the row's Keystroke Timeline link has
 *  real data to open for the `typing-test-timeline.png` capture. Three
 *  words across two lines (`lineBreaks: [1]`): "the"/"quick" share line 0
 *  (with a mid-line pause and a short overlap on "quick"), "fox" alone is
 *  line 1 (crossed into after a pause past the line view's own 250ms
 *  threshold, `LINE_BLANK_THRESHOLD_MS`, so it renders as a lead-in marker
 *  rather than an ordinary mid-line blank). `lineBreaks` being present at
 *  all is what selects the LINE-view renderer (`useTimelineModel`) over the
 *  per-word one. */
export function seedRunKeystrokeLog(): void {
  const { indexPath, payloadPath, filename } = runLogPaths()
  mkdirSync(dirname(indexPath), { recursive: true })

  const log: RunKeystrokeLog = {
    runId: TIMELINE_SEED_RUN_ID,
    uid: VIRTUAL_DEVICE_UID,
    startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    durationMs: 3200,
    mode: 'words',
    language: 'english',
    lineBreaks: [1],
    words: [
      {
        index: 0,
        display: 'the',
        typed: 'the',
        correct: true,
        keystrokes: [
          // Observed non-overlaps so the summary's pooled overlap rate reads
          // as a realistic fraction rather than 100% from a single verdict.
          { pressMs: 0, releaseMs: 90, keycode: 0, row: 0, col: 0, correct: true, overlapped: false, expectedChar: 't' },
          { pressMs: 120, releaseMs: 210, keycode: 0, row: 0, col: 1, correct: true, overlapped: false, expectedChar: 'h' },
          { pressMs: 240, releaseMs: 330, keycode: 0, row: 0, col: 2, correct: true, overlapped: false, expectedChar: 'e' },
        ],
      },
      {
        index: 1,
        display: 'quick',
        typed: 'qiuck',
        correct: false,
        keystrokes: [
          // Well past the line view's 250ms blank threshold but still on
          // the SAME line as "the" (lineBreaks: [1] keeps both on line 0)
          // — this is the mid-line pause the screenshot's blank marker
          // shows, not a cross-line lead-in.
          { pressMs: 1800, releaseMs: 1880, keycode: 0, row: 1, col: 0, correct: true, expectedChar: 'q' },
          { pressMs: 1900, releaseMs: 2010, keycode: 0, row: 1, col: 1, correct: false, expectedChar: 'u' },
          // Overlaps the previous key's own release — the duplicate-
          // keystroke case the legend's "Overlapped" swatch documents.
          { pressMs: 1990, releaseMs: 2080, keycode: 0, row: 1, col: 2, correct: false, overlapped: true, expectedChar: 'i' },
        ],
      },
      {
        index: 2,
        display: 'fox',
        typed: 'fox',
        correct: true,
        keystrokes: [
          // 420ms past "quick"'s last release (2080) — crosses the line
          // break (lineBreaks: [1] ends line 0 at word 1), so this reads
          // as a lead-in pause before line 1 rather than an ordinary
          // mid-line blank.
          { pressMs: 2500, releaseMs: 2580, keycode: 0, row: 2, col: 0, correct: true, overlapped: false, expectedChar: 'f' },
          { pressMs: 2610, releaseMs: 2690, keycode: 0, row: 2, col: 1, correct: true, overlapped: false, expectedChar: 'o' },
          { pressMs: 2720, releaseMs: 2800, keycode: 0, row: 2, col: 2, correct: true, overlapped: false, expectedChar: 'x' },
        ],
      },
    ],
  }

  const index: RunLogIndex = {
    uid: VIRTUAL_DEVICE_UID,
    entries: [{ id: TIMELINE_SEED_RUN_ID, startedAt: log.startedAt, filename, savedAt: new Date().toISOString() }],
  }

  writeFileSync(payloadPath, JSON.stringify(log), 'utf-8')
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')
}

// The romaji-engine test suite's canonical multi-pattern word (accepts
// dhi/deli/dexi for でぃ, plus the ー long-vowel passthrough) — reused here so
// the Romaji input screenshot demonstrates the same digraph the tests cover.
export const ROMAJI_DEMO_WORD = 'でぃなーにいく'

/** The downloaded MonkeyType `japanese_hiragana` word list of the session. */
export function kanaLanguagePackPath(): string {
  return userDataPath('local', 'downloads', 'languages', 'monkeytype', 'japanese_hiragana.json')
}

/** Seeds `japanese_hiragana` as an already-downloaded MonkeyType pack (a
 *  single-word list built from `ROMAJI_DEMO_WORD`, so every word offered in
 *  the reading window is the digraph demo word — deterministic for the
 *  screenshot) so the Romaji input capture never depends on a download.
 *  The language store reads this file straight off disk with no
 *  fileSize/manifest cross-check, so a hand-written fixture is sufficient. */
export function seedKanaLanguagePack(): void {
  const path = kanaLanguagePackPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ name: 'japanese_hiragana', words: [ROMAJI_DEMO_WORD] }), 'utf-8')
}

export const COMPLETION_DEMO_TEXT_ID = 'doc-capture-completion-demo'
// Two short lines — enough to show the completion screen's per-line
// timeline, a "Lines" stat card, and (via the deliberate typos typed in
// the capture) both Missed-bar colors: "teh" is typed then corrected with
// Backspace before submitting (gray), "dgos" is left wrong when the last
// word is submitted (red).
const COMPLETION_DEMO_RAW_TEXT = 'the quick fox\njumps over dogs'

/** Seeds a File Import text directly on disk (bypassing the file-picker
 *  dialog) — the text store's `list`/`get` read straight off disk, so a
 *  hand-written index + entry file is sufficient. Returns both file
 *  backups for `restoreFile`. */
export function seedCompletionDemoText(): { indexBackup: FileBackup; entryBackup: FileBackup } {
  const dir = userDataPath('sync', 'typing-test-texts')
  const indexPath = join(dir, 'index.json')
  const filename = `${COMPLETION_DEMO_TEXT_ID}.json`
  const entryPath = join(dir, filename)
  const indexBackup = backupFile(indexPath)
  const entryBackup = backupFile(entryPath)
  mkdirSync(dir, { recursive: true })

  const { text, wordCount, lineCount } = normalizeFileImportText(COMPLETION_DEMO_RAW_TEXT)
  const now = new Date().toISOString()
  const meta: TypingTestTextMeta = {
    id: COMPLETION_DEMO_TEXT_ID,
    name: 'Completion Demo',
    wordCount,
    lineCount,
    filename,
    savedAt: now,
    updatedAt: now,
  }
  const existingIndex: TypingTestTextIndex = indexBackup.content
    ? (JSON.parse(indexBackup.content) as TypingTestTextIndex)
    : { entries: [] }
  const newIndex: TypingTestTextIndex = {
    entries: [...existingIndex.entries.filter((e) => e.id !== COMPLETION_DEMO_TEXT_ID), meta],
  }
  writeFileSync(indexPath, JSON.stringify(newIndex, null, 2), 'utf-8')
  const entryData: TypingTestTextEntryFile = { name: meta.name, text }
  writeFileSync(entryPath, JSON.stringify(entryData), 'utf-8')
  return { indexBackup, entryBackup }
}

// --- Dataset answers --------------------------------------------------------

/** Where the recorded datasets say their files are; only the recorded
 *  answers are ever fetched from it. */
const DOWNLOADS = 'https://doc-capture.invalid/downloads'

/** The Tatoeba word list downloaded for the running-state screenshot. */
const TATOEBA_JAPANESE = JSON.stringify({
  name: 'japanese',
  words: [
    'きょうはいいてんきですね。',
    'わたしはねこがすきです。',
    'あしたはやくおきます。',
    'このほんはとてもおもしろい。',
    'えきまであるいていきましょう。',
    'まどをあけてもいいですか。',
    'なつやすみにうみへいきたい。',
    'おちゃをいっぱいください。',
  ],
})

/** The Tatoeba dataset: the Japanese list, which the capture downloads,
 *  and a few others offered for download. */
const TATOEBA_DATASET = {
  provider: 'tatoeba',
  version: 'doc-capture-tatoeba',
  downloadUrlBase: `${DOWNLOADS}/tatoeba`,
  model: 'pack',
  languages: [
    { name: 'japanese', wordCount: 8, rightToLeft: false, fileSize: Buffer.byteLength(TATOEBA_JAPANESE) },
    { name: 'english', wordCount: 1000, rightToLeft: false, fileSize: 52_000 },
    { name: 'french', wordCount: 1000, rightToLeft: false, fileSize: 61_000 },
    { name: 'german', wordCount: 1000, rightToLeft: false, fileSize: 63_000 },
    { name: 'spanish', wordCount: 1000, rightToLeft: false, fileSize: 58_000 },
  ],
}

/** The Aozora Bunko catalog: a few works, four of them by 太宰治 for the
 *  search the capture shows. */
const AOZORA_DATASET = {
  provider: 'aozora',
  version: 'doc-capture-aozora',
  downloadUrlBase: `${DOWNLOADS}/aozora`,
  model: 'catalog',
  languages: [
    { name: '000035/files/doc-1.zip', title: '走れメロス', author: '太宰治', authorKana: 'だざいおさむ' },
    { name: '000035/files/doc-2.zip', title: '人間失格', author: '太宰治', authorKana: 'だざいおさむ' },
    { name: '000035/files/doc-3.zip', title: '斜陽', author: '太宰治', authorKana: 'だざいおさむ' },
    { name: '000035/files/doc-4.zip', title: '富嶽百景', author: '太宰治', authorKana: 'だざいおさむ' },
    { name: '000148/files/doc-5.zip', title: 'こころ', author: '夏目漱石', authorKana: 'なつめそうせき' },
    { name: '000148/files/doc-6.zip', title: '坊っちゃん', author: '夏目漱石', authorKana: 'なつめそうせき' },
    { name: '000879/files/doc-7.zip', title: '羅生門', author: '芥川竜之介', authorKana: 'あくたがわりゅうのすけ' },
    { name: '000081/files/doc-8.zip', title: '銀河鉄道の夜', author: '宮沢賢治', authorKana: 'みやざわけんじ' },
  ].map((work) => ({ ...work, wordCount: 3000, rightToLeft: false, fileSize: 20_000 })),
}

/** Records the Hub's answers for one check and one update of `provider`'s
 *  dataset to `dataset`. */
async function respondDataset(provider: string, dataset: { version: string }): Promise<void> {
  const route = `${E2E_HUB_URL}/api/typing-test/datasets/${provider}`
  const version = JSON.stringify({ ok: true, data: { provider, version: dataset.version } })
  // The tab's check, then the update's own check.
  await respondHttp(`${route}/version`, version)
  await respondHttp(`${route}/version`, version)
  await respondHttp(route, JSON.stringify({ ok: true, data: dataset }))
}

/** Records the answers the Mode modal's Tatoeba and Aozora Bunko tabs ask
 *  for: their dataset updates and the Tatoeba Japanese word list. */
export async function respondTypingDatasets(): Promise<void> {
  await respondDataset('tatoeba', TATOEBA_DATASET)
  await respondHttp(`${DOWNLOADS}/tatoeba/japanese.json`, TATOEBA_JAPANESE)
  await respondDataset('aozora', AOZORA_DATASET)
}
