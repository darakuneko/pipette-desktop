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
})
