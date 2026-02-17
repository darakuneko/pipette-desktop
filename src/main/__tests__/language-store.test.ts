// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// vi.mock is hoisted — factory cannot reference variables defined later
vi.mock('electron', () => {
  const app = { getPath: vi.fn() }
  const ipcMain = { handle: vi.fn() }
  const net = { fetch: vi.fn() }
  return { app, ipcMain, net }
})
vi.mock('../logger', () => ({
  log: vi.fn(),
}))

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

// Import after mocking
import { app, ipcMain, net } from 'electron'
import { setupLanguageStore } from '../language-store'
import type { LanguageManifestEntry } from '../../shared/types/language-store'
import manifest from '../../shared/data/language-manifest.json'

const mockApp = vi.mocked(app)
const mockIpcMain = vi.mocked(ipcMain)
const mockNet = vi.mocked(net)

let testDir: string
let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>

beforeEach(async () => {
  testDir = join(tmpdir(), `lang-store-test-${Date.now()}`)
  await mkdir(testDir, { recursive: true })
  mockApp.getPath.mockReturnValue(testDir)

  handlers = new Map()
  mockIpcMain.handle.mockImplementation(((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    handlers.set(channel, handler)
  }) as unknown as typeof ipcMain.handle)

  setupLanguageStore()
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return handler({}, ...args)
}

describe('language-store list', () => {
  it('returns manifest entries with status', async () => {
    const result = await invoke('lang:list') as Array<{ name: string; status: string }>

    expect(result.length).toBeGreaterThan(0)
    const english = result.find((e) => e.name === 'english')
    expect(english).toBeDefined()
    expect(english!.status).toBe('bundled')

    const german = result.find((e) => e.name === 'german')
    expect(german).toBeDefined()
    expect(german!.status).toBe('not-downloaded')
  })

  it('detects downloaded languages', async () => {
    const langDir = join(testDir, 'local', 'downloads', 'languages')
    await mkdir(langDir, { recursive: true })
    await writeFile(join(langDir, 'german.json'), JSON.stringify({ name: 'german', words: ['hallo'] }))

    const result = await invoke('lang:list') as Array<{ name: string; status: string }>
    const german = result.find((e) => e.name === 'german')
    expect(german).toBeDefined()
    expect(german!.status).toBe('downloaded')
  })
})

describe('language-store get', () => {
  it('returns null for bundled language (english)', async () => {
    const result = await invoke('lang:get', 'english')
    expect(result).toBeNull()
  })

  it('returns null for non-existent language', async () => {
    const result = await invoke('lang:get', 'nonexistent')
    expect(result).toBeNull()
  })

  it('returns language data for downloaded language', async () => {
    const langDir = join(testDir, 'local', 'downloads', 'languages')
    await mkdir(langDir, { recursive: true })
    const data = { name: 'test_lang', words: ['hello', 'world'], rightToLeft: false }
    await writeFile(join(langDir, 'test_lang.json'), JSON.stringify(data))

    const result = await invoke('lang:get', 'test_lang') as { name: string; words: string[] }
    expect(result).not.toBeNull()
    expect(result.name).toBe('test_lang')
    expect(result.words).toEqual(['hello', 'world'])
  })

  it('rejects path traversal', async () => {
    const result = await invoke('lang:get', '../etc/passwd')
    expect(result).toBeNull()
  })

  it('rejects names with slashes', async () => {
    const result = await invoke('lang:get', 'foo/bar')
    expect(result).toBeNull()
  })

  it('returns null for invalid JSON', async () => {
    const langDir = join(testDir, 'local', 'downloads', 'languages')
    await mkdir(langDir, { recursive: true })
    await writeFile(join(langDir, 'bad.json'), 'not json')

    const result = await invoke('lang:get', 'bad')
    expect(result).toBeNull()
  })

  it('returns null for data missing words array', async () => {
    const langDir = join(testDir, 'local', 'downloads', 'languages')
    await mkdir(langDir, { recursive: true })
    await writeFile(join(langDir, 'nowords.json'), JSON.stringify({ name: 'nowords' }))

    const result = await invoke('lang:get', 'nowords')
    expect(result).toBeNull()
  })
})

/** Pad a string with spaces to reach an exact UTF-8 byte length. */
function padToBytes(str: string, targetBytes: number): string {
  const baseLen = Buffer.byteLength(str, 'utf-8')
  if (targetBytes <= baseLen) return str
  return str + ' '.repeat(targetBytes - baseLen)
}

/** Build a valid language JSON string padded to exact UTF-8 byte length. */
function makeLangPayload(name: string, targetBytes: number): string {
  return padToBytes(JSON.stringify({ name, words: ['a', 'b', 'c'] }), targetBytes)
}

/** Look up fileSize from the real manifest. */
function manifestFileSize(name: string): number {
  const entry = (manifest as LanguageManifestEntry[]).find((e) => e.name === name)
  if (!entry) throw new Error(`No manifest entry for ${name}`)
  return entry.fileSize
}

describe('language-store download', () => {
  it('rejects download of bundled language', async () => {
    const result = await invoke('lang:download', 'english') as { success: boolean }
    expect(result.success).toBe(false)
  })

  it('rejects invalid names', async () => {
    const result = await invoke('lang:download', '../etc/passwd') as { success: boolean }
    expect(result.success).toBe(false)
  })

  it('downloads and saves valid language with matching size', async () => {
    const expected = manifestFileSize('german')
    const langData = makeLangPayload('german', expected)
    mockNet.fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(langData),
    } as unknown as Response)

    const result = await invoke('lang:download', 'german') as { success: boolean }
    expect(result.success).toBe(true)

    const files = await readdir(join(testDir, 'local', 'downloads', 'languages'))
    expect(files).toContain('german.json')
  })

  it('uses commit-pinned URL for downloads', async () => {
    const expected = manifestFileSize('german')
    const langData = makeLangPayload('german', expected)
    mockNet.fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(langData),
    } as unknown as Response)

    await invoke('lang:download', 'german')

    const calledUrl = mockNet.fetch.mock.calls[0]?.[0] as string
    expect(calledUrl).toContain('629c82e112a2db2122c789dc6abe970b82c3f8c5')
    expect(calledUrl).not.toContain('refs/heads/master')
  })

  it('rejects download when file size does not match manifest', async () => {
    const expected = manifestFileSize('german')
    const langData = makeLangPayload('german', expected * 2)
    mockNet.fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(langData),
    } as unknown as Response)

    const result = await invoke('lang:download', 'german') as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toContain('size mismatch')

    // Verify no file was written
    const langDir = join(testDir, 'local', 'downloads', 'languages')
    let files: string[] = []
    try { files = await readdir(langDir) } catch { /* dir may not exist */ }
    expect(files).not.toContain('german.json')
  })

  it('fails on HTTP error', async () => {
    mockNet.fetch.mockResolvedValue({ ok: false, status: 404 } as unknown as Response)

    const result = await invoke('lang:download', 'german') as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toContain('404')
  })

  it('fails on invalid language data', async () => {
    const expected = manifestFileSize('german')
    const padded = padToBytes(JSON.stringify({ name: 'bad' }), expected)
    mockNet.fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(padded),
    } as unknown as Response)

    const result = await invoke('lang:download', 'german') as { success: boolean }
    expect(result.success).toBe(false)
  })

  it('rejects unknown language not in manifest without network call', async () => {
    const result = await invoke('lang:download', 'not_in_manifest') as { success: boolean; error?: string }
    expect(result.success).toBe(false)
    expect(result.error).toBe('Unknown language')
    expect(mockNet.fetch).not.toHaveBeenCalled()
  })
})

describe('language-store delete', () => {
  it('rejects deletion of bundled language', async () => {
    const result = await invoke('lang:delete', 'english') as { success: boolean }
    expect(result.success).toBe(false)
  })

  it('deletes downloaded language', async () => {
    const langDir = join(testDir, 'local', 'downloads', 'languages')
    await mkdir(langDir, { recursive: true })
    await writeFile(join(langDir, 'test.json'), '{}')

    const result = await invoke('lang:delete', 'test') as { success: boolean }
    expect(result.success).toBe(true)

    const files = await readdir(langDir)
    expect(files).not.toContain('test.json')
  })

  it('fails for non-existent file', async () => {
    const result = await invoke('lang:delete', 'nonexistent') as { success: boolean }
    expect(result.success).toBe(false)
  })
})
