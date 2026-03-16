// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { KeycodeEntryModalShell } from '../KeycodeEntryModalShell'
import type { KeycodeEntryModalAdapter, KeycodeEntryModalReturn } from '../../../hooks/useKeycodeEntryModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'test.title') return `Test - ${opts?.index}`
      if (key === 'test.fieldA') return 'Field A'
      if (key === 'test.fieldB') return 'Field B'
      const map: Record<string, string> = {
        'common.save': 'Save',
        'common.clear': 'Clear',
        'common.revert': 'Revert',
        'common.confirmClear': 'Confirm Clear',
        'common.confirmRevert': 'Confirm Revert',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
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

vi.mock('../../keycodes/TabbedKeycodes', () => ({
  TabbedKeycodes: () => <div data-testid="tabbed-keycodes" />,
}))

vi.mock('../FavoriteStoreContent', () => ({
  FavoriteStoreContent: () => <div data-testid="favorite-store-content" />,
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

function createMockHook(overrides?: Partial<KeycodeEntryModalReturn<TestEntry>>): KeycodeEntryModalReturn<TestEntry> {
  return {
    editedEntry: { fieldA: 10, fieldB: 20 },
    setEditedEntry: vi.fn(),
    selectedField: null,
    popoverState: null,
    hasChanges: false,
    headerTitle: 'test.title',
    handleClose: vi.fn(),
    handleEntrySave: vi.fn(),
    updateField: vi.fn(),
    handleFieldSelect: vi.fn(),
    handleFieldMaskPartClick: vi.fn(),
    handleFieldDoubleClick: vi.fn(),
    handlePickerClose: vi.fn(),
    closePopover: vi.fn(),
    confirmPopover: vi.fn(),
    handlePopoverKeycodeSelect: vi.fn(),
    handlePopoverRawKeycodeSelect: vi.fn(),
    clearAction: { confirming: false, trigger: vi.fn(), reset: vi.fn() },
    revertAction: { confirming: false, trigger: vi.fn(), reset: vi.fn() },
    maskedSelection: {
      handleKeycodeSelect: vi.fn(),
      selectAndCommit: vi.fn(),
      pickerSelect: vi.fn(),
      pickerDoubleClick: vi.fn(),
      maskOnly: false,
      lmMode: false,
      activeMask: null,
      editingPart: null,
      clearMask: vi.fn(),
      confirm: vi.fn(),
      setEditingPart: vi.fn(),
      enterMaskMode: vi.fn(),
    },
    tabContentOverride: undefined,
    favStore: {
      entries: [],
      error: null,
      saving: false,
      loading: false,
      exporting: false,
      importing: false,
      importResult: null,
      showModal: false,
      refreshEntries: vi.fn(),
      openModal: vi.fn(),
      closeModal: vi.fn(),
      saveFavorite: vi.fn(),
      loadFavorite: vi.fn(),
      renameEntry: vi.fn(),
      deleteEntry: vi.fn(),
      exportFavorites: vi.fn(),
      exportEntry: vi.fn(),
      importFavorites: vi.fn(),
    },
    preEditValueRef: { current: 0 },
    showFavorites: true,
    modalWidth: 'w-[1050px]',
    ...overrides,
  }
}

describe('KeycodeEntryModalShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders header with title and close button', () => {
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={createMockHook()} index={0} />,
    )
    expect(screen.getByText('Test - 0')).toBeInTheDocument()
    expect(screen.getByTestId('test-modal-close')).toBeInTheDocument()
  })

  it('renders keycode fields', () => {
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={createMockHook()} index={0} />,
    )
    expect(screen.getAllByTestId('keycode-field')).toHaveLength(2)
    expect(screen.getByText('Field A')).toBeInTheDocument()
    expect(screen.getByText('Field B')).toBeInTheDocument()
  })

  it('renders favorites panel', () => {
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={createMockHook()} index={0} />,
    )
    expect(screen.getByTestId('test-favorites-panel')).toBeInTheDocument()
    expect(screen.getByTestId('favorite-store-content')).toBeInTheDocument()
  })

  it('renders Save, Clear, Revert buttons', () => {
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={createMockHook()} index={0} />,
    )
    expect(screen.getByTestId('test-modal-save')).toBeInTheDocument()
    expect(screen.getByTestId('test-modal-clear')).toBeInTheDocument()
    expect(screen.getByTestId('test-modal-revert')).toBeInTheDocument()
  })

  it('Save button is disabled when no changes', () => {
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={createMockHook()} index={0} />,
    )
    expect(screen.getByTestId('test-modal-save')).toBeDisabled()
  })

  it('Save button is enabled when hasChanges', () => {
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={createMockHook({ hasChanges: true })} index={0} />,
    )
    expect(screen.getByTestId('test-modal-save')).toBeEnabled()
  })

  it('calls handleClose when backdrop is clicked', () => {
    const hook = createMockHook()
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={hook} index={0} />,
    )
    fireEvent.click(screen.getByTestId('test-modal-backdrop'))
    expect(hook.handleClose).toHaveBeenCalledTimes(1)
  })

  it('does not call handleClose when modal content is clicked', () => {
    const hook = createMockHook()
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={hook} index={0} />,
    )
    fireEvent.click(screen.getByTestId('test-modal'))
    expect(hook.handleClose).not.toHaveBeenCalled()
  })

  it('renders renderBeforeFields slot', () => {
    render(
      <KeycodeEntryModalShell
        adapter={testAdapter}
        hook={createMockHook()}
        index={0}
        renderBeforeFields={() => <div data-testid="before-slot">Before</div>}
      />,
    )
    expect(screen.getByTestId('before-slot')).toBeInTheDocument()
  })

  it('renders renderAfterFields slot', () => {
    render(
      <KeycodeEntryModalShell
        adapter={testAdapter}
        hook={createMockHook()}
        index={0}
        renderAfterFields={() => <div data-testid="after-slot">After</div>}
      />,
    )
    expect(screen.getByTestId('after-slot')).toBeInTheDocument()
  })

  it('hides favorites panel when picker is open', () => {
    render(
      <KeycodeEntryModalShell
        adapter={testAdapter}
        hook={createMockHook({ selectedField: 'fieldA' })}
        index={0}
      />,
    )
    expect(screen.getByTestId('test-favorites-panel').className).toContain('hidden')
  })

  it('shows TabbedKeycodes when a field is selected', () => {
    render(
      <KeycodeEntryModalShell
        adapter={testAdapter}
        hook={createMockHook({ selectedField: 'fieldA' })}
        index={0}
      />,
    )
    expect(screen.getByTestId('tabbed-keycodes')).toBeInTheDocument()
  })

  it('hides favorites panel when showFavorites is false', () => {
    render(
      <KeycodeEntryModalShell
        adapter={testAdapter}
        hook={createMockHook({ showFavorites: false })}
        index={0}
      />,
    )
    expect(screen.queryByTestId('test-favorites-panel')).not.toBeInTheDocument()
  })

  it('calls handleEntrySave when Save button is clicked', () => {
    const hook = createMockHook({ hasChanges: true })
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={hook} index={0} />,
    )
    fireEvent.click(screen.getByTestId('test-modal-save'))
    expect(hook.handleEntrySave).toHaveBeenCalledTimes(1)
  })

  it('calls clearAction.trigger on Clear click', () => {
    const hook = createMockHook()
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={hook} index={0} />,
    )
    fireEvent.click(screen.getByTestId('test-modal-clear'))
    expect(hook.clearAction.trigger).toHaveBeenCalledTimes(1)
  })

  it('calls revertAction.trigger on Revert click', () => {
    const hook = createMockHook()
    render(
      <KeycodeEntryModalShell adapter={testAdapter} hook={hook} index={0} />,
    )
    fireEvent.click(screen.getByTestId('test-modal-revert'))
    expect(hook.revertAction.trigger).toHaveBeenCalledTimes(1)
  })

  it('hides header and footer when picker is open', () => {
    render(
      <KeycodeEntryModalShell
        adapter={testAdapter}
        hook={createMockHook({ selectedField: 'fieldA' })}
        index={0}
      />,
    )
    expect(screen.queryByText('Test - 0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('test-modal-save')).not.toBeInTheDocument()
  })
})
