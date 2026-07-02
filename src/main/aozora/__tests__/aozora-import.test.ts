// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { zipSync } from 'fflate'

vi.mock('electron', () => {
  const net = { fetch: vi.fn() }
  return { net }
})
vi.mock('../../logger', () => ({ log: vi.fn() }))
vi.mock('../../language-store', () => ({ getEffectiveDataset: vi.fn() }))
vi.mock('../../typing-test-text-store', () => ({ saveRecord: vi.fn() }))

import { net } from 'electron'
import { getEffectiveDataset } from '../../language-store'
import { saveRecord } from '../../typing-test-text-store'
import { importAozoraWork } from '../aozora-import'

const mockFetch = vi.mocked(net.fetch)
const mockGetDataset = vi.mocked(getEffectiveDataset)
const mockSaveRecord = vi.mocked(saveRecord)

const WORK_ID = '001257/files/59898_ruby_70679.zip'
const DOWNLOAD_BASE = 'https://hub.example/aozora/cards'

interface FixtureEntry {
  name: string
  title?: string
  author?: string
  wordCount: number
  rightToLeft: boolean
  fileSize: number
}

function datasetWith(entry: FixtureEntry | null) {
  return {
    provider: 'aozora',
    version: 'aozora-test',
    downloadUrlBase: DOWNLOAD_BASE,
    model: 'catalog' as const,
    languages: entry ? [entry] : [],
  }
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function okResponse(bytes: Uint8Array) {
  return { ok: true, status: 200, arrayBuffer: () => Promise.resolve(arrayBufferOf(bytes)) } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('importAozoraWork', () => {
  it('downloads, unzips, decodes, cleans and saves a work (happy path)', async () => {
    // A leading blank line keeps removeHeader() a no-op, so the fixture
    // doesn't need a full title/author/colophon structure (that pipeline is
    // covered by aozora-clean.test.ts) — this test only needs the whole
    // importer pipeline to hand a non-empty, correctly decoded string to
    // saveRecord.
    const sjisBytes = new Uint8Array([
      ...Buffer.from('\nSample text about ', 'ascii'),
      0x90, 0xC2, 0x8B, 0xF3, // 青空
      ...Buffer.from(' library used for testing.\n', 'ascii'),
    ])
    const zipBytes = zipSync({ 'work.txt': sjisBytes })

    mockGetDataset.mockResolvedValue(datasetWith({
      name: WORK_ID,
      title: 'サンプル作品',
      author: '青空太郎',
      wordCount: 10,
      rightToLeft: false,
      fileSize: zipBytes.byteLength,
    }))
    mockFetch.mockResolvedValue(okResponse(zipBytes))
    const savedMeta = {
      id: 'abc',
      name: 'サンプル作品（青空太郎）',
      wordCount: 8,
      filename: 'abc.json',
      savedAt: 'x',
      updatedAt: 'x',
      source: { provider: 'aozora', workId: WORK_ID },
    }
    mockSaveRecord.mockResolvedValue({ success: true, data: savedMeta })

    const result = await importAozoraWork(WORK_ID)

    expect(mockFetch).toHaveBeenCalledWith(`${DOWNLOAD_BASE}/${WORK_ID}`)
    expect(mockSaveRecord).toHaveBeenCalledWith({
      name: 'サンプル作品（青空太郎）',
      text: 'Sample text about 青空 library used for testing.',
      source: { provider: 'aozora', workId: WORK_ID },
    })
    expect(result).toEqual({ success: true, meta: savedMeta })
  })

  it('fails with NOT_IN_CATALOG when the work is not in the manifest', async () => {
    mockGetDataset.mockResolvedValue(datasetWith(null))

    const result = await importAozoraWork(WORK_ID)

    expect(result).toEqual({ success: false, errorCode: 'NOT_IN_CATALOG', error: expect.any(String) })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fails with NOT_IN_CATALOG when the effective aozora dataset is not catalog-shaped', async () => {
    mockGetDataset.mockResolvedValue({
      provider: 'aozora',
      version: 'aozora-test',
      downloadUrlBase: DOWNLOAD_BASE,
      model: 'pack' as const,
      languages: [{ name: WORK_ID, wordCount: 10, rightToLeft: false, fileSize: 10 }],
    })

    const result = await importAozoraWork(WORK_ID)

    expect(result).toEqual({ success: false, errorCode: 'NOT_IN_CATALOG', error: expect.any(String) })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fails with DOWNLOAD_FAILED on a non-OK HTTP response', async () => {
    mockGetDataset.mockResolvedValue(datasetWith({ name: WORK_ID, wordCount: 1, rightToLeft: false, fileSize: 10 }))
    mockFetch.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)

    const result = await importAozoraWork(WORK_ID)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.errorCode).toBe('DOWNLOAD_FAILED')
    expect(mockSaveRecord).not.toHaveBeenCalled()
  })

  it('fails with SIZE_MISMATCH when the downloaded byte length differs from the manifest', async () => {
    const zipBytes = zipSync({ 'work.txt': new Uint8Array(Buffer.from('hello', 'ascii')) })
    mockGetDataset.mockResolvedValue(datasetWith({
      name: WORK_ID, wordCount: 1, rightToLeft: false, fileSize: zipBytes.byteLength + 1,
    }))
    mockFetch.mockResolvedValue(okResponse(zipBytes))

    const result = await importAozoraWork(WORK_ID)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.errorCode).toBe('SIZE_MISMATCH')
    expect(mockSaveRecord).not.toHaveBeenCalled()
  })

  it('fails with NO_TEXT_ENTRY when the zip has no usable .txt entry (only .png / __MACOSX)', async () => {
    const zipBytes = zipSync({
      'image.png': new Uint8Array([1, 2, 3]),
      '__MACOSX/work.txt': new Uint8Array([4, 5, 6]),
    })
    mockGetDataset.mockResolvedValue(datasetWith({ name: WORK_ID, wordCount: 1, rightToLeft: false, fileSize: zipBytes.byteLength }))
    mockFetch.mockResolvedValue(okResponse(zipBytes))

    const result = await importAozoraWork(WORK_ID)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.errorCode).toBe('NO_TEXT_ENTRY')
    expect(mockSaveRecord).not.toHaveBeenCalled()
  })

  it('fails with DECODE_FAILED when the Shift_JIS decode yields excessive replacement characters', async () => {
    // 0x80 is an undefined single-byte lead in Shift_JIS, so every byte
    // decodes to U+FFFD — well past the 0.5% threshold.
    const garbage = new Uint8Array(100).fill(0x80)
    const zipBytes = zipSync({ 'work.txt': garbage })
    mockGetDataset.mockResolvedValue(datasetWith({ name: WORK_ID, wordCount: 1, rightToLeft: false, fileSize: zipBytes.byteLength }))
    mockFetch.mockResolvedValue(okResponse(zipBytes))

    const result = await importAozoraWork(WORK_ID)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.errorCode).toBe('DECODE_FAILED')
    expect(mockSaveRecord).not.toHaveBeenCalled()
  })

  it('fails with EMPTY_TEXT when the cleaned text is empty', async () => {
    // A single non-blank line with nothing after it is entirely consumed by
    // removeHeader() as the title/author block, leaving nothing behind.
    const raw = new Uint8Array(Buffer.from('OnlyTitleLine', 'ascii'))
    const zipBytes = zipSync({ 'work.txt': raw })
    mockGetDataset.mockResolvedValue(datasetWith({ name: WORK_ID, wordCount: 1, rightToLeft: false, fileSize: zipBytes.byteLength }))
    mockFetch.mockResolvedValue(okResponse(zipBytes))

    const result = await importAozoraWork(WORK_ID)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.errorCode).toBe('EMPTY_TEXT')
    expect(mockSaveRecord).not.toHaveBeenCalled()
  })

  it('passes through a DUPLICATE_NAME failure from the text store unchanged', async () => {
    const sjisBytes = new Uint8Array(Buffer.from('\nHello duplicate work content.\n', 'ascii'))
    const zipBytes = zipSync({ 'work.txt': sjisBytes })
    mockGetDataset.mockResolvedValue(datasetWith({ name: WORK_ID, title: 'Dup', wordCount: 1, rightToLeft: false, fileSize: zipBytes.byteLength }))
    mockFetch.mockResolvedValue(okResponse(zipBytes))
    mockSaveRecord.mockResolvedValue({ success: false, errorCode: 'DUPLICATE_NAME', error: 'A text with the same name already exists' })

    const result = await importAozoraWork(WORK_ID)

    expect(result).toEqual({ success: false, errorCode: 'DUPLICATE_NAME', error: 'A text with the same name already exists' })
  })
})
