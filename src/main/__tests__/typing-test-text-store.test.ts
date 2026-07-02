// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// --- Mock electron ---

let mockUserDataPath = ''
const showOpenDialog = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args),
  },
  BrowserWindow: {},
}))

vi.mock('../sync/sync-service', () => ({
  notifyChange: vi.fn(),
}))

// --- Import after mocking ---

import { notifyChange } from '../sync/sync-service'
import {
  saveRecord,
  listMetas,
  listAllMetas,
  getRecord,
  renameRecord,
  deleteRecord,
  hasActiveName,
  importFromDialog,
  confirmImportOverwrite,
  TYPING_TEST_TEXT_SYNC_UNIT,
} from '../typing-test-text-store'
import { parseFileImportText, normalizeFileImportText, TYPING_TEST_TEXT_MAX_WORDS } from '../../shared/types/typing-test-text-store'

const fakeWin = {} as Electron.BrowserWindow

describe('typing-test-text-store', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'tt-text-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('parseFileImportText', () => {
    it('collapses intra-line whitespace and keeps single-line as no breaks', () => {
      expect(parseFileImportText('  the  quick\t fox ')).toEqual({ words: ['the', 'quick', 'fox'], lineBreaks: [], indents: ['  '] })
    })

    it('treats newline as a line break distinct from space', () => {
      // "the quick" / "brown fox": break after index 1, none after the last word.
      expect(parseFileImportText('the quick\nbrown fox')).toEqual({ words: ['the', 'quick', 'brown', 'fox'], lineBreaks: [1], indents: ['', ''] })
    })

    it('normalizes CRLF/CR and drops empty lines', () => {
      expect(parseFileImportText('a\r\n\r\nb\rc')).toEqual({ words: ['a', 'b', 'c'], lineBreaks: [0, 1], indents: ['', '', ''] })
    })

    it('caps at the word limit', () => {
      const many = Array.from({ length: TYPING_TEST_TEXT_MAX_WORDS + 50 }, (_, i) => `w${i}`).join(' ')
      expect(parseFileImportText(many).words).toHaveLength(TYPING_TEST_TEXT_MAX_WORDS)
    })
  })

  describe('normalizeFileImportText', () => {
    it('canonicalizes with single spaces in a line and newline at breaks', () => {
      expect(normalizeFileImportText('the  quick\nbrown   fox')).toEqual({ text: 'the quick\nbrown fox', wordCount: 4 })
    })

    it('preserves leading indentation per line (code structure)', () => {
      expect(normalizeFileImportText('def f() {\n  val x = 1\n}')).toEqual({ text: 'def f() {\n  val x = 1\n}', wordCount: 8 })
    })

    it('round-trips through parseFileImportText', () => {
      const { text } = normalizeFileImportText('a b\nc\n\nd e f')
      expect(parseFileImportText(text)).toEqual(parseFileImportText('a b\nc\n\nd e f'))
    })
  })

  describe('saveRecord', () => {
    it('saves text + meta with wordCount and notifies sync', async () => {
      const result = await saveRecord({ name: 'My Novel', text: 'the quick brown fox' })
      expect(result.success).toBe(true)
      expect(result.data?.wordCount).toBe(4)
      expect(result.data?.id).toBeTruthy()
      expect(notifyChange).toHaveBeenCalledWith(TYPING_TEST_TEXT_SYNC_UNIT)

      const metas = await listMetas()
      expect(metas).toHaveLength(1)
      expect(metas[0].name).toBe('My Novel')
    })

    it('rejects empty / whitespace-only text', async () => {
      const result = await saveRecord({ name: 'Empty', text: '   \n\t  ' })
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('EMPTY_TEXT')
    })

    it('rejects an empty name', async () => {
      const result = await saveRecord({ name: '   ', text: 'hello world' })
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_NAME')
    })

    it('rejects a duplicate active name', async () => {
      await saveRecord({ name: 'Dup', text: 'one two' })
      const result = await saveRecord({ name: 'dup', text: 'three four' })
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('DUPLICATE_NAME')
    })

    it('overwrites in place when the same id is passed', async () => {
      const first = await saveRecord({ name: 'Doc', text: 'a b c' })
      const id = first.data!.id
      const second = await saveRecord({ id, name: 'Doc', text: 'a b c d e' })
      expect(second.success).toBe(true)
      const metas = await listMetas()
      expect(metas).toHaveLength(1)
      expect(metas[0].wordCount).toBe(5)
    })

    it('persists a catalog source and round-trips it through the index', async () => {
      const result = await saveRecord({
        name: 'Catalog Work',
        text: 'a b c',
        source: { provider: 'aozora', workId: '001257/files/59898_ruby_70679.zip' },
      })
      expect(result.success).toBe(true)
      expect(result.data?.source).toEqual({ provider: 'aozora', workId: '001257/files/59898_ruby_70679.zip' })

      const metas = await listMetas()
      expect(metas[0].source).toEqual({ provider: 'aozora', workId: '001257/files/59898_ruby_70679.zip' })
    })

    it('leaves source unset for a plain file-import-style save', async () => {
      const result = await saveRecord({ name: 'Plain', text: 'a b c' })
      expect(result.success).toBe(true)
      expect(result.data?.source).toBeUndefined()

      const metas = await listMetas()
      expect(metas[0].source).toBeUndefined()
    })
  })

  describe('index source validation', () => {
    it('drops a malformed source (non-string workId) instead of crashing', async () => {
      await saveRecord({ name: 'Corrupt', text: 'a b c' })
      const indexPath = join(mockUserDataPath, 'sync', TYPING_TEST_TEXT_SYNC_UNIT, 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8')) as { entries: Record<string, unknown>[] }
      index.entries[0].source = { provider: 'aozora', workId: 12345 }
      await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8')

      const metas = await listMetas()
      expect(metas).toHaveLength(1)
      expect(metas[0].source).toBeUndefined()
    })

    it('drops a non-object source', async () => {
      await saveRecord({ name: 'Corrupt2', text: 'a b c' })
      const indexPath = join(mockUserDataPath, 'sync', TYPING_TEST_TEXT_SYNC_UNIT, 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8')) as { entries: Record<string, unknown>[] }
      index.entries[0].source = 'aozora'
      await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8')

      const metas = await listMetas()
      expect(metas[0].source).toBeUndefined()
    })
  })

  describe('getRecord', () => {
    it('returns stored text joined back from words, keeping leading indentation', async () => {
      const saved = await saveRecord({ name: 'Read', text: '  hello   world  ' })
      const rec = await getRecord(saved.data!.id)
      expect(rec.success).toBe(true)
      // Intra-line whitespace collapses, trailing drops, leading indent stays.
      expect(rec.data?.data.text).toBe('  hello world')
    })

    it('NOT_FOUND for unknown id', async () => {
      const rec = await getRecord('nope')
      expect(rec.success).toBe(false)
      expect(rec.errorCode).toBe('NOT_FOUND')
    })

    it('preserves line breaks: stored text keeps newlines distinct from spaces', async () => {
      const saved = await saveRecord({ name: 'Multi', text: 'the quick brown\nfox jumps\n\nover' })
      expect(saved.data?.wordCount).toBe(6)
      const rec = await getRecord(saved.data!.id)
      // Single spaces within a line, a newline at each line break, blank line dropped.
      expect(rec.data?.data.text).toBe('the quick brown\nfox jumps\nover')
    })
  })

  describe('renameRecord', () => {
    it('renames and bumps updatedAt', async () => {
      const saved = await saveRecord({ name: 'Old', text: 'x y z' })
      const renamed = await renameRecord(saved.data!.id, 'New')
      expect(renamed.success).toBe(true)
      expect(renamed.data?.name).toBe('New')
      const rec = await getRecord(saved.data!.id)
      expect(rec.data?.data.name).toBe('New')
    })

    it('rejects duplicate name on rename', async () => {
      await saveRecord({ name: 'A', text: 'a' })
      const b = await saveRecord({ name: 'B', text: 'b' })
      const result = await renameRecord(b.data!.id, 'A')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('DUPLICATE_NAME')
    })
  })

  describe('deleteRecord', () => {
    it('soft-deletes: hidden from listMetas, present in listAllMetas as tombstone', async () => {
      const saved = await saveRecord({ name: 'Gone', text: 'bye' })
      const del = await deleteRecord(saved.data!.id)
      expect(del.success).toBe(true)
      expect(await listMetas()).toHaveLength(0)
      const all = await listAllMetas()
      expect(all).toHaveLength(1)
      expect(all[0].deletedAt).toBeTruthy()
    })

    it('frees the name for reuse after delete', async () => {
      const saved = await saveRecord({ name: 'Reuse', text: 'one' })
      await deleteRecord(saved.data!.id)
      expect(await hasActiveName('Reuse')).toBe(false)
      const again = await saveRecord({ name: 'Reuse', text: 'two' })
      expect(again.success).toBe(true)
    })
  })

  describe('importFromDialog', () => {
    it('imports a .txt file using the base name as the entry name', async () => {
      const filePath = join(mockUserDataPath, 'poem.txt')
      await writeFile(filePath, 'roses are red', 'utf-8')
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

      const result = await importFromDialog(fakeWin)
      expect(result.success).toBe(true)
      expect(result.data?.name).toBe('poem')
      expect(result.data?.wordCount).toBe(3)
    })

    it('returns cancelled when the dialog is dismissed', async () => {
      showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
      const result = await importFromDialog(fakeWin)
      expect(result.success).toBe(false)
      expect(result.error).toBe('cancelled')
    })

    it('rejects a non-UTF-8 (e.g. Shift-JIS) file with NOT_UTF8', async () => {
      const filePath = join(mockUserDataPath, 'sjis.txt')
      // Shift-JIS bytes for "あい" — invalid as UTF-8.
      await writeFile(filePath, Buffer.from([0x82, 0xA0, 0x82, 0xA2]))
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

      const result = await importFromDialog(fakeWin)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('NOT_UTF8')
    })

    it('accepts a UTF-8 file with a BOM (BOM stripped)', async () => {
      const filePath = join(mockUserDataPath, 'bom.txt')
      await writeFile(filePath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('hello world', 'utf-8')]))
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

      const result = await importFromDialog(fakeWin)
      expect(result.success).toBe(true)
      expect(result.data?.wordCount).toBe(2)
      const rec = await getRecord(result.data!.id)
      expect(rec.data?.data.text).toBe('hello world')
    })

    it('rejects files over the size limit', async () => {
      const filePath = join(mockUserDataPath, 'big.txt')
      // 5 MB + 1 byte of ASCII (over TYPING_TEST_TEXT_MAX_FILE_BYTES)
      await writeFile(filePath, 'a'.repeat(5 * 1024 * 1024 + 1), 'utf-8')
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })

      const result = await importFromDialog(fakeWin)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('TOO_LARGE')
    })

    it('re-import of an existing name asks to confirm, then overwrites in place', async () => {
      const filePath = join(mockUserDataPath, 'doc.txt')
      await writeFile(filePath, 'one two', 'utf-8')
      showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [filePath] })
      const first = await importFromDialog(fakeWin)

      await writeFile(filePath, 'one two three four', 'utf-8')
      // Collision: held for confirmation, nothing saved yet.
      const second = await importFromDialog(fakeWin)
      expect(second.success).toBe(false)
      expect(second.errorCode).toBe('DUPLICATE_NAME')
      expect(second.error).toBe('doc')
      expect((await listMetas())[0].wordCount).toBe(2)

      // Confirm → overwrites the same entry in place.
      const confirmed = await confirmImportOverwrite()
      expect(confirmed.success).toBe(true)
      expect(confirmed.data?.id).toBe(first.data?.id)
      const metas = await listMetas()
      expect(metas).toHaveLength(1)
      expect(metas[0].wordCount).toBe(4)
    })

    it('confirmImportOverwrite without a pending import fails', async () => {
      const result = await confirmImportOverwrite()
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('NOT_FOUND')
    })
  })

  it('persists index.json under sync/typing-test-texts', async () => {
    await saveRecord({ name: 'Persist', text: 'check disk' })
    const raw = await readFile(join(mockUserDataPath, 'sync', TYPING_TEST_TEXT_SYNC_UNIT, 'index.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { entries: unknown[] }
    expect(parsed.entries).toHaveLength(1)
  })
})
