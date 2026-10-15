// SPDX-License-Identifier: GPL-2.0-or-later
// Vector generator for the Rust port of the Cloud Sync formats
// (src-tauri/crates/pipette-sync-format). Every value comes from the real
// TypeScript functions:
//
// - ts_vectors.json — the same on every run. Envelopes from the real
//   `encrypt` (sync-crypto.ts) with `randomBytes` and the clock pinned, the
//   password-check envelope, how the real `decrypt` rejects broken
//   envelopes, the Drive file name mapping (google-drive.ts), machine hashes
//   from the real `getMachineHash` (machine-hash.ts) for given ids, and
//   entry body hashes (`bodyHash`, entry-clocks.ts).
// - ts_random_envelopes.json — envelopes from the real `encrypt` with real
//   random salt and IV; different on every run, for decrypt-only checks.
// - src-tauri/target/tmp/.../node_machine_id.json — `machineId(true)` of
//   this machine from the real node-machine-id, never committed.
//
// Run: pnpm run generate:sync-format-fixtures

import { describe, it, expect, vi, afterAll } from 'vitest'
import { writeJsonFixture } from '../fixture-files'
import { NODE_MACHINE_ID_PATH, TS_RANDOM_ENVELOPES_PATH, TS_VECTORS_PATH } from './paths'

const pinned = vi.hoisted(() => ({
  randomQueue: [] as Buffer[],
  machineId: '',
  installationId: '',
}))

// Queued salts and IVs first, and each derived key computed once
// (pinned-crypto.ts).
vi.mock('node:crypto', async (importOriginal) => {
  const { pinnedCrypto } = await import('./pinned-crypto')
  return pinnedCrypto(await importOriginal<typeof import('node:crypto')>(), pinned.randomQueue)
})

vi.mock('node-machine-id', () => ({
  default: { machineId: async (): Promise<string> => pinned.machineId },
}))

vi.mock('../../src/main/typing-analytics/installation-id', () => ({
  getInstallationId: async (): Promise<string> => pinned.installationId,
}))

import { encrypt, decrypt } from '../../src/main/sync/sync-crypto'
import { PASSWORD_CHECK_PAYLOAD } from '../../src/main/sync/sync-password'
import {
  PASSWORD_CHECK_UNIT,
  PASSWORD_CHANGE_LOCK_FILE,
  SYNC_FORMAT_FILE_PREFIX,
  driveFileName,
  driveFilenamePrefix,
  isDataFileName,
  parseSyncFormatFileName,
  syncFormatFileName,
  syncUnitFromFileName,
} from '../../src/main/sync/google-drive'
import { getMachineHash, resetMachineHashCacheForTests } from '../../src/main/typing-analytics/machine-hash'
import { bodyHash } from '../../src/main/sync/entry-clocks'
import { KEYBOARD_META_SYNC_UNIT } from '../../src/shared/types/keyboard-meta'
import type { SyncEnvelope } from '../../src/shared/types/sync'

/** Clock pinned while the fixed envelopes are encrypted (`updatedAt`). */
const FIXED_NOW = Date.UTC(2026, 9, 15, 1, 2, 3, 456)

interface EnvelopeCase {
  name: string
  password: string
  syncUnit: string
  plaintext: string
  saltHex: string
  ivHex: string
}

const DAY_JSONL = [
  '{"t":"2026-10-14T00:00:00.000Z","k":"KC_A","d":12}',
  '{"t":"2026-10-14T00:00:00.120Z","k":"KC_B","d":9}',
  '{"t":"2026-10-14T00:00:00.300Z","k":"KC_SPACE","d":30}',
].join('\n')

const ENVELOPE_CASES: EnvelopeCase[] = [
  {
    name: 'favorite-ascii',
    password: 'correct horse battery staple',
    syncUnit: 'favorites/tapDance',
    plaintext: JSON.stringify({ type: 'favorite', key: 'tapDance', index: { entries: [] }, files: {} }),
    saltHex: '000102030405060708090a0b0c0d0e0f',
    ivHex: 'a0a1a2a3a4a5a6a7a8a9aaab',
  },
  {
    // The password holds a decomposed "é" (e + U+0301): it must not be
    // NFC-normalized before key derivation.
    name: 'snapshot-unicode',
    password: 'パスワード🔑 café ',
    syncUnit: 'keyboards/0x1234ABCD/snapshots',
    plaintext: JSON.stringify({ type: 'layout', files: { 'a.json': '日本語 ✓ 😀\r\n  spaced  ' } }, null, 2),
    saltHex: 'ffeeddccbbaa99887766554433221100',
    ivHex: '0102030405060708090a0b0c',
  },
  {
    name: 'empty-plaintext-empty-password',
    password: '',
    syncUnit: 'meta/keyboard-names',
    plaintext: '',
    saltHex: '11111111111111111111111111111111',
    ivHex: '222222222222222222222222',
  },
  {
    name: 'typing-day-jsonl',
    password: 'p@ss/word+=',
    syncUnit: 'keyboards/0xABCD/devices/0123456789abcdef/days/2026-10-14',
    plaintext: JSON.stringify({ type: 'typing-analytics-device', files: { 'data.jsonl': DAY_JSONL } }),
    saltHex: '5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a',
    ivHex: 'c3c3c3c3c3c3c3c3c3c3c3c3',
  },
  {
    name: 'password-check',
    password: 'correct horse battery staple',
    syncUnit: PASSWORD_CHECK_UNIT,
    plaintext: PASSWORD_CHECK_PAYLOAD,
    saltHex: '9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    ivHex: '00000000000000000000000f',
  },
]

async function encryptPinned(c: EnvelopeCase): Promise<SyncEnvelope> {
  pinned.randomQueue.push(Buffer.from(c.saltHex, 'hex'), Buffer.from(c.ivHex, 'hex'))
  vi.setSystemTime(FIXED_NOW)
  try {
    return await encrypt(c.plaintext, c.password, c.syncUnit)
  } finally {
    vi.useRealTimers()
    expect(pinned.randomQueue).toEqual([])
  }
}

async function rejection(envelope: SyncEnvelope, password: string): Promise<string> {
  try {
    await decrypt(envelope, password)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  throw new Error(`decrypt of ${envelope.syncUnit} unexpectedly succeeded`)
}

const SYNC_UNITS = [
  'favorites/tapDance',
  'favorites/macro',
  'keyboards/0x1234/settings',
  'keyboards/0x1234/snapshots',
  'keyboards/0x1234/runs',
  'keyboards/0x1234/analyze_filters',
  'keyboards/0x1234/devices/0123abcd/days/2026-10-14',
  'keyboards/0x1234/devices/0123abcd/deleted-ranges',
  'keyboards/uid_with_underscores/settings',
  'keyboards/0x1/devices/hash_days_2026-01-01/days/2026-10-14',
  KEYBOARD_META_SYNC_UNIT,
  'key-labels',
  'typing-test-texts',
  'i18n/index',
  'i18n/packs/0f8c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
  'themes/index',
  'themes/packs/0f8c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
  PASSWORD_CHECK_UNIT,
  'unknown/shape',
  '',
]

const FILE_NAMES = [
  ...SYNC_UNITS.map((unit) => driveFileName(unit)),
  'keyboards_a_b_settings.enc',
  'keyboards_a_settings_snapshots.enc',
  'keyboards_a_analyze_filters.enc',
  'keyboards_a_filters.enc',
  'keyboards_x_devices_h_days_2026-1-01.enc',
  'keyboards_x_devices_h_days_2026-10-14_days_2026-10-15.enc',
  'keyboards_x_devices_a_devices_b_deleted-ranges.enc',
  'keyboards__settings.enc',
  'favorites_.enc',
  'favorites_a_b.enc',
  'favorites_日本語.enc',
  'favorites_a\nb.enc',
  'favorites_a\u0085b.enc',
  'favorites_tapDance.enc.bak',
  'i18n_packs_.enc',
  'themes_packs_x_y.enc',
  'password-check.enc',
  PASSWORD_CHANGE_LOCK_FILE,
  'sync-format-v2.json',
  'sync-format-v007.json',
  'sync-format-v.json',
  'sync-format-v2.enc',
  'sync-format-v9007199254740991.json',
  'sync-format-v9007199254740992.json',
  'sync-format-v123456789012345678901234567890.json',
  'sync-format-v٣.json',
  '',
]

const MACHINE_HASH_CASES: [string, string][] = [
  ['0123456789abcdef0123456789abcdef', '3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
  ['', ''],
  ['machine', ''],
  ['', '3f2504e0-4f89-41d3-9a0c-0305e82c3301'],
  ['ホスト名-é', 'id'],
]

const CONTENT_HASH_CASES = [
  '',
  '{"a":1,"b":2}',
  '{"b":2,"a":1}',
  '{\n  "a": 1\n}\n',
  '{\r\n  "a": 1\r\n}',
  '日本語 😀',
]

describe('sync format vectors', () => {
  const vectors: Record<string, unknown> = {}
  const randomEnvelopes: unknown[] = []

  afterAll(() => {
    writeJsonFixture(TS_VECTORS_PATH, vectors)
    writeJsonFixture(TS_RANDOM_ENVELOPES_PATH, randomEnvelopes)
  })

  it('records the constants', () => {
    vectors.constants = {
      passwordCheckUnit: PASSWORD_CHECK_UNIT,
      passwordCheckPayload: PASSWORD_CHECK_PAYLOAD,
      passwordChangeLockFile: PASSWORD_CHANGE_LOCK_FILE,
      syncFormatFilePrefix: SYNC_FORMAT_FILE_PREFIX,
      keyboardMetaSyncUnit: KEYBOARD_META_SYNC_UNIT,
    }
  })

  it('records envelopes encrypted with a pinned salt, IV and clock', async () => {
    const records = []
    for (const c of ENVELOPE_CASES) {
      const envelope = await encryptPinned(c)
      expect(await decrypt(envelope, c.password)).toBe(c.plaintext)
      records.push({ ...c, envelope, json: JSON.stringify(envelope) })
    }
    vectors.envelopes = records
  })

  it('records how decrypt rejects broken envelopes', async () => {
    const base = ENVELOPE_CASES[0]
    const envelope = await encryptPinned(base)
    const tag = Buffer.from(envelope.ciphertext, 'base64')
    const flipped = Buffer.from(tag)
    flipped[0] ^= 0x01
    const cases: { name: string; envelope: SyncEnvelope; password: string }[] = [
      { name: 'wrong-password', envelope, password: base.password + 'x' },
      { name: 'other-sync-unit', envelope: { ...envelope, syncUnit: 'favorites/macro' }, password: base.password },
      { name: 'other-version', envelope: { ...envelope, version: 2 as 1 }, password: base.password },
      { name: 'flipped-ciphertext-bit', envelope: { ...envelope, ciphertext: flipped.toString('base64') }, password: base.password },
      { name: 'ciphertext-too-short', envelope: { ...envelope, ciphertext: tag.subarray(0, 15).toString('base64') }, password: base.password },
    ]
    const records = []
    for (const c of cases) records.push({ ...c, message: await rejection(c.envelope, c.password) })
    vectors.rejections = records
  })

  it('records the Drive file name mapping', () => {
    vectors.driveFileName = SYNC_UNITS.map((syncUnit) => ({ syncUnit, fileName: driveFileName(syncUnit) }))
    vectors.driveFilenamePrefix = ['keyboards/0x1234/devices/', 'favorites/', ''].map((prefix) => ({
      prefix,
      fileNamePrefix: driveFilenamePrefix(prefix),
    }))
    vectors.syncFormatFileName = [0, 2, 9007199254740991].map((version) => ({ version, fileName: syncFormatFileName(version) }))
    vectors.fileNames = FILE_NAMES.map((fileName) => ({
      fileName,
      syncUnit: syncUnitFromFileName(fileName),
      isDataFileName: isDataFileName(fileName),
      syncFormatVersion: parseSyncFormatFileName(fileName),
    }))
  })

  it('records machine hashes for given ids', async () => {
    const records = []
    for (const [machineId, installationId] of MACHINE_HASH_CASES) {
      pinned.machineId = machineId
      pinned.installationId = installationId
      resetMachineHashCacheForTests()
      records.push({ machineId, installationId, machineHash: await getMachineHash() })
    }
    vectors.machineHashes = records
  })

  it('records entry body hashes', () => {
    vectors.contentHashes = CONTENT_HASH_CASES.map((text) => ({ text, hash: bodyHash(text) }))
  })

  it('records envelopes from the real random encrypt', async () => {
    for (const c of ENVELOPE_CASES) {
      const envelope = await encrypt(c.plaintext, c.password, c.syncUnit)
      randomEnvelopes.push({ name: c.name, password: c.password, plaintext: c.plaintext, envelope })
    }
  })

  it("records this machine's machineId(true)", async () => {
    const actual = await vi.importActual<{ default: typeof import('node-machine-id') }>('node-machine-id')
    const machineId = await actual.default.machineId(true)
    writeJsonFixture(NODE_MACHINE_ID_PATH, { machineId })
  })
})
