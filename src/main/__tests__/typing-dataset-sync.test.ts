// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

vi.mock('electron', () => {
  const app = { getPath: vi.fn() }
  const ipcMain = { handle: vi.fn() }
  const net = { fetch: vi.fn() }
  return { app, ipcMain, net }
})
vi.mock('../logger', () => ({ log: vi.fn() }))
vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

const HUB_VERSION = 'newcommit0000000000000000000000000000000'
const NEW_DOWNLOAD_BASE = 'https://hub.example/languages'

let testDir: string
let mod: typeof import('../language-store')
let mockNet: { fetch: ReturnType<typeof vi.fn> }

function okJson(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ ok: true, data }) }
}

beforeEach(async () => {
  vi.resetModules()
  testDir = join(tmpdir(), `tt-dataset-sync-${Date.now()}-${Math.round(performance.now())}`)
  await mkdir(join(testDir, 'local', 'downloads', 'languages'), { recursive: true })

  const electron = await import('electron')
  vi.mocked(electron.app).getPath.mockReturnValue(testDir)
  mockNet = vi.mocked(electron.net) as unknown as { fetch: ReturnType<typeof vi.fn> }
  mod = await import('../language-store')
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

function overridePath(): string {
  return join(testDir, 'local', 'typing-test-dataset.json')
}

describe('checkTypingDatasetUpdate', () => {
  it('reports an update when the Hub version differs, then caches it for the session', async () => {
    mockNet.fetch.mockResolvedValue(okJson({ provider: 'monkeytype', version: HUB_VERSION }))
    const first = await mod.checkTypingDatasetUpdate('monkeytype')
    expect(first.updateAvailable).toBe(true)
    expect(mockNet.fetch).toHaveBeenCalledTimes(1)

    // Second call within the session must not re-hit the Hub.
    mockNet.fetch.mockRejectedValue(new Error('should not be called'))
    const second = await mod.checkTypingDatasetUpdate('monkeytype')
    expect(second.updateAvailable).toBe(true)
    expect(mockNet.fetch).toHaveBeenCalledTimes(1)
  })

  it('reports no update when the Hub version matches', async () => {
    const { TYPING_TEST_PROVIDER_DEFAULTS } = await import('../../shared/data/typing-test-providers')
    mockNet.fetch.mockResolvedValue(okJson({ provider: 'monkeytype', version: TYPING_TEST_PROVIDER_DEFAULTS[0].version }))
    expect((await mod.checkTypingDatasetUpdate('monkeytype')).updateAvailable).toBe(false)
  })

  it('does not cache a Hub error, so a later check can retry', async () => {
    mockNet.fetch.mockRejectedValueOnce(new Error('offline'))
    expect((await mod.checkTypingDatasetUpdate('monkeytype')).updateAvailable).toBe(false)
    // Now the Hub is reachable and reports a newer version.
    mockNet.fetch.mockResolvedValue(okJson({ provider: 'monkeytype', version: HUB_VERSION }))
    expect((await mod.checkTypingDatasetUpdate('monkeytype')).updateAvailable).toBe(true)
  })

  it('clears the pending flag once an update is applied', async () => {
    mockNet.fetch
      .mockResolvedValueOnce(okJson({ provider: 'monkeytype', version: HUB_VERSION }))
      .mockResolvedValueOnce(okJson({
        provider: 'monkeytype',
        version: HUB_VERSION,
        downloadUrlBase: NEW_DOWNLOAD_BASE,
        languages: [{ name: 'english', wordCount: 200, rightToLeft: false, fileSize: 2540 }],
      }))
    await mod.syncTypingDataset('monkeytype')
    expect((await mod.checkTypingDatasetUpdate('monkeytype')).updateAvailable).toBe(false)
  })
})

describe('syncTypingDataset', () => {
  it('does nothing when the Hub version matches the current version', async () => {
    // Hub returns the SAME version as the bundled default → no fetch of full
    // dataset, no override file written.
    const { TYPING_TEST_PROVIDER_DEFAULTS } = await import('../../shared/data/typing-test-providers')
    const currentVersion = TYPING_TEST_PROVIDER_DEFAULTS[0].version
    mockNet.fetch.mockResolvedValue(okJson({ provider: 'monkeytype', version: currentVersion }))

    const result = await mod.syncTypingDataset('monkeytype')

    expect(result.changed).toBe(false)
    await expect(readFile(overridePath(), 'utf-8')).rejects.toThrow()
  })

  it('writes an override and clears downloads when the Hub version differs', async () => {
    // Seed a stale downloaded file (under the provider's dir) that must be
    // cleared on a version bump.
    await mkdir(join(testDir, 'local', 'downloads', 'languages', 'monkeytype'), { recursive: true })
    await writeFile(join(testDir, 'local', 'downloads', 'languages', 'monkeytype', 'german.json'), '{}', 'utf-8')

    const freshDataset = {
      provider: 'monkeytype',
      version: HUB_VERSION,
      downloadUrlBase: NEW_DOWNLOAD_BASE,
      languages: [
        { name: 'english', wordCount: 200, rightToLeft: false, fileSize: 2540 },
        { name: 'spanish', wordCount: 500, rightToLeft: false, fileSize: 9000 },
      ],
    }
    // First call = /version probe, second = full dataset.
    mockNet.fetch
      .mockResolvedValueOnce(okJson({ provider: 'monkeytype', version: HUB_VERSION }))
      .mockResolvedValueOnce(okJson(freshDataset))

    const result = await mod.syncTypingDataset('monkeytype')

    expect(result.changed).toBe(true)
    expect(result.toVersion).toBe(HUB_VERSION)

    // Override persisted verbatim.
    const written = JSON.parse(await readFile(overridePath(), 'utf-8')) as Record<string, typeof freshDataset>
    expect(written.monkeytype).toEqual(freshDataset)

    // Stale download removed.
    const remaining = await readdir(join(testDir, 'local', 'downloads', 'languages', 'monkeytype'))
    expect(remaining).not.toContain('german.json')
  })

  it('returns changed:false when the Hub is unreachable', async () => {
    mockNet.fetch.mockRejectedValue(new Error('offline'))
    const result = await mod.syncTypingDataset('monkeytype')
    expect(result.changed).toBe(false)
    await expect(readFile(overridePath(), 'utf-8')).rejects.toThrow()
  })
})

describe('effective dataset after override', () => {
  it('LANG_LIST and LANG_DOWNLOAD use the overridden manifest + URL', async () => {
    const freshDataset = {
      provider: 'monkeytype',
      version: HUB_VERSION,
      downloadUrlBase: NEW_DOWNLOAD_BASE,
      languages: [{ name: 'spanish', wordCount: 500, rightToLeft: false, fileSize: 4 }],
    }
    mockNet.fetch
      .mockResolvedValueOnce(okJson({ provider: 'monkeytype', version: HUB_VERSION }))
      .mockResolvedValueOnce(okJson(freshDataset))
    await mod.syncTypingDataset('monkeytype')

    // Register IPC handlers and capture them.
    const electron = await import('electron')
    const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>()
    vi.mocked(electron.ipcMain).handle.mockImplementation(((c: string, h: (...a: unknown[]) => Promise<unknown>) => {
      handlers.set(c, h)
    }) as unknown as typeof electron.ipcMain.handle)
    mod.setupLanguageStore()

    const list = await handlers.get('lang:list')!({}) as Array<{ name: string }>
    expect(list.map((l) => l.name)).toEqual(['spanish'])

    // Download must hit the overridden base URL, not the bundled default.
    mockNet.fetch.mockReset()
    mockNet.fetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('xxxx').buffer),
    } as unknown as Response)
    await handlers.get('lang:download')!({}, 'spanish')
    expect(mockNet.fetch).toHaveBeenCalledWith(`${NEW_DOWNLOAD_BASE}/spanish.json`)
  })
})

describe('tatoeba Hub-only provider', () => {
  const TATOEBA_VERSION = 'tatoeba-20260701-8e31452a1d44'
  const TATOEBA_BASE = 'https://hub.example/datasets/tatoeba/packs'

  function captureHandlers() {
    return import('electron').then(({ ipcMain }) => {
      const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>()
      vi.mocked(ipcMain).handle.mockImplementation(((c: string, h: (...a: unknown[]) => Promise<unknown>) => {
        handlers.set(c, h)
      }) as unknown as typeof ipcMain.handle)
      mod.setupLanguageStore()
      return handlers
    })
  }

  it('lists nothing before a Hub override (nothing is bundled)', async () => {
    const handlers = await captureHandlers()
    const list = await handlers.get('lang:list')!({}, 'tatoeba') as unknown[]
    expect(list).toEqual([])
  })

  it('after an override, lists + downloads packs into a provider-isolated dir', async () => {
    // A tatoeba pack is a verbatim `{ name, words }` document of sentences.
    const packText = JSON.stringify({ name: 'english', words: ['Hello there.', 'How are you?'] })
    const fresh = {
      provider: 'tatoeba',
      version: TATOEBA_VERSION,
      downloadUrlBase: TATOEBA_BASE,
      languages: [{ name: 'english', wordCount: 2, rightToLeft: false, fileSize: Buffer.byteLength(packText, 'utf-8') }],
    }
    mockNet.fetch
      .mockResolvedValueOnce(okJson({ provider: 'tatoeba', version: TATOEBA_VERSION }))
      .mockResolvedValueOnce(okJson(fresh))
    expect((await mod.syncTypingDataset('tatoeba')).changed).toBe(true)

    const handlers = await captureHandlers()
    const list = await handlers.get('lang:list')!({}, 'tatoeba') as Array<{ name: string }>
    expect(list.map((l) => l.name)).toEqual(['english'])

    // Pack download hits the tatoeba packs URL and lands in the tatoeba dir,
    // never colliding with monkeytype's own 'english'.
    mockNet.fetch.mockReset()
    mockNet.fetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(packText).buffer),
    } as unknown as Response)
    const dl = await handlers.get('lang:download')!({}, 'english', 'tatoeba') as { success: boolean }
    expect(dl.success).toBe(true)
    expect(mockNet.fetch).toHaveBeenCalledWith(`${TATOEBA_BASE}/english.json`)
    const files = await readdir(join(testDir, 'local', 'downloads', 'languages', 'tatoeba'))
    expect(files).toContain('english.json')
  })
})

describe('aozora catalog provider', () => {
  const AOZORA_VERSION = 'aozora-8e31452a1d44'
  const AOZORA_BASE = 'https://hub.example/aozora/cards'
  const catalogDataset = {
    provider: 'aozora',
    version: AOZORA_VERSION,
    downloadUrlBase: AOZORA_BASE,
    model: 'catalog' as const,
    languages: [
      {
        name: '001257/files/59898_ruby_70679.zip',
        title: 'ウェストミンスター寺院',
        author: 'アーヴィング ワシントン（訳: 吉田 甲子太郎）',
        wordCount: 9666,
        rightToLeft: false,
        fileSize: 12553,
      },
    ],
  }

  it('getProviderDefault returns the aozora catalog placeholder', async () => {
    const { getProviderDefault } = await import('../../shared/data/typing-test-providers')
    const def = getProviderDefault('aozora')
    expect(def).toBeDefined()
    expect(def?.model).toBe('catalog')
    expect(def?.version).toBe('')
    expect(def?.downloadUrlBase).toBe('')
    expect(def?.bundledLanguages).toEqual([])
    expect(def?.languages).toEqual([])
  })

  it('lists nothing before a Hub override (nothing is bundled)', async () => {
    const electron = await import('electron')
    const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>()
    vi.mocked(electron.ipcMain).handle.mockImplementation(((c: string, h: (...a: unknown[]) => Promise<unknown>) => {
      handlers.set(c, h)
    }) as unknown as typeof electron.ipcMain.handle)
    mod.setupLanguageStore()
    const list = await handlers.get('lang:list')!({}, 'aozora') as unknown[]
    expect(list).toEqual([])
  })

  it('a catalog override with model + title/author round-trips through LANG_LIST', async () => {
    mockNet.fetch
      .mockResolvedValueOnce(okJson({ provider: 'aozora', version: AOZORA_VERSION }))
      .mockResolvedValueOnce(okJson(catalogDataset))
    const sync = await mod.syncTypingDataset('aozora')
    expect(sync.changed).toBe(true)

    // Persisted verbatim, including `model`.
    const written = JSON.parse(await readFile(overridePath(), 'utf-8')) as Record<string, typeof catalogDataset>
    expect(written.aozora).toEqual(catalogDataset)

    const electron = await import('electron')
    const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>()
    vi.mocked(electron.ipcMain).handle.mockImplementation(((c: string, h: (...a: unknown[]) => Promise<unknown>) => {
      handlers.set(c, h)
    }) as unknown as typeof electron.ipcMain.handle)
    mod.setupLanguageStore()

    const list = await handlers.get('lang:list')!({}, 'aozora') as Array<{ name: string; title?: string; author?: string }>
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('001257/files/59898_ruby_70679.zip')
    expect(list[0].title).toBe('ウェストミンスター寺院')
    expect(list[0].author).toBe('アーヴィング ワシントン（訳: 吉田 甲子太郎）')
  })

  it('LANG_DOWNLOAD fails closed for a catalog-model dataset (no fetch attempted)', async () => {
    // A synthetic no-slash entry name isolates the `model` check from the
    // pre-existing (coincidental) rejection of `/`-bearing names — real
    // Aozora workIds are ZIP paths and would already be blocked by that
    // check before ever reaching the model check this test targets.
    const override = {
      aozora: {
        provider: 'aozora',
        version: AOZORA_VERSION,
        downloadUrlBase: AOZORA_BASE,
        model: 'catalog' as const,
        languages: [{ name: 'sample-work', wordCount: 100, rightToLeft: false, fileSize: 10 }],
      },
    }
    await writeFile(overridePath(), JSON.stringify(override), 'utf-8')

    const electron = await import('electron')
    const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>()
    vi.mocked(electron.ipcMain).handle.mockImplementation(((c: string, h: (...a: unknown[]) => Promise<unknown>) => {
      handlers.set(c, h)
    }) as unknown as typeof electron.ipcMain.handle)
    mod.setupLanguageStore()

    const result = await handlers.get('lang:download')!(
      {}, 'sample-work', 'aozora',
    ) as { success: boolean; error?: string }

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/catalog/i)
    expect(mockNet.fetch).not.toHaveBeenCalled()
  })

  it('a legacy override without `model` (predating the field) still validates', async () => {
    // Simulate a pre-existing persisted override that predates the `model`
    // field entirely — must still be treated as valid (implicitly 'pack').
    const legacyOverride = {
      monkeytype: {
        provider: 'monkeytype',
        version: 'legacy-version',
        downloadUrlBase: 'https://hub.example/legacy',
        languages: [{ name: 'english', wordCount: 100, rightToLeft: false, fileSize: 42 }],
      },
    }
    await writeFile(overridePath(), JSON.stringify(legacyOverride), 'utf-8')

    const electron = await import('electron')
    const handlers = new Map<string, (...a: unknown[]) => Promise<unknown>>()
    vi.mocked(electron.ipcMain).handle.mockImplementation(((c: string, h: (...a: unknown[]) => Promise<unknown>) => {
      handlers.set(c, h)
    }) as unknown as typeof electron.ipcMain.handle)
    mod.setupLanguageStore()

    const list = await handlers.get('lang:list')!({}, 'monkeytype') as Array<{ name: string }>
    expect(list.map((l) => l.name)).toEqual(['english'])
  })

  it('an aozora override without `model` falls back to the provider default (catalog), not pack', async () => {
    // A persisted override that predates the `model` field (or a Hub payload
    // that omitted it) must not be treated as pack-shaped for a catalog-only
    // provider — that would fail every import closed.
    const override = {
      aozora: {
        provider: 'aozora',
        version: AOZORA_VERSION,
        downloadUrlBase: AOZORA_BASE,
        languages: catalogDataset.languages,
      },
    }
    await writeFile(overridePath(), JSON.stringify(override), 'utf-8')

    const effective = await mod.getEffectiveDataset('aozora')
    expect(effective.model).toBe('catalog')
  })

  it('a Hub payload with an invalid `model` value is rejected end-to-end (no override written)', async () => {
    mockNet.fetch
      .mockResolvedValueOnce(okJson({ provider: 'aozora', version: AOZORA_VERSION }))
      .mockResolvedValueOnce(okJson({ ...catalogDataset, model: 'bogus' }))

    const result = await mod.syncTypingDataset('aozora')

    expect(result.changed).toBe(false)
    await expect(readFile(overridePath(), 'utf-8')).rejects.toThrow()
  })
})
