// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeycodeEntryModal } from '../useKeycodeEntryModal'
import type { KeycodeEntryModalAdapter, KeycodeEntryModalOptions } from '../useKeycodeEntryModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => `KC_${code}`,
  deserialize: (val: string) => Number(val.replace('KC_', '')),
  keycodeLabel: (qmkId: string) => qmkId,
  codeToLabel: (code: number) => `KC_${code}`,
  keycodeTooltip: (qmkId: string) => qmkId,
  isResetKeycode: () => false,
  isModifiableKeycode: () => false,
  extractModMask: () => 0,
  extractBasicKey: (code: number) => code & 0xff,
  buildModMaskKeycode: (mask: number, key: number) => (mask << 8) | key,
  isMask: () => false,
  resolve: () => 0,
  isLMKeycode: () => false,
  findOuterKeycode: () => undefined,
  findInnerKeycode: () => undefined,
}))

interface TestEntry {
  fieldA: number
  fieldB: number
}

const testAdapter: KeycodeEntryModalAdapter<TestEntry> = {
  testIdPrefix: 'test',
  favoriteType: 'combo',
  titleKey: 'test.title',
  titleParams: (index) => ({ index }),
  keycodeFields: [
    { key: 'fieldA', labelKey: 'test.fieldA' },
    { key: 'fieldB', labelKey: 'test.fieldB' },
  ],
  createEmptyEntry: () => ({ fieldA: 0, fieldB: 0 }),
  isConfigured: (e) => e.fieldA !== 0 || e.fieldB !== 0,
  guardCodes: (e) => [e.fieldA, e.fieldB],
  closeOnSave: true,
}

const noCloseSaveAdapter: KeycodeEntryModalAdapter<TestEntry> = {
  ...testAdapter,
  closeOnSave: false,
  guardCodes: () => [],
}

function makeOptions(overrides?: Partial<KeycodeEntryModalOptions<TestEntry>>): KeycodeEntryModalOptions<TestEntry> {
  return {
    entry: { fieldA: 10, fieldB: 20 },
    index: 0,
    onSave: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    ...overrides,
  }
}

describe('useKeycodeEntryModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.vialAPI = {
      ...window.vialAPI,
      favoriteStoreList: vi.fn().mockResolvedValue({ success: true, entries: [] }),
    } as unknown as typeof window.vialAPI
  })

  it('initializes editedEntry from options.entry', () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(testAdapter, opts))
    expect(result.current.editedEntry).toEqual({ fieldA: 10, fieldB: 20 })
  })

  it('hasChanges is false initially', () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(testAdapter, opts))
    expect(result.current.hasChanges).toBe(false)
  })

  it('hasChanges is true after updateField', () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(testAdapter, opts))
    act(() => { result.current.updateField('fieldA', 99) })
    expect(result.current.hasChanges).toBe(true)
    expect(result.current.editedEntry?.fieldA).toBe(99)
  })

  it('clearAction resets entry to empty', () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(testAdapter, opts))
    // First trigger arms, second executes
    act(() => { result.current.clearAction.trigger() })
    expect(result.current.clearAction.confirming).toBe(true)
    act(() => { result.current.clearAction.trigger() })
    expect(result.current.editedEntry).toEqual({ fieldA: 0, fieldB: 0 })
  })

  it('revertAction restores original entry', () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(testAdapter, opts))
    act(() => { result.current.updateField('fieldA', 99) })
    expect(result.current.editedEntry?.fieldA).toBe(99)
    act(() => { result.current.revertAction.trigger() })
    act(() => { result.current.revertAction.trigger() })
    expect(result.current.editedEntry).toEqual({ fieldA: 10, fieldB: 20 })
  })

  it('handleEntrySave calls onSave and handleClose when closeOnSave=true', async () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(testAdapter, opts))
    await act(async () => { await result.current.handleEntrySave() })
    expect(opts.onSave).toHaveBeenCalledWith(0, { fieldA: 10, fieldB: 20 })
    expect(opts.onClose).toHaveBeenCalled()
  })

  it('handleEntrySave does NOT close when closeOnSave=false', async () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(noCloseSaveAdapter, opts))
    await act(async () => { await result.current.handleEntrySave() })
    expect(opts.onSave).toHaveBeenCalled()
    expect(opts.onClose).not.toHaveBeenCalled()
  })

  it('handleClose calls onClose', () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(testAdapter, opts))
    act(() => { result.current.handleClose() })
    expect(opts.onClose).toHaveBeenCalled()
  })

  it('normalizeEntry is applied on updateField', () => {
    const normalizedAdapter: KeycodeEntryModalAdapter<TestEntry> = {
      ...testAdapter,
      normalizeEntry: (e) => e.fieldA === 0 ? { ...e, fieldB: -1 } : e,
    }
    const opts = makeOptions({ entry: { fieldA: 5, fieldB: 20 } })
    const { result } = renderHook(() => useKeycodeEntryModal(normalizedAdapter, opts))
    act(() => { result.current.updateField('fieldA', 0) })
    expect(result.current.editedEntry?.fieldB).toBe(-1)
  })

  it('showFavorites respects adapter.showFavorites', () => {
    const dummyAdapter: KeycodeEntryModalAdapter<TestEntry> = {
      ...testAdapter,
      showFavorites: ({ isDummy }) => !isDummy,
    }
    const opts = makeOptions({ isDummy: true })
    const { result } = renderHook(() => useKeycodeEntryModal(dummyAdapter, opts))
    expect(result.current.showFavorites).toBe(false)
  })

  it('modalWidth supports function form', () => {
    const widthAdapter: KeycodeEntryModalAdapter<TestEntry> = {
      ...testAdapter,
      modalWidth: ({ isDummy }) => isDummy ? 'w-[900px]' : 'w-[1050px]',
    }
    const opts = makeOptions({ isDummy: true })
    const { result } = renderHook(() => useKeycodeEntryModal(widthAdapter, opts))
    expect(result.current.modalWidth).toBe('w-[900px]')
  })

  it('handleFieldSelect sets selectedField and stores preEditValue', () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(testAdapter, opts))
    act(() => { result.current.handleFieldSelect('fieldA') })
    expect(result.current.selectedField).toBe('fieldA')
    expect(result.current.preEditValueRef.current).toBe(10)
  })

  it('handlePickerClose restores pre-edit value', () => {
    const opts = makeOptions()
    const { result } = renderHook(() => useKeycodeEntryModal(testAdapter, opts))
    act(() => { result.current.handleFieldSelect('fieldA') })
    act(() => { result.current.updateField('fieldA', 99) })
    expect(result.current.editedEntry?.fieldA).toBe(99)
    act(() => { result.current.handlePickerClose() })
    expect(result.current.editedEntry?.fieldA).toBe(10)
    expect(result.current.selectedField).toBeNull()
  })
})
