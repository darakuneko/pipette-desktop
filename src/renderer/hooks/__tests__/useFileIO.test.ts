// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useFileIO, type UseFileIOOptions } from '../useFileIO'
import { isVilFile } from '../../../shared/vil-file'
import {
  VALID_VIL,
  VALID_VIL_JSON,
  MISMATCHED_UID_VIL_JSON,
  MODIFIED_VIL,
} from './fixtures/valid-vil'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockSaveLayout = vi.fn()
const mockLoadLayout = vi.fn()
const mockExportKeymapC = vi.fn()
const mockExportPdf = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    saveLayout: mockSaveLayout,
    loadLayout: mockLoadLayout,
    exportKeymapC: mockExportKeymapC,
    exportPdf: mockExportPdf,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  vi.restoreAllMocks()
})

function createHookOptions(overrides?: Partial<UseFileIOOptions>) {
  return {
    deviceUid: VALID_VIL.uid,
    deviceName: 'Test Keyboard',
    serialize: vi.fn(() => VALID_VIL),
    applyVilFile: vi.fn(async () => {}),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Save Layout
// ---------------------------------------------------------------------------

describe('useFileIO – saveLayout', () => {
  it('serializes and sends JSON via vialAPI on save (native format without serializeVialGui)', async () => {
    mockSaveLayout.mockResolvedValueOnce({ success: true, filePath: '/tmp/keyboard.vil' })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveLayout()
    })

    expect(ok).toBe(true)
    expect(opts.serialize).toHaveBeenCalledOnce()
    expect(mockSaveLayout).toHaveBeenCalledWith(
      JSON.stringify(VALID_VIL, null, 2),
      'Test Keyboard',
    )
  })

  it('uses serializeVialGui when provided', async () => {
    mockSaveLayout.mockResolvedValueOnce({ success: true, filePath: '/tmp/keyboard.vil' })
    const vialGuiJson = '{"version":1,"layout":[]}'
    const opts = createHookOptions({
      serializeVialGui: vi.fn(() => vialGuiJson),
    })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveLayout()
    })

    expect(ok).toBe(true)
    expect(opts.serializeVialGui).toHaveBeenCalledOnce()
    expect(opts.serialize).not.toHaveBeenCalled()
    expect(mockSaveLayout).toHaveBeenCalledWith(vialGuiJson, 'Test Keyboard')
  })

  it('returns false and shows no error when user cancels dialog', async () => {
    mockSaveLayout.mockResolvedValueOnce({ success: false, error: 'cancelled' })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('returns false and sets error on IPC failure', async () => {
    mockSaveLayout.mockResolvedValueOnce({ success: false, error: 'write error' })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.saveFailed')
  })

  it('sets error on IPC exception', async () => {
    mockSaveLayout.mockRejectedValueOnce(new Error('IPC crash'))
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.saveFailed')
  })

  it('sets error when serialize throws', async () => {
    const opts = createHookOptions({
      serialize: vi.fn(() => {
        throw new Error('serialization failure')
      }),
    })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.saveFailed')
    expect(mockSaveLayout).not.toHaveBeenCalled()
  })

  it('manages saving flag during operation', async () => {
    let resolveIpc!: (v: unknown) => void
    mockSaveLayout.mockReturnValueOnce(
      new Promise((r) => {
        resolveIpc = r
      }),
    )
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    expect(result.current.saving).toBe(false)

    let promise: Promise<boolean>
    act(() => {
      promise = result.current.saveLayout()
    })
    expect(result.current.saving).toBe(true)

    await act(async () => {
      resolveIpc({ success: true })
      await promise!
    })
    expect(result.current.saving).toBe(false)
  })

  it('clears previous error on new save', async () => {
    // First call fails
    mockSaveLayout.mockResolvedValueOnce({ success: false, error: 'write error' })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    await act(async () => {
      await result.current.saveLayout()
    })
    expect(result.current.error).toBe('error.saveFailed')

    // Second call succeeds — error should clear
    mockSaveLayout.mockResolvedValueOnce({ success: true })
    await act(async () => {
      await result.current.saveLayout()
    })
    expect(result.current.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Load Layout
// ---------------------------------------------------------------------------

describe('useFileIO – loadLayout', () => {
  it('loads valid VilFile and calls applyVilFile', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: VALID_VIL_JSON,
      filePath: '/tmp/keyboard.vil',
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(true)
    expect(opts.applyVilFile).toHaveBeenCalledOnce()
    expect(opts.applyVilFile).toHaveBeenCalledWith(VALID_VIL)
  })

  it('returns false and shows no error when user cancels dialog', async () => {
    mockLoadLayout.mockResolvedValueOnce({ success: false, error: 'cancelled' })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBeNull()
    expect(opts.applyVilFile).not.toHaveBeenCalled()
  })

  it('returns false and sets error on IPC failure', async () => {
    mockLoadLayout.mockResolvedValueOnce({ success: false, error: 'read error' })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.loadFailed')
  })

  it('sets error on IPC exception', async () => {
    mockLoadLayout.mockRejectedValueOnce(new Error('IPC crash'))
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.loadFailed')
  })

  it('sets error when applyVilFile rejects', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: VALID_VIL_JSON,
    })
    const opts = createHookOptions({
      applyVilFile: vi.fn(async () => {
        throw new Error('device communication failure')
      }),
    })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.loadFailed')
  })

  it('sets error when IPC returns success but data is undefined', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: undefined,
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.loadFailed')
    expect(opts.applyVilFile).not.toHaveBeenCalled()
  })

  it('sets error on invalid JSON data', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: 'this is not json {{{',
      filePath: '/tmp/bad.vil',
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.loadFailed')
    expect(opts.applyVilFile).not.toHaveBeenCalled()
  })

  it('sets error when JSON does not match VilFile schema', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: JSON.stringify({ foo: 'bar', baz: 42 }),
      filePath: '/tmp/random.vil',
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.loadFailed')
    expect(opts.applyVilFile).not.toHaveBeenCalled()
  })

  it('loads vial-gui format .vil files and converts to Pipette format', async () => {
    const vialGuiVil = readFileSync(
      join(__dirname, 'fixtures', 'bento-max.vil'),
      'utf-8',
    )

    // Verify it's valid JSON and recognized as vial-gui format
    const parsed = JSON.parse(vialGuiVil)
    expect(parsed).toBeDefined()
    expect(isVilFile(parsed)).toBe(false)

    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: vialGuiVil,
      filePath: '/tmp/bento max.vil',
    })
    // Use matching UID so no confirm dialog needed
    const vialGuiUid = '0xFBD8239B8804FAEA'
    const opts = createHookOptions({ deviceUid: vialGuiUid })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(true)
    expect(opts.applyVilFile).toHaveBeenCalledOnce()
    const applied = vi.mocked(opts.applyVilFile).mock.calls[0][0]
    // Should have converted to Pipette VilFile format
    expect(applied.uid).toBe(vialGuiUid)
    expect(typeof applied.keymap).toBe('object')
    expect(applied.keymap['0,0,0']).toBeDefined()
    expect(applied.layoutOptions).toBe(0)
    expect(Array.isArray(applied.tapDance)).toBe(true)
    expect(Array.isArray(applied.combo)).toBe(true)
    expect(Array.isArray(applied.keyOverride)).toBe(true)
    expect(Array.isArray(applied.altRepeatKey)).toBe(true)
  })

  it('rejects empty JSON object', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: '{}',
      filePath: '/tmp/empty.vil',
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.loadFailed')
  })

  it('rejects JSON array', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: '[1, 2, 3]',
      filePath: '/tmp/array.vil',
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.loadFailed')
  })

  it('rejects binary/non-text content', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: '\x00\x01\x02\x03\xff',
      filePath: '/tmp/binary.bin',
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.loadFailed')
  })

  it('manages loading flag during operation', async () => {
    let resolveIpc!: (v: unknown) => void
    mockLoadLayout.mockReturnValueOnce(
      new Promise((r) => {
        resolveIpc = r
      }),
    )
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    expect(result.current.loading).toBe(false)

    let promise: Promise<boolean>
    act(() => {
      promise = result.current.loadLayout()
    })
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveIpc({ success: true, data: VALID_VIL_JSON })
      await promise!
    })
    expect(result.current.loading).toBe(false)
  })

  it('clears previous error on new load', async () => {
    // First call fails
    mockLoadLayout.mockResolvedValueOnce({ success: false, error: 'read error' })
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    await act(async () => {
      await result.current.loadLayout()
    })
    expect(result.current.error).toBe('error.loadFailed')

    // Second call succeeds — error should clear
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: VALID_VIL_JSON,
    })
    await act(async () => {
      await result.current.loadLayout()
    })
    expect(result.current.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// UID mismatch
// ---------------------------------------------------------------------------

describe('useFileIO – UID mismatch', () => {
  it('loads without confirmation when UIDs match', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: VALID_VIL_JSON,
    })
    const confirmSpy = vi.spyOn(window, 'confirm')
    const opts = createHookOptions({ deviceUid: VALID_VIL.uid })
    const { result } = renderHook(() => useFileIO(opts))

    await act(async () => {
      await result.current.loadLayout()
    })

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(opts.applyVilFile).toHaveBeenCalledOnce()
  })

  it('loads without confirmation when device UID is 0x0 (example UID)', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: MISMATCHED_UID_VIL_JSON,
    })
    const confirmSpy = vi.spyOn(window, 'confirm')
    const opts = createHookOptions({ deviceUid: '0x0' })
    const { result } = renderHook(() => useFileIO(opts))

    await act(async () => {
      await result.current.loadLayout()
    })

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(opts.applyVilFile).toHaveBeenCalledOnce()
  })

  it('shows confirmation when UIDs differ', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: MISMATCHED_UID_VIL_JSON,
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const opts = createHookOptions({ deviceUid: VALID_VIL.uid })
    const { result } = renderHook(() => useFileIO(opts))

    await act(async () => {
      await result.current.loadLayout()
    })

    expect(confirmSpy).toHaveBeenCalledWith('fileIO.uidMismatchConfirm')
    expect(opts.applyVilFile).toHaveBeenCalledOnce()
  })

  it('treats uppercase and lowercase UIDs as matching', async () => {
    // Device reports lowercase hex, file has uppercase — should match
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: VALID_VIL_JSON, // uid: '0xFBF3B07838D7076A'
    })
    const confirmSpy = vi.spyOn(window, 'confirm')
    const opts = createHookOptions({ deviceUid: '0xfbf3b07838d7076a' })
    const { result } = renderHook(() => useFileIO(opts))

    await act(async () => {
      await result.current.loadLayout()
    })

    expect(confirmSpy).not.toHaveBeenCalled()
    expect(opts.applyVilFile).toHaveBeenCalledOnce()
  })

  it('aborts load when user rejects UID mismatch confirmation', async () => {
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: MISMATCHED_UID_VIL_JSON,
    })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const opts = createHookOptions({ deviceUid: VALID_VIL.uid })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout()
    })

    expect(ok).toBe(false)
    expect(opts.applyVilFile).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Save → Load roundtrip
// ---------------------------------------------------------------------------

describe('useFileIO – roundtrip', () => {
  it('save then load preserves data', async () => {
    const opts = createHookOptions()

    // Save: capture the JSON string sent via vialAPI
    mockSaveLayout.mockResolvedValueOnce({ success: true, filePath: '/tmp/test.vil' })
    const { result } = renderHook(() => useFileIO(opts))

    await act(async () => {
      await result.current.saveLayout()
    })

    const savedJson = mockSaveLayout.mock.calls[0][0] as string

    // Load: feed the saved JSON back
    mockLoadLayout.mockResolvedValueOnce({
      success: true,
      data: savedJson,
    })

    await act(async () => {
      await result.current.loadLayout()
    })

    expect(opts.applyVilFile).toHaveBeenCalledOnce()
    const applied = vi.mocked(opts.applyVilFile).mock.calls[0][0]
    expect(applied).toEqual(VALID_VIL)
  })

  it('save with modified keycodes then load reflects changes', async () => {
    const opts = createHookOptions({
      serialize: vi.fn(() => MODIFIED_VIL),
    })

    mockSaveLayout.mockResolvedValueOnce({ success: true })
    const { result } = renderHook(() => useFileIO(opts))

    await act(async () => {
      await result.current.saveLayout()
    })

    const savedJson = mockSaveLayout.mock.calls[0][0] as string

    // Load back
    mockLoadLayout.mockResolvedValueOnce({ success: true, data: savedJson })

    await act(async () => {
      await result.current.loadLayout()
    })

    const applied = vi.mocked(opts.applyVilFile).mock.calls[0][0]
    // Verify the changed keycodes are present
    expect(applied.keymap['0,0,0']).toBe(0x04) // KC_A
    expect(applied.keymap['0,0,1']).toBe(0x05) // KC_B
    // Original unchanged keys should remain
    expect(applied.keymap['0,1,5']).toBe(0x1e) // KC_1
  })
})

// ---------------------------------------------------------------------------
// Export keymap.c
// ---------------------------------------------------------------------------

describe('useFileIO – exportKeymapC', () => {
  const keymapCContent = '/* generated keymap.c */'

  it('calls vialAPI.exportKeymapC with generated content', async () => {
    mockExportKeymapC.mockResolvedValueOnce({ success: true, filePath: '/tmp/keymap.c' })
    const opts = createHookOptions({ keymapCGenerator: () => keymapCContent })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportKeymapC()
    })

    expect(ok).toBe(true)
    expect(mockExportKeymapC).toHaveBeenCalledWith(keymapCContent, 'Test Keyboard')
  })

  it('returns false and shows no error when user cancels dialog', async () => {
    mockExportKeymapC.mockResolvedValueOnce({ success: false, error: 'cancelled' })
    const opts = createHookOptions({ keymapCGenerator: () => keymapCContent })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportKeymapC()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('returns false and sets error on IPC failure', async () => {
    mockExportKeymapC.mockResolvedValueOnce({ success: false, error: 'write error' })
    const opts = createHookOptions({ keymapCGenerator: () => keymapCContent })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportKeymapC()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.exportKeymapCFailed')
  })

  it('sets error on IPC exception', async () => {
    mockExportKeymapC.mockRejectedValueOnce(new Error('IPC crash'))
    const opts = createHookOptions({ keymapCGenerator: () => keymapCContent })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportKeymapC()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.exportKeymapCFailed')
  })

  it('returns false when no keymapCGenerator provided', async () => {
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportKeymapC()
    })

    expect(ok).toBe(false)
    expect(mockExportKeymapC).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Export PDF
// ---------------------------------------------------------------------------

describe('useFileIO – exportPdf', () => {
  const pdfBase64 = 'JVBER...' // mock base64

  it('calls vialAPI.exportPdf with generated base64', async () => {
    mockExportPdf.mockResolvedValueOnce({ success: true, filePath: '/tmp/keymap.pdf' })
    const opts = createHookOptions({ pdfGenerator: () => pdfBase64 })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportPdf()
    })

    expect(ok).toBe(true)
    expect(mockExportPdf).toHaveBeenCalledWith(pdfBase64, 'Test Keyboard')
  })

  it('returns false and shows no error when user cancels dialog', async () => {
    mockExportPdf.mockResolvedValueOnce({ success: false, error: 'cancelled' })
    const opts = createHookOptions({ pdfGenerator: () => pdfBase64 })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportPdf()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('returns false and sets error on IPC failure', async () => {
    mockExportPdf.mockResolvedValueOnce({ success: false, error: 'write error' })
    const opts = createHookOptions({ pdfGenerator: () => pdfBase64 })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportPdf()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.exportPdfFailed')
  })

  it('sets error on IPC exception', async () => {
    mockExportPdf.mockRejectedValueOnce(new Error('IPC crash'))
    const opts = createHookOptions({ pdfGenerator: () => pdfBase64 })
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportPdf()
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('error.exportPdfFailed')
  })

  it('returns false when no pdfGenerator provided', async () => {
    const opts = createHookOptions()
    const { result } = renderHook(() => useFileIO(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.exportPdf()
    })

    expect(ok).toBe(false)
    expect(mockExportPdf).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// VilFile with missing required fields
// ---------------------------------------------------------------------------

describe('useFileIO – partial VilFile rejection', () => {
  const requiredFields = [
    'uid',
    'keymap',
    'encoderLayout',
    'macros',
    'layoutOptions',
    'tapDance',
    'combo',
    'keyOverride',
    'altRepeatKey',
    'qmkSettings',
  ]

  for (const field of requiredFields) {
    it(`rejects VilFile missing "${field}"`, async () => {
      const incomplete = { ...VALID_VIL }
      delete (incomplete as Record<string, unknown>)[field]
      mockLoadLayout.mockResolvedValueOnce({
        success: true,
        data: JSON.stringify(incomplete),
      })
      const opts = createHookOptions()
      const { result } = renderHook(() => useFileIO(opts))

      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.loadLayout()
      })

      expect(ok).toBe(false)
      expect(result.current.error).toBe('error.loadFailed')
      expect(opts.applyVilFile).not.toHaveBeenCalled()
    })
  }
})
