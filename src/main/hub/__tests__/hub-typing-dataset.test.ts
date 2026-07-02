// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { net } from 'electron'
import { fetchTypingDatasetVersion, fetchTypingDataset } from '../hub-typing-dataset'

const mockNet = vi.mocked(net)

function okJson(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ ok: true, data }) } as unknown as Response
}

beforeEach(() => {
  mockNet.fetch.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('fetchTypingDatasetVersion', () => {
  it('returns the version string on success', async () => {
    mockNet.fetch.mockResolvedValue(okJson({ provider: 'monkeytype', version: 'abc123' }))
    expect(await fetchTypingDatasetVersion('monkeytype')).toBe('abc123')
    expect(mockNet.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/typing-test/datasets/monkeytype/version'))
  })

  it('returns null on HTTP error', async () => {
    mockNet.fetch.mockResolvedValue({ ok: false, json: () => Promise.resolve({}) } as unknown as Response)
    expect(await fetchTypingDatasetVersion('monkeytype')).toBeNull()
  })

  it('returns null on a network throw', async () => {
    mockNet.fetch.mockRejectedValue(new Error('offline'))
    expect(await fetchTypingDatasetVersion('monkeytype')).toBeNull()
  })

  it('returns null when version is missing from the payload', async () => {
    mockNet.fetch.mockResolvedValue(okJson({ provider: 'monkeytype' }))
    expect(await fetchTypingDatasetVersion('monkeytype')).toBeNull()
  })
})

describe('fetchTypingDataset', () => {
  const validDataset = {
    provider: 'monkeytype',
    version: 'abc123',
    downloadUrlBase: 'https://example.test/languages',
    languages: [{ name: 'english', wordCount: 200, rightToLeft: false, fileSize: 2540 }],
  }

  it('returns the validated dataset on success', async () => {
    mockNet.fetch.mockResolvedValue(okJson(validDataset))
    expect(await fetchTypingDataset('monkeytype')).toEqual(validDataset)
  })

  it('returns null when a language entry is malformed', async () => {
    mockNet.fetch.mockResolvedValue(okJson({ ...validDataset, languages: [{ name: 'x' }] }))
    expect(await fetchTypingDataset('monkeytype')).toBeNull()
  })

  it('returns null when downloadUrlBase is missing', async () => {
    const { downloadUrlBase, ...rest } = validDataset
    void downloadUrlBase
    mockNet.fetch.mockResolvedValue(okJson(rest))
    expect(await fetchTypingDataset('monkeytype')).toBeNull()
  })

  it('returns null on a network throw', async () => {
    mockNet.fetch.mockRejectedValue(new Error('offline'))
    expect(await fetchTypingDataset('monkeytype')).toBeNull()
  })

  it('rejects a non-HTTPS downloadUrlBase (SSRF guard)', async () => {
    mockNet.fetch.mockResolvedValue(okJson({ ...validDataset, downloadUrlBase: 'http://example.test/x' }))
    expect(await fetchTypingDataset('monkeytype')).toBeNull()
  })

  it('rejects a provider mismatch', async () => {
    mockNet.fetch.mockResolvedValue(okJson({ ...validDataset, provider: 'evil' }))
    expect(await fetchTypingDataset('monkeytype')).toBeNull()
  })

  const catalogDataset = {
    provider: 'aozora',
    version: 'aozora-abc123def456',
    downloadUrlBase: 'https://example.test/cards',
    model: 'catalog',
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

  it('passes through a catalog dataset with model + title/author entries', async () => {
    mockNet.fetch.mockResolvedValue(okJson(catalogDataset))
    expect(await fetchTypingDataset('aozora')).toEqual(catalogDataset)
  })

  it('accepts a dataset payload with no model field (defaults to pack)', async () => {
    mockNet.fetch.mockResolvedValue(okJson(validDataset))
    const result = await fetchTypingDataset('monkeytype')
    expect(result).not.toBeNull()
    expect(result?.model).toBeUndefined()
  })

  it('rejects a dataset payload with an invalid model value', async () => {
    mockNet.fetch.mockResolvedValue(okJson({ ...catalogDataset, model: 'bogus' }))
    expect(await fetchTypingDataset('aozora')).toBeNull()
  })

  it('rejects a language entry with a non-string title', async () => {
    mockNet.fetch.mockResolvedValue(okJson({
      ...catalogDataset,
      languages: [{ ...catalogDataset.languages[0], title: 123 }],
    }))
    expect(await fetchTypingDataset('aozora')).toBeNull()
  })

  it('rejects a language entry with a non-string author', async () => {
    mockNet.fetch.mockResolvedValue(okJson({
      ...catalogDataset,
      languages: [{ ...catalogDataset.languages[0], author: 123 }],
    }))
    expect(await fetchTypingDataset('aozora')).toBeNull()
  })

  it('passes through a language entry carrying authorKana', async () => {
    const withKana = {
      ...catalogDataset,
      languages: [{ ...catalogDataset.languages[0], authorKana: 'アーヴィング ワシントン' }],
    }
    mockNet.fetch.mockResolvedValue(okJson(withKana))
    expect(await fetchTypingDataset('aozora')).toEqual(withKana)
  })

  it('rejects a language entry with a non-string authorKana', async () => {
    mockNet.fetch.mockResolvedValue(okJson({
      ...catalogDataset,
      languages: [{ ...catalogDataset.languages[0], authorKana: 123 }],
    }))
    expect(await fetchTypingDataset('aozora')).toBeNull()
  })
})
